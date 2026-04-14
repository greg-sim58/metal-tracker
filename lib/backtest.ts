// Backtesting engine for the gold sentiment model (v12)
//
// Replays the signal engine against historical COT data with a
// production-grade trade execution, risk management, readiness-driven
// position sizing, pre-trade quality filtering, market regime
// detection, multi-timeframe trade confirmation layer, trade
// readiness scoring system, and signal invalidation engine:
//
//   Entry pipeline:
//     SIGNAL → QUALITY FILTER → REGIME FILTER → MTF CONFIRMATION → INVALIDATION CHECK → READINESS SCORE → READINESS SIZING → EXECUTION
//
//     1. Signal: CONFIRMATION stage + |score| >= ENTRY_THRESHOLD (60)
//        Optional SMA trend filter (LONG only above MA, SHORT below)
//     2. Trade Quality Gate (all 4 conditions must pass):
//       A. Expected Risk-to-Reward >= 2.5 (ATR-based reward vs stop distance)
//       B. Signal confidence >= 70 (strength filter)
//       C. Trade direction aligns with rolling price trend
//       D. Volatility within acceptable range (ATR z-score filter)
//     3. Market Regime Gate (all 3 conditions must pass):
//       A. Sentiment trend is TRENDING (directional consistency >= 75%)
//       B. ATR volatility within two-sided band (not spiking or collapsing)
//       C. Open interest above 20th percentile (liquidity proxy)
//     4. Multi-Timeframe Confirmation Layer:
//       - HTF (weekly sentiment): directional bias must align with signal direction
//       - MTF (daily structure): trend structure / breakout / MA alignment checks
//       - LTF (4h trigger): intraday entry trigger checks
//       - CONFIRMED only when all active tiers agree
//       - If intraday data is unavailable, degrades gracefully to HTF + MTF
//       - Expiry after CONFIRM_EXPIRY_BARS (3) without confirmation → REJECTED
//     5. Signal Invalidation Engine (kills bad signals early):
//       - Price: LONG invalidated by lower low, SHORT by higher high
//       - Momentum: delta reversal against signal direction
//       - HTF Shift: weekly sentiment flips against direction
//       - Time: unconfirmed beyond INVALIDATION_MAX_BARS (5)
//       - Readiness Decay: score below threshold for sustained period
//       - Priority: HTF_SHIFT > PRICE > MOMENTUM > READINESS > TIME
//     6. Single position at a time (no overlapping trades)
//
//   Position Sizing (readiness-driven):
//     - Primary: readiness score determines risk tier and risk percent
//       NO_TRADE (<40): 0% risk → skip entry
//       PROBE (40–59): 0.25%–0.5% risk
//       STANDARD (60–79): 0.75%–1.0% risk
//       HIGH_CONVICTION (80–100): 1.25%–1.5% risk (capped)
//     - Smooth interpolation within tier risk bands
//     - ATR-based conversion from risk% to position size fraction
//     - Secondary: Kelly Criterion + ATR volatility scaling as fallback
//     - Clamped to [5%, 25%] of equity
//     - Equity updated dynamically after each trade close
//
//   Risk Management (checked every bar, priority order):
//     1. Hard stop loss: -3% from entry → immediate exit
//     2. Trailing stop: activates at +3%, trails 2% below peak
//     3. Break-even rule: at +2%, stop upgrades to entry price
//
//   Signal Exits (checked after risk, only after MIN_HOLD_WEEKS):
//     4. Strong opposite signal: score crosses -ENTRY_THRESHOLD
//        AND delta confirms (delta < 0 for LONG, > 0 for SHORT)
//     5. Hysteresis decay: score falls to EXIT_THRESHOLD (25)
//        Direction-aware — NOT symmetric / absolute-value based
//     6. Max holding period safety cap (6 weeks)
//
//   Price Handling:
//     - Weekly high/low synthesized from daily closes within each
//       COT week for stop-level checks
//     - Execution on bar close (best available weekly proxy)
//
//   Tracking:
//     - MFE (max favorable excursion) per trade
//     - MAE (max adverse excursion) per trade
//     - Peak price for trailing stop management
//     - Position size, capital allocated, and P&L contribution per trade
//     - Trade quality score and gate approval status
//     - Market regime type and score at entry
//     - Trade readiness score, level, and per-component breakdown
//
//   Constraints:
//     - No same-bar exits (min hold = 2 weeks)
//     - Look-ahead-free: each week uses only data available at that time
//     - Deterministic: same input always produces same output

import type { CotReport } from "@/lib/cot";
import {
  calculateAcceleration,
  computePercentileMetrics,
  fetchCotHistory,
  getWeeklyDeltas,
  type CotHistoryPoint,
} from "@/lib/cotHistory";
import { classifyExecution, type SignalStage } from "@/lib/execution";
import {
  generateSignal,
  type OpenInterestTrend,
  type PriceTrend,
  type Signal,
  type SignalDirection,
  type SignalInput,
} from "@/lib/signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Daily close price point.
 */
export interface PricePoint {
  date: string;   // YYYY-MM-DD
  close: number;
}

/**
 * Weekly price bar derived from daily closes within a COT reporting week.
 *
 * Since our data source (FreeGoldAPI) provides daily close prices only,
 * high/low are the max/min daily closes within the week — a reasonable
 * proxy for true intra-day extremes on weekly bars.
 */
export interface WeeklyBar {
  date: string;    // COT report date (anchor)
  open: number;    // first daily close in the week
  high: number;    // highest daily close in the week
  low: number;     // lowest daily close in the week
  close: number;   // last daily close in the week (nearest to COT date)
}

/**
 * OHLC bar for any timeframe (4h, daily, etc.).
 */
export interface OhlcBar {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Reasons why an open trade was closed.
 */
export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "hysteresis"
  | "strong_opposite"
  | "max_hold"
  | "end_of_data";

/**
 * Position sizing tier classification based on trade readiness score.
 *
 *   NO_TRADE        — readiness < 40, risk = 0% (do not trade)
 *   PROBE           — readiness 40–59, risk 0.25%–0.5% (small exploratory)
 *   STANDARD        — readiness 60–79, risk 0.75%–1.0% (normal sizing)
 *   HIGH_CONVICTION — readiness 80–100, risk 1.25%–1.5% (maximum sizing, capped)
 */
export type SizingTier =
  | "NO_TRADE"
  | "PROBE"
  | "STANDARD"
  | "HIGH_CONVICTION";

/**
 * Result of the readiness-based position sizing engine.
 *
 * Dynamically adjusts trade size based on readiness score (primary),
 * risk constraints (strict caps), and market conditions (regime awareness).
 */
export interface ReadinessPositionSizingResult {
  /** Position size as fraction of equity (0–MAX_POSITION_SIZE). */
  positionSize: number;
  /** Risk percent allocated to this trade (0–1.5%). */
  riskPercent: number;
  /** Capital allocated to this trade (equity * positionSize). */
  capitalAllocated: number;
  /** Sizing tier classification based on readiness score. */
  sizingTier: SizingTier;
  /** Human-readable explanation of sizing decision. */
  reasoning: string;
}

/**
 * Signal invalidation type, ordered by severity (highest first).
 *
 *   HTF_SHIFT  — weekly sentiment bias flipped against signal direction
 *   PRICE      — price made invalidating extreme (higher high / lower low)
 *   MOMENTUM   — sentiment delta reversed strongly against signal
 *   READINESS  — readiness score decayed below threshold without recovery
 *   TIME       — signal remained unconfirmed for too many bars
 */
export type InvalidationType =
  | "HTF_SHIFT"
  | "PRICE"
  | "MOMENTUM"
  | "READINESS"
  | "TIME";

/**
 * Result of the signal invalidation check.
 *
 * When isInvalidated is true, the pending signal should be discarded
 * immediately — the market conditions no longer support the trade idea.
 */
export interface SignalInvalidationResult {
  /** Whether the signal has been invalidated. */
  isInvalidated: boolean;
  /** Human-readable explanation of invalidation. */
  invalidationReason: string;
  /** Primary invalidation type (highest severity trigger). */
  invalidationType: InvalidationType | null;
  /** All invalidation reasons that fired (may be multiple). */
  allReasons: string[];
  /** All invalidation types that fired, ordered by severity. */
  allTypes: InvalidationType[];
}

/**
 * Fully realized trade with entry/exit, risk, and confirmation metadata.
 */
export interface TradeResult {
  entryDate: string;
  exitDate: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  entryScore: number;
  exitScore: number;
  holdingWeeks: number;
  returnPct: number;
  exitReason: ExitReason;
  stage: SignalStage;
  signal: "BUY" | "SELL";
  /** Maximum favorable excursion — best unrealised P&L during the trade (%). */
  mfe: number;
  /** Maximum adverse excursion — worst unrealised P&L during the trade (%). */
  mae: number;
  /** Peak price reached during the trade (for trailing stop context). */
  peakPrice: number;
  /** Position size as fraction of equity at entry (0.05–0.25). */
  positionSize: number;
  /** Capital allocated to this trade (equity * positionSize). */
  capitalAllocated: number;
  /** P&L contribution to portfolio equity (capitalAllocated * returnPct / 100). */
  pnlContribution: number;
  /** Trade quality gate result — confidence score (0–100) at entry. */
  qualityScore: number;
  /** Market regime at entry. */
  regimeType: RegimeType;
  /** Market regime favourability score at entry (0–100). */
  regimeScore: number;
  /** Number of confirmation bars waited before entry (0 = instant, unused). */
  confirmationBarsWaited: number;
  /** Number of confirmation checks that passed on the confirming bar. */
  confirmationChecksPassed: number;
  /** Labels of the confirmation checks that passed. */
  confirmationPassedChecks: string[];
  /** Timeframes aligned at entry confirmation (HTF/MTF/LTF). */
  mtfAlignedTimeframes: string[];
  /** Trade readiness score at entry (0–100). */
  readinessScore: number;
  /** Trade readiness level at entry. */
  readinessLevel: ReadinessLevel;
  /** Per-component readiness sub-scores at entry. */
  readinessBreakdown: ReadinessScoreBreakdown;
  /** Position sizing tier at entry. */
  sizingTier: SizingTier;
  /** Human-readable reasoning for position sizing decision. */
  sizingReasoning: string;
  /** Risk percent allocated to this trade. */
  riskPercent: number;
}

/**
 * Result of the pre-trade quality gate evaluation.
 *
 * A trade is APPROVED only if ALL four conditions are met:
 *   A. Expected Risk-to-Reward >= MIN_EXPECTED_RR
 *   B. Signal confidence >= MIN_SIGNAL_STRENGTH
 *   C. Trade direction aligns with rolling price trend
 *   D. ATR volatility z-score within acceptable range
 *
 * rejectionReasons lists every failing condition (not short-circuited).
 */
export interface TradeQualityResult {
  /** Whether the trade passed all quality filters. */
  isApproved: boolean;
  /** Composite confidence score (0–100) reflecting overall trade quality. */
  confidenceScore: number;
  /** Human-readable reasons for rejection (empty array if approved). */
  rejectionReasons: string[];
}

/**
 * Market regime classification.
 *
 *   TRENDING       — directional sentiment consistency; favourable for trading
 *   RANGING        — mixed/choppy signals; unfavourable
 *   HIGH_VOLATILITY — ATR z-score above upper band; too noisy
 *   LOW_LIQUIDITY  — open interest below historical threshold; thin market
 */
export type RegimeType =
  | "TRENDING"
  | "RANGING"
  | "HIGH_VOLATILITY"
  | "LOW_LIQUIDITY";

/**
 * Result of the market regime detection gate.
 *
 * This is the SECOND gating layer (after TradeQualityResult).
 * A trade is allowed only when isTradable is true, which requires:
 *   - regimeType === "TRENDING"
 *   - Volatility within acceptable band (not extreme high or low)
 *   - Liquidity (open interest) above minimum percentile
 */
export interface RegimeDetectionResult {
  /** Whether the current market regime supports trading. */
  isTradable: boolean;
  /** Classified regime type. */
  regimeType: RegimeType;
  /** Composite regime favourability score (0–100). */
  regimeScore: number;
  /** Human-readable reasons for rejection (empty array if tradable). */
  rejectionReasons: string[];
}

/**
 * Trade confirmation status for the multi-bar confirmation state machine.
 *
 *   PENDING   — signal passed quality + regime gates; awaiting price confirmation
 *   CONFIRMED — price action confirmed signal direction; ready for execution
 *   REJECTED  — confirmation failed or expired without confirming
 */
export type ConfirmationStatus = "PENDING" | "CONFIRMED" | "REJECTED";

/**
 * Result of evaluating confirmation checks on a single bar.
 *
 * At least CONFIRM_MIN_CHECKS of the 4 directional checks must pass
 * for the confirmation to be CONFIRMED. If none pass and the bar count
 * exceeds CONFIRM_EXPIRY_BARS, the status becomes REJECTED.
 */
export interface ConfirmationResult {
  /** Final status after this bar's evaluation. */
  status: ConfirmationStatus;
  /** Number of individual checks that passed (0–4). */
  checksPassed: number;
  /** Human-readable labels of the checks that passed. */
  passedChecks: string[];
  /** Bars waited so far (including this one). */
  barsWaited: number;
  /** Reason for rejection (empty string if not rejected). */
  rejectionReason: string;
}

/**
 * Result of evaluating multi-timeframe confirmation for a pending signal.
 */
export interface MultiTimeframeConfirmationResult {
  /** Whether this bar confirms entry. */
  isConfirmed: boolean;
  /** Final status after evaluating MTF checks and expiry rules. */
  confirmationStatus: ConfirmationStatus;
  /** Timeframes currently aligned with the trade direction. */
  alignedTimeframes: string[];
  /** Missing confirmations required before entry. */
  missingConfirmations: string[];
  /** Human-readable summary of decision logic. */
  reasoning: string;
  /** Whether weekly (HTF) sentiment bias aligns. */
  htfAligned: boolean;
  /** Whether daily (MTF) structure confirms. */
  mtfConfirmed: boolean;
  /** Whether intraday (LTF) trigger fired. */
  ltfTriggered: boolean;
  /** Individual MTF structure checks that passed (for readiness scoring). */
  mtfPassedChecks: string[];
  /** Individual LTF trigger checks that passed (for readiness scoring). */
  ltfPassedChecks: string[];
  /** Whether intraday data was available for LTF evaluation. */
  hasIntradayData: boolean;
}

/**
 * Readiness level classification based on composite readiness score.
 *
 *   LOW             — weak alignment, not ready for execution (0–30)
 *   BUILDING        — partial alignment, developing conditions (31–55)
 *   READY           — sufficient alignment for execution (56–75)
 *   HIGH_CONVICTION — strong multi-layer agreement (76–100)
 */
export type ReadinessLevel =
  | "LOW"
  | "BUILDING"
  | "READY"
  | "HIGH_CONVICTION";

/**
 * Per-component score breakdown for trade readiness transparency.
 */
export interface ReadinessScoreBreakdown {
  /** Signal strength sub-score (0–100). */
  signalStrength: number;
  /** Signal confidence sub-score (0–100). */
  confidence: number;
  /** Market regime quality sub-score (0–100). */
  regimeQuality: number;
  /** Higher timeframe alignment sub-score (0–100). */
  htfAlignment: number;
  /** Medium timeframe structure sub-score (0–100). */
  mtfStructure: number;
  /** Lower timeframe trigger sub-score (0–100). */
  ltfTrigger: number;
}

/**
 * Result of the trade readiness scoring system.
 *
 * Quantifies how "ready" a trade is for execution by aggregating
 * all gating layers into a single weighted 0–100 score.
 *
 * Components (total weight = 100%):
 *   - Signal Strength  (15%) — normalised |signalScore|
 *   - Confidence       (15%) — signal confidence (0–100)
 *   - Regime Quality   (15%) — regime favourability score (0–100)
 *   - HTF Alignment    (20%) — weekly sentiment bias alignment
 *   - MTF Structure    (20%) — daily trend structure confirmation
 *   - LTF Trigger      (15%) — intraday trigger confirmation
 */
export interface TradeReadinessResult {
  /** Composite readiness score (0–100). */
  readinessScore: number;
  /** Classified readiness level based on score thresholds. */
  readinessLevel: ReadinessLevel;
  /** Per-component sub-scores for transparency. */
  scoreBreakdown: ReadinessScoreBreakdown;
  /** Human-readable explanation of the scoring rationale. */
  reasoning: string;
}

/**
 * Aggregate performance statistics for a set of trades.
 */
export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;          // 0-100
  avgReturn: number;        // percent
  avgWin: number;           // percent
  avgLoss: number;          // percent
  maxDrawdown: number;      // percent
  sharpeRatio: number;
  totalReturn: number;      // percent (compounded)
  avgMfe: number;           // average max favorable excursion (%)
  avgMae: number;           // average max adverse excursion (%)
  avgPositionSize: number;  // average position size fraction
  totalPnl: number;         // absolute P&L contribution sum
  finalEquity: number;      // ending equity after all trades
  avgQualityScore: number;  // average trade quality confidence (0–100)
  avgRegimeScore: number;   // average market regime score at entry (0–100)
  avgConfirmationBars: number; // average bars waited for confirmation
  avgMtfTimeframesAligned: number; // average aligned timeframes per trade (0–3)
  avgReadinessScore: number;       // average trade readiness score at entry (0–100)
  avgRiskPercent: number;          // average risk percent allocated per trade
}

/**
 * Performance slice grouped by signal execution stage.
 */
export interface StageBreakdown {
  stage: SignalStage;
  metrics: PerformanceMetrics;
  tradeCount: number;
}

/**
 * Performance slice grouped by entry score magnitude range.
 */
export interface ScoreRangeBreakdown {
  range: string;            // "strong", "medium", "weak"
  minScore: number;
  maxScore: number;
  metrics: PerformanceMetrics;
  tradeCount: number;
}

/**
 * One point on the portfolio equity curve.
 */
export interface EquityPoint {
  date: string;
  equity: number;           // cumulative return starting at 100
  drawdown: number;         // current drawdown from peak (percent)
}

/**
 * Histogram bucket for trade return distribution.
 */
export interface WinLossDistribution {
  bucket: string;           // e.g. "-3% to -2%", "0% to 1%"
  count: number;
}

/**
 * Full report returned by runBacktest().
 */
export interface BacktestReport {
  summary: PerformanceMetrics;
  byStage: StageBreakdown[];
  byScoreRange: ScoreRangeBreakdown[];
  equityCurve: EquityPoint[];
  distribution: WinLossDistribution[];
  trades: TradeResult[];
  metadata: {
    cotHistoryPoints: number;
    pricePoints: number;
    weeksEvaluated: number;
    startDate: string;
    endDate: string;
    generatedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Centralised config for the trade engine.
 *
 * Signal thresholds: asymmetric entry (60) / exit (25) for hysteresis.
 * Risk management: hard stop, trailing stop, break-even upgrade.
 */
const CONFIG = {
  // --- Signal thresholds ---
  /** |score| must be >= this to open a new position. */
  ENTRY_THRESHOLD: 60,
  /**
   * Score level at which conviction is considered lost.
   * Direction-aware: LONG exits when score <= EXIT_THRESHOLD,
   * SHORT exits when score >= -EXIT_THRESHOLD.
   */
  EXIT_THRESHOLD: 25,

  // --- Holding period ---
  /** Minimum weeks a position must be held before any exit check. */
  MIN_HOLD_WEEKS: 2,
  /** Maximum weeks to hold a position before forced exit. */
  MAX_HOLD_WEEKS: 6,

  // --- Trend filter ---
  /** Whether to gate entries on a simple moving average trend filter. */
  USE_TREND_FILTER: true,
  /** Period (in COT weeks) for the SMA trend filter. */
  TREND_MA_PERIOD: 10,

  // --- Risk management ---
  /** Hard stop loss from entry price (percent, positive value). */
  STOP_LOSS_PCT: 3,
  /** Profit threshold to activate trailing stop (percent). */
  TRAILING_ACTIVATION_PCT: 3,
  /** Distance below peak to set the trailing stop (percent). */
  TRAILING_TRAIL_PCT: 2,
  /** Profit threshold to move stop to break-even / entry price (percent). */
  BREAKEVEN_ACTIVATION_PCT: 2,

  // --- Position sizing ---
  /** Fraction of full Kelly to use (0.25 = quarter Kelly). */
  KELLY_FRACTION: 0.25,
  /** Target risk per trade as fraction of equity (1% = 0.01). */
  TARGET_RISK_PER_TRADE: 0.01,
  /** ATR lookback period in weeks for volatility estimation. */
  ATR_PERIOD: 14,
  /** Minimum position size as fraction of equity. */
  MIN_POSITION_SIZE: 0.05,
  /** Maximum position size as fraction of equity. */
  MAX_POSITION_SIZE: 0.25,
  /** Default position size when insufficient trade history. */
  DEFAULT_POSITION_SIZE: 0.10,
  /** Rolling window of recent trades for Kelly computation. */
  KELLY_LOOKBACK: 20,
  /** Minimum closed trades before Kelly is used (else default size). */
  MIN_TRADES_FOR_KELLY: 10,
  /** Starting equity for the simulation. */
  STARTING_EQUITY: 100_000,

  // --- Trade quality filter ---
  /** Minimum expected risk-to-reward ratio to approve a trade. */
  MIN_EXPECTED_RR: 2.5,
  /**
   * Minimum signal confidence (0–100) to approve a trade.
   * Confidence = |score magnitude| × (0.5 + 0.5 × component agreement).
   */
  MIN_SIGNAL_STRENGTH: 70,
  /** Lookback period (weeks) for rolling price trend alignment check. */
  TREND_ALIGNMENT_PERIOD: 3,
  /** ATR reward multiplier: expected reward = ATR × this factor. */
  ATR_REWARD_MULTIPLE: 2.0,
  /** Lookback window (weeks) for ATR z-score volatility filter. */
  VOLATILITY_LOOKBACK: 20,
  /**
   * Maximum |z-score| of current ATR vs rolling mean.
   * Trades during extreme volatility spikes are rejected.
   */
  VOLATILITY_MAX_ZSCORE: 2.0,

  // --- Market regime detection ---
  /**
   * Number of recent signal scores to evaluate for directional consistency.
   * Higher values smooth regime detection but lag trend changes.
   */
  REGIME_SENTIMENT_LOOKBACK: 4,
  /**
   * Fraction of scores in the lookback window that must share the same
   * sign (all positive or all negative) for the regime to be TRENDING.
   * 0.75 = at least 75% of scores must agree in direction.
   */
  REGIME_TREND_CONSISTENCY: 0.75,
  /**
   * ATR z-score upper bound for regime volatility check.
   * Current ATR z-score > this → HIGH_VOLATILITY regime (reject).
   */
  REGIME_VOL_UPPER_ZSCORE: 1.8,
  /**
   * ATR z-score lower bound for regime volatility check.
   * Current ATR z-score < this (i.e. very compressed vol) → LOW_LIQUIDITY.
   * Negative value: -1.5 means ATR is 1.5 std devs below mean.
   */
  REGIME_VOL_LOWER_ZSCORE: -1.5,
  /**
   * Lookback window for OI percentile calculation.
   * Current OI is ranked against the last N weeks to detect thin markets.
   */
  REGIME_OI_LOOKBACK: 26,
  /**
   * Minimum OI percentile (0–100) for the market to be considered liquid.
   * Below this → LOW_LIQUIDITY regime (reject).
   */
  REGIME_OI_MIN_PERCENTILE: 20,

  // --- Trade confirmation layer ---
  /**
   * Maximum bars to wait for price action confirmation after a signal
   * passes quality + regime gates. Beyond this → REJECTED.
   */
  CONFIRM_EXPIRY_BARS: 3,
  /**
   * Lookback period (bars) for structure break detection (higher-high / lower-low).
   * Checks if current bar's high/low exceeds the extremes of the last N bars.
   */
  CONFIRM_STRUCTURE_LOOKBACK: 4,
  /**
   * Minimum candle body ratio (body / range) for a "strong candle" check.
   * Body = |close - open|, Range = high - low.
   * 0.6 means the body must be at least 60% of the total range.
   */
  CONFIRM_CANDLE_BODY_RATIO: 0.6,
  /**
   * Minimum number of directional checks (out of 4) that must pass
   * for a pending signal to be CONFIRMED.
   */
  CONFIRM_MIN_CHECKS: 1,

  // --- Multi-timeframe confirmation ---
  /** TwelveData API key (read from env). Empty string = skip LTF checks. */
  TWELVEDATA_API_KEY: process.env.TWELVEDATA_API_KEY ?? "",
  /** Intraday bar interval for LTF checks. */
  LTF_INTERVAL: "4h" as const,
  /** Number of 4h bars to fetch per week for LTF analysis. */
  LTF_BARS_PER_WEEK: 30,
  /** Lookback period in daily closes for MTF structure checks. */
  MTF_STRUCTURE_LOOKBACK: 5,
  /** Minimum body-to-range ratio for LTF momentum candle. */
  LTF_CANDLE_BODY_RATIO: 0.55,
  /** Number of 4h bars for LTF breakout/rejection lookback. */
  LTF_BREAKOUT_LOOKBACK: 6,
  /**
   * Weekly COT sentiment threshold for HTF bias determination.
   * Score magnitude must exceed this for directional bias.
   */
  HTF_SENTIMENT_THRESHOLD: 30,

  // --- Trade readiness scoring ---
  /** Weight for signal strength component (% of total). */
  READINESS_WEIGHT_SIGNAL: 15,
  /** Weight for signal confidence component (% of total). */
  READINESS_WEIGHT_CONFIDENCE: 15,
  /** Weight for market regime quality component (% of total). */
  READINESS_WEIGHT_REGIME: 15,
  /** Weight for higher-timeframe alignment component (% of total). */
  READINESS_WEIGHT_HTF: 20,
  /** Weight for medium-timeframe structure component (% of total). */
  READINESS_WEIGHT_MTF: 20,
  /** Weight for lower-timeframe trigger component (% of total). */
  READINESS_WEIGHT_LTF: 15,

  // --- Readiness-driven position sizing ---
  /** Minimum readiness score for PROBE tier entry. Below this = NO_TRADE. */
  SIZING_TIER_PROBE_MIN: 40,
  /** Minimum readiness score for STANDARD tier. */
  SIZING_TIER_STANDARD_MIN: 60,
  /** Minimum readiness score for HIGH_CONVICTION tier. */
  SIZING_TIER_HIGH_MIN: 80,
  /** Maximum risk percent across all tiers (hard cap). */
  SIZING_MAX_RISK_PCT: 1.5,
  /** PROBE tier — minimum risk percent. */
  SIZING_PROBE_RISK_MIN: 0.25,
  /** PROBE tier — maximum risk percent. */
  SIZING_PROBE_RISK_MAX: 0.5,
  /** STANDARD tier — minimum risk percent. */
  SIZING_STANDARD_RISK_MIN: 0.75,
  /** STANDARD tier — maximum risk percent. */
  SIZING_STANDARD_RISK_MAX: 1.0,
  /** HIGH_CONVICTION tier — minimum risk percent. */
  SIZING_HIGH_RISK_MIN: 1.25,
  /** HIGH_CONVICTION tier — maximum risk percent (capped). */
  SIZING_HIGH_RISK_MAX: 1.5,

  // --- Signal invalidation engine ---
  /** Maximum bars a pending signal can wait before time-based expiry invalidation. */
  INVALIDATION_MAX_BARS: 5,
  /** Momentum delta threshold: magnitude above this = strong reversal against signal. */
  INVALIDATION_MOMENTUM_THRESHOLD: 15,
  /** Readiness decay threshold: if readiness stays below this, signal is stale. */
  INVALIDATION_READINESS_THRESHOLD: 40,
  /** Minimum bars of low readiness before readiness decay triggers invalidation. */
  INVALIDATION_READINESS_MIN_BARS: 2,
} as const;

// ---------------------------------------------------------------------------
// 1. Gold price history fetcher
// ---------------------------------------------------------------------------

const FREEGOLDAPI_URL = "https://freegoldapi.com/data/latest.json";

interface FreeGoldApiEntry {
  date: string;
  price: number;
  source: string;
}

interface TwelveDataBarEntry {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

interface TwelveDataTimeSeriesResponse {
  status?: string;
  message?: string;
  values?: TwelveDataBarEntry[];
}

/**
 * Fetch historical daily gold prices from FreeGoldAPI.com.
 *
 * Returns daily close prices sorted by date ascending.
 * This is a free, no-auth API serving Yahoo Finance GC=F data.
 */
export async function fetchGoldPriceHistory(): Promise<PricePoint[]> {
  const res = await fetch(FREEGOLDAPI_URL, {
    next: { revalidate: 86400 }, // Cache for 24h
  });

  if (!res.ok) {
    console.error(
      `FreeGoldAPI fetch failed: ${res.status} ${res.statusText}`,
    );
    return [];
  }

  const data: FreeGoldApiEntry[] = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    console.error("FreeGoldAPI returned empty or invalid data");
    return [];
  }

  const points: PricePoint[] = data
    .filter((entry) => entry.date && typeof entry.price === "number" && entry.price > 0)
    .map((entry) => ({
      date: entry.date,
      close: entry.price,
    }));

  // Sort ascending by date
  points.sort((a, b) => a.date.localeCompare(b.date));

  return points;
}

// ---------------------------------------------------------------------------
// 1.5. Intraday (4h) OHLC fetcher
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-like datetime string to UTC milliseconds.
 *
 * Supports strings with or without "T" and timezone suffix.
 * Returns null if parsing fails.
 */
function parseDateTimeMs(datetime: string): number | null {
  if (!datetime) return null;

  const normalized = datetime.includes("T")
    ? datetime
    : datetime.replace(" ", "T");
  const withTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;

  const ms = new Date(withTimezone).getTime();
  if (Number.isNaN(ms)) return null;
  return ms;
}

/**
 * Fetch 4-hour OHLC bars from TwelveData for gold (XAU/USD).
 *
 * Returns bars sorted ascending by datetime.
 * Returns empty array if API key is not configured or request fails.
 * Free tier: 800 calls/day, ~6 months of 4h history.
 */
export async function fetchIntradayBars(): Promise<OhlcBar[]> {
  const apiKey = CONFIG.TWELVEDATA_API_KEY.trim();
  if (!apiKey) {
    return [];
  }

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent("XAU/USD")}&interval=${CONFIG.LTF_INTERVAL}&outputsize=5000&apikey=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      console.error(
        `TwelveData fetch failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }

    const data: TwelveDataTimeSeriesResponse = await res.json();

    if (data.status === "error") {
      console.error(`TwelveData API error: ${data.message ?? "unknown error"}`);
      return [];
    }

    if (!Array.isArray(data.values) || data.values.length === 0) {
      console.error("TwelveData returned empty or invalid intraday data");
      return [];
    }

    const bars: OhlcBar[] = [];

    for (const value of data.values) {
      const open = parseFloat(value.open);
      const high = parseFloat(value.high);
      const low = parseFloat(value.low);
      const close = parseFloat(value.close);

      if (
        !value.datetime
        || Number.isNaN(open)
        || Number.isNaN(high)
        || Number.isNaN(low)
        || Number.isNaN(close)
      ) {
        continue;
      }

      bars.push({
        datetime: value.datetime,
        open,
        high,
        low,
        close,
      });
    }

    bars.sort((a, b) => {
      const aMs = parseDateTimeMs(a.datetime) ?? 0;
      const bMs = parseDateTimeMs(b.datetime) ?? 0;
      return aMs - bMs;
    });

    return bars;
  } catch (error) {
    console.error("TwelveData intraday fetch failed:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Price lookup & weekly bar synthesis
// ---------------------------------------------------------------------------

/**
 * For a given date, find the closest daily close price within a
 * tolerance window (default +-3 days). Handles weekends/holidays
 * where a COT Tuesday may not have an exact price match.
 */
function findClosestPrice(
  targetDate: string,
  prices: PricePoint[],
  toleranceDays: number = 3,
): PricePoint | null {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000;

  let best: PricePoint | null = null;
  let bestDiff = Infinity;

  for (const p of prices) {
    const pTime = new Date(`${p.date}T00:00:00Z`).getTime();
    const diff = Math.abs(pTime - target);

    if (diff <= toleranceMs && diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * Build a map from COT dates to their nearest gold close price.
 * Weeks where no price is found are excluded.
 */
function buildPriceMap(
  cotHistory: CotHistoryPoint[],
  prices: PricePoint[],
): Map<string, PricePoint> {
  const priceMap = new Map<string, PricePoint>();

  for (const point of cotHistory) {
    const price = findClosestPrice(point.date, prices, 3);
    if (price) {
      priceMap.set(point.date, price);
    }
  }

  return priceMap;
}

/**
 * Build weekly OHLC bars from daily close prices, anchored to COT dates.
 *
 * For each pair of consecutive COT dates, collects all daily closes that
 * fall within that week window and computes open/high/low/close.
 *
 * This is a best-effort approximation since we only have daily closes,
 * not true intra-day high/low. For weekly-bar backtesting on COT data,
 * this is an accepted industry practice.
 */
function buildWeeklyBars(
  cotHistory: CotHistoryPoint[],
  prices: PricePoint[],
): Map<string, WeeklyBar> {
  const weeklyBars = new Map<string, WeeklyBar>();

  for (let i = 0; i < cotHistory.length; i++) {
    const cotDate = cotHistory[i].date;
    const cotTime = new Date(`${cotDate}T00:00:00Z`).getTime();

    // Window: previous COT date (exclusive) to current COT date (inclusive)
    const prevCotTime = i > 0
      ? new Date(`${cotHistory[i - 1].date}T00:00:00Z`).getTime()
      : cotTime - 7 * 24 * 60 * 60 * 1000; // default 7 days back

    // Collect daily closes within this week window
    const weekPrices: number[] = [];
    for (const p of prices) {
      const pTime = new Date(`${p.date}T00:00:00Z`).getTime();
      if (pTime > prevCotTime && pTime <= cotTime) {
        weekPrices.push(p.close);
      }
    }

    if (weekPrices.length === 0) {
      // Fall back to closest single price
      const closest = findClosestPrice(cotDate, prices, 3);
      if (closest) {
        weeklyBars.set(cotDate, {
          date: cotDate,
          open: closest.close,
          high: closest.close,
          low: closest.close,
          close: closest.close,
        });
      }
      continue;
    }

    weeklyBars.set(cotDate, {
      date: cotDate,
      open: weekPrices[0],
      high: Math.max(...weekPrices),
      low: Math.min(...weekPrices),
      close: weekPrices[weekPrices.length - 1],
    });
  }

  return weeklyBars;
}

/**
 * Build a map from COT week dates to arrays of 4h bars falling within that week.
 *
 * For each COT date (Tuesday), collects all 4h bars from the previous Tuesday
 * through this Tuesday (inclusive by date window).
 */
function buildIntradayBarMap(
  cotHistory: CotHistoryPoint[],
  intradayBars: OhlcBar[],
): Map<string, OhlcBar[]> {
  const intradayMap = new Map<string, OhlcBar[]>();

  if (intradayBars.length === 0) {
    for (const point of cotHistory) {
      intradayMap.set(point.date, []);
    }
    return intradayMap;
  }

  const barsWithTime = intradayBars
    .map((bar) => ({
      bar,
      ms: parseDateTimeMs(bar.datetime),
    }))
    .filter((entry): entry is { bar: OhlcBar; ms: number } => entry.ms !== null)
    .sort((a, b) => a.ms - b.ms);

  for (let i = 0; i < cotHistory.length; i++) {
    const cotDate = cotHistory[i].date;

    const endStartMs = new Date(`${cotDate}T00:00:00Z`).getTime();
    const endExclusiveMs = endStartMs + 24 * 60 * 60 * 1000;

    const startMs = i > 0
      ? new Date(`${cotHistory[i - 1].date}T00:00:00Z`).getTime()
      : endStartMs - 7 * 24 * 60 * 60 * 1000;

    const weekBars: OhlcBar[] = [];
    for (const entry of barsWithTime) {
      if (entry.ms >= startMs && entry.ms < endExclusiveMs) {
        weekBars.push(entry.bar);
      }
    }

    intradayMap.set(cotDate, weekBars.slice(-CONFIG.LTF_BARS_PER_WEEK));
  }

  return intradayMap;
}

// ---------------------------------------------------------------------------
// 3. SMA trend filter
// ---------------------------------------------------------------------------

/**
 * Compute a simple moving average over the most recent `period` values.
 *
 * Returns null if fewer than `period` values are available.
 */
function calculateSMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;

  const slice = prices.slice(-period);
  let sum = 0;
  for (const p of slice) {
    sum += p;
  }
  return sum / period;
}

// ---------------------------------------------------------------------------
// 4. Signal replay (per-week, look-ahead-free)
// ---------------------------------------------------------------------------

/**
 * Synthesize a CotReport from a CotHistoryPoint.
 *
 * CotHistoryPoint only stores net values (managedMoneyNet, commercialsNet).
 * The signal engine's scoreCotPositioning() only uses .net from CotReport,
 * so setting long/short to 0 is safe — it won't affect scoring.
 */
function synthesizeCotReport(point: CotHistoryPoint): CotReport {
  return {
    market: "Gold Futures",
    date: point.date,
    openInterest: point.openInterest,
    commercials: { long: 0, short: 0, net: point.commercialsNet },
    largeSpeculators: { long: 0, short: 0, net: point.managedMoneyNet },
    smallTraders: { long: 0, short: 0, net: 0 },
  };
}

/**
 * Derive discrete weekly price trend from two consecutive closes.
 *
 * Returns "up" when current >= previous, otherwise "down".
 */
function determinePriceTrend(current: number, previous: number): PriceTrend {
  return current >= previous ? "up" : "down";
}

/**
 * Build open-interest trend context for the signal engine.
 *
 * Returns current/previous OI values plus direction (up/down).
 */
function determineOiTrend(
  current: CotHistoryPoint,
  previous: CotHistoryPoint,
): OpenInterestTrend {
  return {
    current: current.openInterest,
    previous: previous.openInterest,
    trend: current.openInterest >= previous.openInterest ? "up" : "down",
  };
}

interface ReplayResult {
  signal: Signal;
  direction: SignalDirection;
  score: number;
  stage: SignalStage;
  /** Week-over-week change in managed money net positioning. */
  delta: number;
}

/**
 * Replay the signal engine for a single week using only data available
 * at that point in time (no look-ahead bias).
 *
 * Requires at least 2 weeks of history (current + previous) and
 * price data for both weeks.
 */
function replayWeek(
  cotHistory: CotHistoryPoint[],
  weekIndex: number,
  currentPrice: number,
  previousPrice: number,
): ReplayResult | null {
  if (weekIndex < 1) return null;

  const point = cotHistory[weekIndex];
  const prevPoint = cotHistory[weekIndex - 1];

  // Slice history up to and including this week (look-ahead-free)
  const historySlice = cotHistory.slice(0, weekIndex + 1);

  const percentiles = computePercentileMetrics(
    point.managedMoneyNet,
    point.commercialsNet,
    historySlice,
  );
  const deltas = getWeeklyDeltas(historySlice);
  const acceleration = calculateAcceleration(historySlice);

  const priceTrend = determinePriceTrend(currentPrice, previousPrice);
  const oiTrend = determineOiTrend(point, prevPoint);

  const cotReport = synthesizeCotReport(point);
  const input: SignalInput = {
    priceTrend,
    oiTrend,
    cotData: cotReport,
    percentiles,
    deltas,
    acceleration,
  };

  const signal = generateSignal(input);
  const { execution } = classifyExecution(signal, input);

  return {
    signal,
    direction: signal.signal,
    score: signal.score,
    stage: execution.stage,
    delta: deltas?.managedMoney ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 5. Risk management
// ---------------------------------------------------------------------------

/**
 * Compute unrealised P&L percentage for a position at a given price.
 */
function unrealisedPnl(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  currentPrice: number,
): number {
  if (direction === "LONG") {
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }
  return ((entryPrice - currentPrice) / entryPrice) * 100;
}

/**
 * Determine the effective stop-loss price for a position, accounting
 * for the break-even upgrade.
 *
 * Logic:
 *   - Base stop = entry price ± STOP_LOSS_PCT
 *   - If unrealised P&L ever reached BREAKEVEN_ACTIVATION_PCT,
 *     stop upgrades to entry price (break-even)
 */
function effectiveStopPrice(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  breakevenActivated: boolean,
): number {
  if (breakevenActivated) {
    return entryPrice;
  }

  if (direction === "LONG") {
    return entryPrice * (1 - CONFIG.STOP_LOSS_PCT / 100);
  }
  return entryPrice * (1 + CONFIG.STOP_LOSS_PCT / 100);
}

/**
 * Compute the trailing stop price from the peak/trough price.
 *
 * Returns null if the trailing stop has not yet activated
 * (peak profit hasn't reached TRAILING_ACTIVATION_PCT).
 */
function trailingStopPrice(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  peakPrice: number,
): number | null {
  const peakPnl = unrealisedPnl(direction, entryPrice, peakPrice);

  if (peakPnl < CONFIG.TRAILING_ACTIVATION_PCT) {
    return null; // Not yet activated
  }

  if (direction === "LONG") {
    return peakPrice * (1 - CONFIG.TRAILING_TRAIL_PCT / 100);
  }
  // SHORT: trail above the trough (lowest price reached)
  return peakPrice * (1 + CONFIG.TRAILING_TRAIL_PCT / 100);
}

/**
 * Check risk-based exit conditions using the weekly bar's high/low.
 *
 * Uses high for SHORT adverse checks, low for LONG adverse checks.
 * This catches intra-week stop hits that close-only analysis would miss.
 *
 * Priority:
 *   1. Hard stop loss (or break-even stop)
 *   2. Trailing stop
 *
 * Returns exit reason and the price at which the stop was hit,
 * or null if no risk exit triggered.
 */
function checkRiskExit(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  peakPrice: number,
  breakevenActivated: boolean,
  bar: WeeklyBar,
): { reason: ExitReason; exitPrice: number } | null {
  const stopPrice = effectiveStopPrice(direction, entryPrice, breakevenActivated);

  // 1. Hard stop loss (check adverse extreme of the bar)
  if (direction === "LONG") {
    if (bar.low <= stopPrice) {
      return { reason: "stop_loss", exitPrice: stopPrice };
    }
  } else {
    if (bar.high >= stopPrice) {
      return { reason: "stop_loss", exitPrice: stopPrice };
    }
  }

  // 2. Trailing stop
  const trailPrice = trailingStopPrice(direction, entryPrice, peakPrice);
  if (trailPrice !== null) {
    if (direction === "LONG") {
      if (bar.low <= trailPrice) {
        return { reason: "trailing_stop", exitPrice: trailPrice };
      }
    } else {
      if (bar.high >= trailPrice) {
        return { reason: "trailing_stop", exitPrice: trailPrice };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 6. Position sizing (Kelly Criterion + Volatility Scaling)
// ---------------------------------------------------------------------------

/**
 * Compute fractional Kelly criterion from a rolling window of closed trades.
 *
 * Kelly = (p * b - q) / b
 *   where p = win rate, q = 1 - p, b = avgWin / |avgLoss|
 *
 * Applies CONFIG.KELLY_FRACTION (quarter-Kelly by default) to reduce
 * variance. Returns 0 if Kelly is negative (no edge detected) or if
 * there are fewer than MIN_TRADES_FOR_KELLY completed trades.
 */
function computeKelly(closedTrades: TradeResult[]): number {
  // Use most recent KELLY_LOOKBACK trades
  const window = closedTrades.slice(-CONFIG.KELLY_LOOKBACK);

  if (window.length < CONFIG.MIN_TRADES_FOR_KELLY) {
    return 0; // Insufficient history — caller should use default size
  }

  const wins = window.filter((t) => t.returnPct > 0);
  const losses = window.filter((t) => t.returnPct <= 0);

  if (wins.length === 0 || losses.length === 0) {
    // No wins or no losses — edge is undefined, use default
    return 0;
  }

  const p = wins.length / window.length;
  const q = 1 - p;

  const avgWin = wins.reduce((s, t) => s + t.returnPct, 0) / wins.length;
  const avgLoss = losses.reduce((s, t) => s + Math.abs(t.returnPct), 0) / losses.length;

  // Prevent division by zero
  if (avgLoss === 0) return 0;

  const b = avgWin / avgLoss;

  // Kelly formula: (p * b - q) / b
  const kelly = (p * b - q) / b;

  if (kelly <= 0) return 0;

  return kelly * CONFIG.KELLY_FRACTION;
}

/**
 * Compute Average True Range from an ordered array of weekly bars.
 *
 * True Range for each bar = max(high - low, |high - prevClose|, |low - prevClose|)
 *
 * Returns the simple average of the last `period` true ranges,
 * or null if insufficient bars are available.
 */
function computeATR(
  orderedBars: WeeklyBar[],
  barIndex: number,
  period: number = CONFIG.ATR_PERIOD,
): number | null {
  // Need at least `period + 1` bars (period TRs require period+1 closes)
  if (barIndex < period) return null;

  let atrSum = 0;
  for (let i = barIndex - period + 1; i <= barIndex; i++) {
    const bar = orderedBars[i];
    const prevClose = orderedBars[i - 1].close;

    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
    atrSum += tr;
  }

  return atrSum / period;
}

/**
 * Compute position size by combining Kelly fraction with ATR-based
 * volatility scaling, clamped to [MIN_POSITION_SIZE, MAX_POSITION_SIZE].
 *
 * If Kelly returns 0 (insufficient trades or no edge), falls back to
 * CONFIG.DEFAULT_POSITION_SIZE.
 *
 * volatilityPct = ATR / price
 * volatilityFactor = targetRiskPerTrade / volatilityPct
 * raw = kelly * volatilityFactor
 * final = clamp(raw, MIN_POSITION_SIZE, MAX_POSITION_SIZE)
 */
function computePositionSize(
  kellyFraction: number,
  atr: number | null,
  price: number,
): number {
  // If no Kelly edge, use default
  if (kellyFraction <= 0) {
    return CONFIG.DEFAULT_POSITION_SIZE;
  }

  // If no ATR available, use Kelly alone (clamped)
  if (atr === null || atr <= 0) {
    return Math.min(
      Math.max(kellyFraction, CONFIG.MIN_POSITION_SIZE),
      CONFIG.MAX_POSITION_SIZE,
    );
  }

  // Volatility scaling
  const volatilityPct = atr / price;

  // Prevent division by zero on extremely low volatility
  if (volatilityPct <= 0) {
    return CONFIG.DEFAULT_POSITION_SIZE;
  }

  const volatilityFactor = CONFIG.TARGET_RISK_PER_TRADE / volatilityPct;

  const raw = kellyFraction * volatilityFactor;

  return Math.min(
    Math.max(raw, CONFIG.MIN_POSITION_SIZE),
    CONFIG.MAX_POSITION_SIZE,
  );
}

// ---------------------------------------------------------------------------
// 6.5. Readiness-Driven Position Sizing
// ---------------------------------------------------------------------------

/**
 * Classify readiness score into a sizing tier with associated risk band.
 *
 * Tiers:
 *   NO_TRADE        (readiness < 40)  — risk 0%
 *   PROBE           (40–59)           — risk 0.25%–0.5%
 *   STANDARD        (60–79)           — risk 0.75%–1.0%
 *   HIGH_CONVICTION (80–100)          — risk 1.25%–1.5% (capped)
 */
function classifySizingTier(
  readinessScore: number,
): { tier: SizingTier; riskMin: number; riskMax: number } {
  if (readinessScore >= CONFIG.SIZING_TIER_HIGH_MIN) {
    return {
      tier: "HIGH_CONVICTION",
      riskMin: CONFIG.SIZING_HIGH_RISK_MIN,
      riskMax: CONFIG.SIZING_HIGH_RISK_MAX,
    };
  }
  if (readinessScore >= CONFIG.SIZING_TIER_STANDARD_MIN) {
    return {
      tier: "STANDARD",
      riskMin: CONFIG.SIZING_STANDARD_RISK_MIN,
      riskMax: CONFIG.SIZING_STANDARD_RISK_MAX,
    };
  }
  if (readinessScore >= CONFIG.SIZING_TIER_PROBE_MIN) {
    return {
      tier: "PROBE",
      riskMin: CONFIG.SIZING_PROBE_RISK_MIN,
      riskMax: CONFIG.SIZING_PROBE_RISK_MAX,
    };
  }
  return { tier: "NO_TRADE", riskMin: 0, riskMax: 0 };
}

/**
 * Compute readiness-driven position size.
 *
 * Primary driver: readinessScore determines the risk tier and risk percent.
 * Secondary inputs: Kelly+ATR sizing is used as a scaling reference for
 * converting risk percent into a position size fraction.
 *
 * Smooth interpolation within each tier's risk band:
 *   t = (readinessScore - tierMin) / (tierMax - tierMin)
 *   riskPercent = riskMin + t * (riskMax - riskMin)
 *
 * Position size conversion (ATR-based):
 *   positionSize = (riskPercent / 100) / (ATR / price)
 *   — clamped to [MIN_POSITION_SIZE, MAX_POSITION_SIZE]
 *
 * If no ATR data is available, falls back to linear scaling from
 * the Kelly+ATR position size weighted by the risk percent ratio.
 *
 * @param readinessScore     Trade readiness composite score (0–100)
 * @param accountEquity      Current portfolio equity
 * @param kellyAtrPosSize    Position size from legacy Kelly+ATR pipeline
 * @param atr                Current ATR value (null if unavailable)
 * @param price              Current price (for ATR → position conversion)
 */
function computeReadinessPositionSize(
  readinessScore: number,
  accountEquity: number,
  kellyAtrPosSize: number,
  atr: number | null,
  price: number,
): ReadinessPositionSizingResult {
  const { tier, riskMin, riskMax } = classifySizingTier(readinessScore);

  // NO_TRADE: readiness too low — zero allocation
  if (tier === "NO_TRADE") {
    return {
      positionSize: 0,
      riskPercent: 0,
      capitalAllocated: 0,
      sizingTier: "NO_TRADE",
      reasoning: `Readiness ${round3(readinessScore)} < ${CONFIG.SIZING_TIER_PROBE_MIN} → NO_TRADE (zero allocation)`,
    };
  }

  // Determine tier boundaries for interpolation
  let tierMin: number;
  let tierMax: number;
  if (tier === "PROBE") {
    tierMin = CONFIG.SIZING_TIER_PROBE_MIN;
    tierMax = CONFIG.SIZING_TIER_STANDARD_MIN;
  } else if (tier === "STANDARD") {
    tierMin = CONFIG.SIZING_TIER_STANDARD_MIN;
    tierMax = CONFIG.SIZING_TIER_HIGH_MIN;
  } else {
    // HIGH_CONVICTION
    tierMin = CONFIG.SIZING_TIER_HIGH_MIN;
    tierMax = 100;
  }

  // Smooth interpolation within tier risk band
  const t = tierMax > tierMin
    ? Math.min((readinessScore - tierMin) / (tierMax - tierMin), 1)
    : 1;
  const riskPercent = riskMin + t * (riskMax - riskMin);

  // Convert risk percent to position size
  let positionSize: number;
  if (atr !== null && atr > 0 && price > 0) {
    // ATR-based conversion: riskPercent / volatilityPct
    const volatilityPct = atr / price;
    positionSize = (riskPercent / 100) / volatilityPct;
  } else {
    // Fallback: scale Kelly+ATR position size by risk ratio
    const maxRisk = CONFIG.SIZING_MAX_RISK_PCT;
    positionSize = maxRisk > 0
      ? kellyAtrPosSize * (riskPercent / maxRisk)
      : CONFIG.DEFAULT_POSITION_SIZE;
  }

  // Clamp to configured bounds
  positionSize = Math.min(
    Math.max(positionSize, CONFIG.MIN_POSITION_SIZE),
    CONFIG.MAX_POSITION_SIZE,
  );

  const capitalAllocated = accountEquity * positionSize;

  const reasoning = [
    `Readiness=${round3(readinessScore)}`,
    `Tier=${tier}`,
    `Risk=${round3(riskPercent)}%`,
    `t=${round3(t)}`,
    `band=[${riskMin}%,${riskMax}%]`,
    `posSize=${round3(positionSize)}`,
    atr !== null ? `ATR=${round3(atr)}` : "ATR=n/a",
    `Kelly+ATR=${round3(kellyAtrPosSize)}`,
  ].join(" | ");

  return {
    positionSize: round3(positionSize),
    riskPercent: round3(riskPercent),
    capitalAllocated: round3(capitalAllocated),
    sizingTier: tier,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// 7. Trade Quality Filter (Edge Gate)
// ---------------------------------------------------------------------------

/**
 * Compute the expected risk-to-reward ratio for a proposed trade.
 *
 * Expected reward is estimated as ATR × ATR_REWARD_MULTIPLE — a
 * conservative proxy for the likely move within the holding period.
 *
 * Risk (stop distance) is the fixed CONFIG.STOP_LOSS_PCT of entry price,
 * matching the hard stop used by the risk management layer.
 *
 * Returns the RR ratio, or 0 if ATR is unavailable (insufficient bars).
 */
function computeExpectedRR(
  atr: number | null,
  price: number,
): number {
  if (atr === null || atr <= 0 || price <= 0) return 0;

  const expectedReward = atr * CONFIG.ATR_REWARD_MULTIPLE;
  const stopDistance = price * (CONFIG.STOP_LOSS_PCT / 100);

  if (stopDistance <= 0) return 0;

  return expectedReward / stopDistance;
}

/**
 * Check whether the trade direction aligns with the rolling price trend.
 *
 * Uses a simple momentum check: is the current price higher or lower
 * than it was TREND_ALIGNMENT_PERIOD weeks ago?
 *
 *   BUY  (LONG)  → requires current price > price N weeks ago (uptrend)
 *   SELL (SHORT) → requires current price < price N weeks ago (downtrend)
 *
 * Returns true if the trend supports the trade direction, or if
 * insufficient history exists (benefit of the doubt).
 */
function checkTrendAlignment(
  direction: SignalDirection,
  priceHistory: number[],
): boolean {
  const period = CONFIG.TREND_ALIGNMENT_PERIOD;

  // Insufficient history — allow trade (don't penalise early data)
  if (priceHistory.length <= period) return true;

  const currentPrice = priceHistory[priceHistory.length - 1];
  const pastPrice = priceHistory[priceHistory.length - 1 - period];

  if (direction === "BUY") {
    return currentPrice > pastPrice;
  }
  if (direction === "SELL") {
    return currentPrice < pastPrice;
  }

  // NEUTRAL / CAUTION should never reach here (filtered by isValidEntry),
  // but reject if they do
  return false;
}

/**
 * Check whether current ATR volatility is within acceptable bounds.
 *
 * Computes a z-score of the current ATR against the rolling mean and
 * standard deviation of ATR over the past VOLATILITY_LOOKBACK periods.
 *
 * Rejects trades when |z-score| > VOLATILITY_MAX_ZSCORE, indicating
 * an abnormal volatility spike (or collapse) where signals are less
 * reliable.
 *
 * Returns { passed: true } if volatility is normal, or
 * { passed: false, zScore } if the z-score exceeds the threshold.
 *
 * If insufficient ATR history exists, passes (benefit of the doubt).
 */
function checkVolatilityFilter(
  orderedBars: WeeklyBar[],
  barIndex: number,
): { passed: boolean; zScore: number } {
  const lookback = CONFIG.VOLATILITY_LOOKBACK;

  // Need at least lookback+1 ATR values to compute a meaningful z-score.
  // Each ATR needs ATR_PERIOD+1 bars, so the earliest usable ATR is at
  // barIndex = ATR_PERIOD. We need `lookback` consecutive ATRs ending at
  // the current barIndex.
  const earliestAtrIndex = CONFIG.ATR_PERIOD;
  const neededBars = earliestAtrIndex + lookback;

  if (barIndex < neededBars) {
    return { passed: true, zScore: 0 };
  }

  // Collect rolling ATR values
  const atrValues: number[] = [];
  for (let j = barIndex - lookback + 1; j <= barIndex; j++) {
    const a = computeATR(orderedBars, j);
    if (a !== null) {
      atrValues.push(a);
    }
  }

  if (atrValues.length < 2) {
    return { passed: true, zScore: 0 };
  }

  const currentAtr = atrValues[atrValues.length - 1];
  const mean = atrValues.reduce((s, v) => s + v, 0) / atrValues.length;
  const stddev = calculateStdDev(atrValues);

  if (stddev <= 0) {
    // Zero variance — all ATRs identical, volatility is perfectly stable
    return { passed: true, zScore: 0 };
  }

  const zScore = (currentAtr - mean) / stddev;

  return {
    passed: Math.abs(zScore) <= CONFIG.VOLATILITY_MAX_ZSCORE,
    zScore: round3(zScore),
  };
}

/**
 * Evaluate a proposed trade against all four quality filters.
 *
 * This is the "Edge Gate" — a pre-trade quality check that runs AFTER
 * the basic entry conditions (isValidEntry) pass. A trade must satisfy
 * ALL four conditions to be approved.
 *
 * The function does NOT short-circuit: all conditions are evaluated so
 * that rejectionReasons contains every failing filter, useful for
 * diagnostics and post-hoc analysis.
 *
 * confidenceScore is a composite (0–100) reflecting how strongly the
 * trade passes each filter:
 *   - 25 points for Risk-to-Reward (scaled by how far above minimum)
 *   - 25 points for Signal Strength (scaled from threshold to 100)
 *   - 25 points for Trend Alignment (binary: 25 or 0)
 *   - 25 points for Volatility (scaled inversely by z-score magnitude)
 */
function evaluateTradeQuality(
  replay: ReplayResult,
  orderedBars: WeeklyBar[],
  barIndex: number,
  priceHistory: number[],
  currentPrice: number,
): TradeQualityResult {
  const rejectionReasons: string[] = [];
  let score = 0;

  // --- A. Risk-to-Reward ---
  const atr = computeATR(orderedBars, barIndex);
  const expectedRR = computeExpectedRR(atr, currentPrice);

  if (expectedRR >= CONFIG.MIN_EXPECTED_RR) {
    // Scale: MIN_EXPECTED_RR → 0 points, 2× minimum → full 25 points
    const rrExcess = (expectedRR - CONFIG.MIN_EXPECTED_RR) / CONFIG.MIN_EXPECTED_RR;
    score += Math.min(25, 25 * Math.min(1, rrExcess));
  } else {
    rejectionReasons.push(
      `Risk-to-Reward too low: ${round3(expectedRR)} < ${CONFIG.MIN_EXPECTED_RR}`,
    );
  }

  // --- B. Signal Strength ---
  const confidence = replay.signal.confidence;

  if (confidence >= CONFIG.MIN_SIGNAL_STRENGTH) {
    // Scale: MIN_SIGNAL_STRENGTH → 0 points, 100 → full 25 points
    const strengthRange = 100 - CONFIG.MIN_SIGNAL_STRENGTH;
    const strengthExcess = confidence - CONFIG.MIN_SIGNAL_STRENGTH;
    score += strengthRange > 0 ? 25 * Math.min(1, strengthExcess / strengthRange) : 25;
  } else {
    rejectionReasons.push(
      `Signal strength too low: ${round3(confidence)} < ${CONFIG.MIN_SIGNAL_STRENGTH}`,
    );
  }

  // --- C. Trend Alignment ---
  const trendAligned = checkTrendAlignment(replay.direction, priceHistory);

  if (trendAligned) {
    score += 25;
  } else {
    rejectionReasons.push(
      `Trade direction ${replay.direction} misaligned with ${CONFIG.TREND_ALIGNMENT_PERIOD}-week price trend`,
    );
  }

  // --- D. Volatility Filter ---
  const volCheck = checkVolatilityFilter(orderedBars, barIndex);

  if (volCheck.passed) {
    // Scale: zScore 0 → full 25 points, zScore at threshold → 0 points
    const zAbs = Math.abs(volCheck.zScore);
    const volScore = CONFIG.VOLATILITY_MAX_ZSCORE > 0
      ? 25 * Math.max(0, 1 - zAbs / CONFIG.VOLATILITY_MAX_ZSCORE)
      : 25;
    score += volScore;
  } else {
    rejectionReasons.push(
      `Volatility spike: ATR z-score ${volCheck.zScore} exceeds ±${CONFIG.VOLATILITY_MAX_ZSCORE}`,
    );
  }

  return {
    isApproved: rejectionReasons.length === 0,
    confidenceScore: round3(score),
    rejectionReasons,
  };
}

// ---------------------------------------------------------------------------
// 8. Market Regime Detection Filter
// ---------------------------------------------------------------------------

/**
 * Classify the rolling sentiment trend from recent signal scores.
 *
 * Looks at the last REGIME_SENTIMENT_LOOKBACK scores and measures
 * directional consistency — what fraction share the same sign.
 *
 * Returns:
 *   - consistency: 0–1 fraction of scores agreeing in sign with the majority
 *   - isTrending: true if consistency >= REGIME_TREND_CONSISTENCY
 */
function classifySentimentTrend(
  scoreHistory: number[],
): { consistency: number; isTrending: boolean } {
  const lookback = CONFIG.REGIME_SENTIMENT_LOOKBACK;

  if (scoreHistory.length < lookback) {
    // Insufficient data — benefit of the doubt, allow trading
    return { consistency: 1, isTrending: true };
  }

  const window = scoreHistory.slice(-lookback);

  const positiveCount = window.filter((s) => s > 0).length;
  const negativeCount = window.filter((s) => s < 0).length;

  // Majority direction — ties (including zeros) counted as inconsistent
  const majorityCount = Math.max(positiveCount, negativeCount);
  const consistency = majorityCount / lookback;

  return {
    consistency: round3(consistency),
    isTrending: consistency >= CONFIG.REGIME_TREND_CONSISTENCY,
  };
}

/**
 * Check regime-level volatility using ATR z-score with a two-sided band.
 *
 * Unlike the quality filter's one-sided volatility check (rejects spikes),
 * the regime filter also rejects extremely LOW volatility — a proxy for
 * a stagnant, low-liquidity market where signals are unreliable.
 *
 * Returns:
 *   - passed: true if z-score is within [LOWER, UPPER] band
 *   - zScore: the computed ATR z-score
 *   - rejection: "HIGH_VOLATILITY" or "LOW_LIQUIDITY" or null
 */
function checkRegimeVolatility(
  orderedBars: WeeklyBar[],
  barIndex: number,
): { passed: boolean; zScore: number; rejection: RegimeType | null } {
  const lookback = CONFIG.VOLATILITY_LOOKBACK;
  const earliestAtrIndex = CONFIG.ATR_PERIOD;
  const neededBars = earliestAtrIndex + lookback;

  if (barIndex < neededBars) {
    return { passed: true, zScore: 0, rejection: null };
  }

  const atrValues: number[] = [];
  for (let j = barIndex - lookback + 1; j <= barIndex; j++) {
    const a = computeATR(orderedBars, j);
    if (a !== null) {
      atrValues.push(a);
    }
  }

  if (atrValues.length < 2) {
    return { passed: true, zScore: 0, rejection: null };
  }

  const currentAtr = atrValues[atrValues.length - 1];
  const mean = atrValues.reduce((s, v) => s + v, 0) / atrValues.length;
  const stddev = calculateStdDev(atrValues);

  if (stddev <= 0) {
    return { passed: true, zScore: 0, rejection: null };
  }

  const zScore = round3((currentAtr - mean) / stddev);

  if (zScore > CONFIG.REGIME_VOL_UPPER_ZSCORE) {
    return { passed: false, zScore, rejection: "HIGH_VOLATILITY" };
  }
  if (zScore < CONFIG.REGIME_VOL_LOWER_ZSCORE) {
    return { passed: false, zScore, rejection: "LOW_LIQUIDITY" };
  }

  return { passed: true, zScore, rejection: null };
}

/**
 * Check open interest as a liquidity proxy.
 *
 * Ranks the current week's OI against the last REGIME_OI_LOOKBACK
 * weeks. If the current OI percentile falls below REGIME_OI_MIN_PERCENTILE,
 * the market is considered too thin for reliable signal execution.
 *
 * Returns:
 *   - passed: true if OI percentile >= threshold
 *   - percentile: 0–100 rank of current OI
 */
function checkLiquidityProxy(
  cotHistory: CotHistoryPoint[],
  weekIndex: number,
): { passed: boolean; percentile: number } {
  const lookback = CONFIG.REGIME_OI_LOOKBACK;

  // Need at least a few weeks to rank against
  if (weekIndex < 2) {
    return { passed: true, percentile: 50 };
  }

  // Slice the OI history up to and including this week (look-ahead-free)
  const startIdx = Math.max(0, weekIndex - lookback + 1);
  const window = cotHistory.slice(startIdx, weekIndex + 1);

  if (window.length < 2) {
    return { passed: true, percentile: 50 };
  }

  const currentOI = cotHistory[weekIndex].openInterest;
  const oiValues = window.map((p) => p.openInterest);

  // Percentile: fraction of values <= current OI
  const belowOrEqual = oiValues.filter((v) => v <= currentOI).length;
  const percentile = round3((belowOrEqual / oiValues.length) * 100);

  return {
    passed: percentile >= CONFIG.REGIME_OI_MIN_PERCENTILE,
    percentile,
  };
}

/**
 * Detect the current market regime and decide whether trading is allowed.
 *
 * This is the SECOND gating layer, evaluated after the quality filter.
 * Flow: SIGNAL → QUALITY FILTER → REGIME FILTER → EXECUTION
 *
 * Regime classification priority:
 *   1. HIGH_VOLATILITY — extreme ATR spike (most dangerous, checked first)
 *   2. LOW_LIQUIDITY — thin market (OI too low or ATR too compressed)
 *   3. RANGING — choppy sentiment (no directional conviction)
 *   4. TRENDING — favourable conditions (only tradable regime)
 *
 * regimeScore (0–100) is a composite:
 *   - 40 points for trend consistency (scaled from threshold to 1.0)
 *   - 30 points for volatility normality (scaled inversely by z-score)
 *   - 30 points for liquidity (scaled from threshold to 100th percentile)
 */
function detectMarketRegime(
  scoreHistory: number[],
  orderedBars: WeeklyBar[],
  barIndex: number,
  cotHistory: CotHistoryPoint[],
  weekIndex: number,
): RegimeDetectionResult {
  const rejectionReasons: string[] = [];

  // --- A. Trend Strength (sentiment directional consistency) ---
  const trend = classifySentimentTrend(scoreHistory);

  // --- B. Volatility Check (two-sided ATR z-score band) ---
  const vol = checkRegimeVolatility(orderedBars, barIndex);

  // --- C. Liquidity Proxy (OI percentile) ---
  const liq = checkLiquidityProxy(cotHistory, weekIndex);

  // --- Classify regime type (priority order) ---
  let regimeType: RegimeType;

  if (!vol.passed && vol.rejection === "HIGH_VOLATILITY") {
    regimeType = "HIGH_VOLATILITY";
    rejectionReasons.push(
      `Extreme volatility: ATR z-score ${vol.zScore} > ${CONFIG.REGIME_VOL_UPPER_ZSCORE}`,
    );
  } else if (!vol.passed && vol.rejection === "LOW_LIQUIDITY") {
    regimeType = "LOW_LIQUIDITY";
    rejectionReasons.push(
      `Compressed volatility: ATR z-score ${vol.zScore} < ${CONFIG.REGIME_VOL_LOWER_ZSCORE}`,
    );
  } else if (!liq.passed) {
    regimeType = "LOW_LIQUIDITY";
    rejectionReasons.push(
      `Low open interest: ${liq.percentile}th percentile < ${CONFIG.REGIME_OI_MIN_PERCENTILE}th minimum`,
    );
  } else if (!trend.isTrending) {
    regimeType = "RANGING";
    rejectionReasons.push(
      `Choppy sentiment: ${round3(trend.consistency * 100)}% directional consistency < ${CONFIG.REGIME_TREND_CONSISTENCY * 100}% required`,
    );
  } else {
    regimeType = "TRENDING";
  }

  // --- Composite score ---
  // Trend component (40 points): scale consistency from threshold to 1.0
  const trendRange = 1 - CONFIG.REGIME_TREND_CONSISTENCY;
  const trendExcess = trend.consistency - CONFIG.REGIME_TREND_CONSISTENCY;
  const trendScore = trend.isTrending && trendRange > 0
    ? 40 * Math.min(1, Math.max(0, trendExcess / trendRange))
    : 0;

  // Volatility component (30 points): scaled inversely by |z-score|
  // Best score at z=0, zero at z=upper threshold
  const volMax = CONFIG.REGIME_VOL_UPPER_ZSCORE;
  const volScore = vol.passed && volMax > 0
    ? 30 * Math.max(0, 1 - Math.abs(vol.zScore) / volMax)
    : 0;

  // Liquidity component (30 points): scale percentile from threshold to 100
  const liqRange = 100 - CONFIG.REGIME_OI_MIN_PERCENTILE;
  const liqExcess = liq.percentile - CONFIG.REGIME_OI_MIN_PERCENTILE;
  const liqScore = liq.passed && liqRange > 0
    ? 30 * Math.min(1, Math.max(0, liqExcess / liqRange))
    : 0;

  const regimeScore = round3(trendScore + volScore + liqScore);

  return {
    isTradable: regimeType === "TRENDING",
    regimeType,
    regimeScore,
    rejectionReasons,
  };
}

// ---------------------------------------------------------------------------
// 9. Multi-Timeframe Confirmation Layer
// ---------------------------------------------------------------------------

/**
 * Check if the current bar makes a higher high vs recent N bars.
 *
 * For LONG confirmation: current bar's high exceeds the highest high
 * of the lookback window, indicating structural strength.
 */
function checkHigherHigh(
  orderedBars: WeeklyBar[],
  barIndex: number,
  lookback: number = CONFIG.CONFIRM_STRUCTURE_LOOKBACK,
): boolean {
  if (lookback <= 0 || barIndex < lookback) return false;

  const currentHigh = orderedBars[barIndex].high;

  let maxHigh = -Infinity;
  for (let j = barIndex - lookback; j < barIndex; j++) {
    if (orderedBars[j].high > maxHigh) {
      maxHigh = orderedBars[j].high;
    }
  }

  return currentHigh > maxHigh;
}

/**
 * Check if the current bar makes a lower low vs recent N bars.
 *
 * For SHORT confirmation: current bar's low undercuts the lowest low
 * of the lookback window, indicating structural weakness.
 */
function checkLowerLow(
  orderedBars: WeeklyBar[],
  barIndex: number,
  lookback: number = CONFIG.CONFIRM_STRUCTURE_LOOKBACK,
): boolean {
  if (lookback <= 0 || barIndex < lookback) return false;

  const currentLow = orderedBars[barIndex].low;

  let minLow = Infinity;
  for (let j = barIndex - lookback; j < barIndex; j++) {
    if (orderedBars[j].low < minLow) {
      minLow = orderedBars[j].low;
    }
  }

  return currentLow < minLow;
}

/**
 * Check if the current bar closes above the rolling resistance level.
 *
 * Resistance = highest close in the lookback window (excluding current bar).
 * A close above resistance indicates bullish breakout conviction.
 */
function checkResistanceBreakout(
  priceHistory: number[],
  lookback: number = CONFIG.CONFIRM_STRUCTURE_LOOKBACK,
): boolean {
  if (lookback <= 0 || priceHistory.length <= lookback) return false;

  const currentClose = priceHistory[priceHistory.length - 1];

  let maxClose = -Infinity;
  for (let j = priceHistory.length - 1 - lookback; j < priceHistory.length - 1; j++) {
    if (priceHistory[j] > maxClose) {
      maxClose = priceHistory[j];
    }
  }

  return currentClose > maxClose;
}

/**
 * Check if the current bar closes below the rolling support level.
 *
 * Support = lowest close in the lookback window (excluding current bar).
 * A close below support indicates bearish breakdown conviction.
 */
function checkSupportBreak(
  priceHistory: number[],
  lookback: number = CONFIG.CONFIRM_STRUCTURE_LOOKBACK,
): boolean {
  if (lookback <= 0 || priceHistory.length <= lookback) return false;

  const currentClose = priceHistory[priceHistory.length - 1];

  let minClose = Infinity;
  for (let j = priceHistory.length - 1 - lookback; j < priceHistory.length - 1; j++) {
    if (priceHistory[j] < minClose) {
      minClose = priceHistory[j];
    }
  }

  return currentClose < minClose;
}

/**
 * Check if the managed-money delta confirms the trade direction.
 *
 * LONG: delta > 0 (net buying by managed money)
 * SHORT: delta < 0 (net selling by managed money)
 */
function checkMomentumContinuation(
  direction: "LONG" | "SHORT",
  currentDelta: number,
): boolean {
  if (direction === "LONG") return currentDelta > 0;
  return currentDelta < 0;
}

/**
 * Check if the current bar is a "strong candle" in the trade direction.
 *
 * A strong candle has:
 *   - Body (|close - open|) >= minBodyRatio × range (high - low)
 *   - LONG: close > open (bullish body)
 *   - SHORT: close < open (bearish body)
 */
function checkStrongCandle(
  direction: "LONG" | "SHORT",
  bar: Pick<WeeklyBar, "open" | "high" | "low" | "close">,
  minBodyRatio: number = CONFIG.CONFIRM_CANDLE_BODY_RATIO,
): boolean {
  const range = bar.high - bar.low;
  if (range <= 0) return false;

  const body = Math.abs(bar.close - bar.open);
  const bodyRatio = body / range;

  if (bodyRatio < minBodyRatio) return false;

  if (direction === "LONG") return bar.close > bar.open;
  return bar.close < bar.open;
}

/**
 * Detect a higher-low structure on recent close prices.
 *
 * Splits the lookback window in two halves and checks whether the most
 * recent half prints a higher minimum than the earlier half.
 */
function checkHigherLow(priceHistory: number[], lookback: number): boolean {
  if (lookback < 2 || priceHistory.length < lookback) return false;

  const window = priceHistory.slice(-lookback);
  const split = Math.floor(window.length / 2);
  if (split < 1 || split >= window.length) return false;

  let firstHalfMin = Infinity;
  for (let i = 0; i < split; i++) {
    if (window[i] < firstHalfMin) {
      firstHalfMin = window[i];
    }
  }

  let secondHalfMin = Infinity;
  for (let i = split; i < window.length; i++) {
    if (window[i] < secondHalfMin) {
      secondHalfMin = window[i];
    }
  }

  return secondHalfMin > firstHalfMin;
}

/**
 * Detect a lower-high structure on recent close prices.
 *
 * Splits the lookback window in two halves and checks whether the most
 * recent half prints a lower maximum than the earlier half.
 */
function checkLowerHigh(priceHistory: number[], lookback: number): boolean {
  if (lookback < 2 || priceHistory.length < lookback) return false;

  const window = priceHistory.slice(-lookback);
  const split = Math.floor(window.length / 2);
  if (split < 1 || split >= window.length) return false;

  let firstHalfMax = -Infinity;
  for (let i = 0; i < split; i++) {
    if (window[i] > firstHalfMax) {
      firstHalfMax = window[i];
    }
  }

  let secondHalfMax = -Infinity;
  for (let i = split; i < window.length; i++) {
    if (window[i] > secondHalfMax) {
      secondHalfMax = window[i];
    }
  }

  return secondHalfMax < firstHalfMax;
}

// ---------------------------------------------------------------------------
// 9.1 HTF: Weekly sentiment bias alignment
// ---------------------------------------------------------------------------

/**
 * HTF: Determine weekly sentiment bias from COT replay score.
 *
 * Bias rules:
 *   - score > HTF_SENTIMENT_THRESHOLD   → BULLISH bias (LONG only)
 *   - score < -HTF_SENTIMENT_THRESHOLD  → BEARISH bias (SHORT only)
 *   - otherwise                          → NEUTRAL (reject)
 */
function checkHTFAlignment(
  direction: "LONG" | "SHORT",
  signalScore: number,
): { aligned: boolean; bias: "BULLISH" | "BEARISH" | "NEUTRAL"; reason: string } {
  const threshold = CONFIG.HTF_SENTIMENT_THRESHOLD;

  let bias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (signalScore > threshold) {
    bias = "BULLISH";
  } else if (signalScore < -threshold) {
    bias = "BEARISH";
  }

  if (bias === "NEUTRAL") {
    return {
      aligned: false,
      bias,
      reason: `HTF neutral bias: |score|=${round3(Math.abs(signalScore))} <= ${threshold}`,
    };
  }

  const aligned = (direction === "LONG" && bias === "BULLISH")
    || (direction === "SHORT" && bias === "BEARISH");

  if (aligned) {
    return {
      aligned: true,
      bias,
      reason: `HTF aligned: ${bias} bias supports ${direction}`,
    };
  }

  return {
    aligned: false,
    bias,
    reason: `HTF misaligned: ${bias} bias rejects ${direction}`,
  };
}

// ---------------------------------------------------------------------------
// 9.2 MTF: Daily structure confirmation
// ---------------------------------------------------------------------------

/**
 * MTF: Evaluate daily structure confirmation for the trade direction.
 *
 * LONG checks:
 *   1) Higher low on daily closes
 *   2) Resistance breakout on daily closes
 *   3) Current close above short-term MA
 *
 * SHORT checks:
 *   1) Lower high on daily closes
 *   2) Support break on daily closes
 *   3) Current close below short-term MA
 *
 * At least 1 of 3 checks must pass.
 */
function checkMTFStructure(
  direction: "LONG" | "SHORT",
  priceHistory: number[],
  orderedBars: WeeklyBar[],
  barIndex: number,
): { confirmed: boolean; passedChecks: string[]; reason: string } {
  const lookback = CONFIG.MTF_STRUCTURE_LOOKBACK;
  const passedChecks: string[] = [];

  const currentClose = priceHistory[priceHistory.length - 1];
  const shortMa = calculateSMA(priceHistory, lookback);

  if (direction === "LONG") {
    if (checkHigherLow(priceHistory, lookback)) {
      passedChecks.push("higher_low");
    }
    if (checkResistanceBreakout(priceHistory, lookback)) {
      passedChecks.push("resistance_breakout");
    }
    if (shortMa !== null && currentClose > shortMa) {
      passedChecks.push("above_short_ma");
    }
  } else {
    if (checkLowerHigh(priceHistory, lookback)) {
      passedChecks.push("lower_high");
    }
    if (checkSupportBreak(priceHistory, lookback)) {
      passedChecks.push("support_break");
    }
    if (shortMa !== null && currentClose < shortMa) {
      passedChecks.push("below_short_ma");
    }
  }

  const confirmed = passedChecks.length >= 1;

  // Weekly-bar context (non-gating) to keep helper checks integrated.
  const weeklyLookback = Math.min(CONFIG.MTF_STRUCTURE_LOOKBACK, Math.max(1, barIndex));
  const weeklyStructureAligned = direction === "LONG"
    ? checkHigherHigh(orderedBars, barIndex, weeklyLookback)
    : checkLowerLow(orderedBars, barIndex, weeklyLookback);

  if (confirmed) {
    return {
      confirmed: true,
      passedChecks,
      reason: `MTF confirmed (${passedChecks.join(", ")}); weekly structure context=${weeklyStructureAligned ? "aligned" : "neutral"}`,
    };
  }

  return {
    confirmed: false,
    passedChecks,
    reason: `MTF unclear: no daily structure checks passed; weekly structure context=${weeklyStructureAligned ? "aligned" : "neutral"}`,
  };
}

// ---------------------------------------------------------------------------
// 9.3 LTF: Intraday (4h) trigger confirmation
// ---------------------------------------------------------------------------

/**
 * Check for bullish support rejection on a 4h candle.
 *
 * Requires bullish close with dominant lower wick.
 */
function checkSupportRejectionCandle(bar: OhlcBar): boolean {
  const range = bar.high - bar.low;
  if (range <= 0) return false;

  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const lowerWick = bodyBottom - bar.low;
  const upperWick = bar.high - bodyTop;

  return bar.close > bar.open
    && lowerWick / range >= 0.35
    && lowerWick > upperWick;
}

/**
 * Check for bearish resistance rejection on a 4h candle.
 *
 * Requires bearish close with dominant upper wick.
 */
function checkResistanceRejectionCandle(bar: OhlcBar): boolean {
  const range = bar.high - bar.low;
  if (range <= 0) return false;

  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const lowerWick = bodyBottom - bar.low;
  const upperWick = bar.high - bodyTop;

  return bar.close < bar.open
    && upperWick / range >= 0.35
    && upperWick > lowerWick;
}

/**
 * LTF: Evaluate 4-hour intraday bars for entry timing trigger.
 *
 * LONG checks:
 *   1) Bullish momentum candle
 *   2) Breakout above recent 4h highs
 *   3) Support rejection candle
 *
 * SHORT checks:
 *   1) Bearish momentum candle
 *   2) Breakdown below recent 4h lows
 *   3) Resistance rejection candle
 *
 * At least 1 of 3 checks must pass.
 */
function checkLTFTrigger(
  direction: "LONG" | "SHORT",
  intradayBars: OhlcBar[],
): { triggered: boolean; passedChecks: string[]; reason: string } {
  if (intradayBars.length === 0) {
    return {
      triggered: false,
      passedChecks: [],
      reason: "No intraday data available",
    };
  }

  const bars = intradayBars.slice(-CONFIG.LTF_BARS_PER_WEEK);
  if (bars.length === 0) {
    return {
      triggered: false,
      passedChecks: [],
      reason: "No intraday data available",
    };
  }

  const latestBar = bars[bars.length - 1];
  const passedChecks: string[] = [];

  if (checkStrongCandle(direction, latestBar, CONFIG.LTF_CANDLE_BODY_RATIO)) {
    passedChecks.push(
      direction === "LONG" ? "bullish_momentum_candle" : "bearish_momentum_candle",
    );
  }

  const structureBars: WeeklyBar[] = bars.map((bar) => ({
    date: bar.datetime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));

  const ltfBarIndex = structureBars.length - 1;
  const breakoutLookback = Math.min(
    CONFIG.LTF_BREAKOUT_LOOKBACK,
    Math.max(1, ltfBarIndex),
  );

  if (direction === "LONG") {
    if (checkHigherHigh(structureBars, ltfBarIndex, breakoutLookback)) {
      passedChecks.push("intraday_breakout");
    }
    if (checkSupportRejectionCandle(latestBar)) {
      passedChecks.push("support_rejection");
    }
  } else {
    if (checkLowerLow(structureBars, ltfBarIndex, breakoutLookback)) {
      passedChecks.push("intraday_breakdown");
    }
    if (checkResistanceRejectionCandle(latestBar)) {
      passedChecks.push("resistance_rejection");
    }
  }

  const triggered = passedChecks.length >= 1;
  return {
    triggered,
    passedChecks,
    reason: triggered
      ? `LTF triggered (${passedChecks.join(", ")})`
      : "LTF pending: no intraday trigger checks passed",
  };
}

// ---------------------------------------------------------------------------
// 9.4 Multi-timeframe evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate multi-timeframe confirmation for a pending signal.
 *
 * Tier order:
 *   1) HTF (weekly sentiment bias) — immediate reject if misaligned
 *   2) MTF (daily structure)
 *   3) LTF (4h trigger)
 *
 * Confirmation requires HTF + MTF + LTF when intraday data exists.
 * If no intraday data exists, the system degrades to HTF + MTF.
 */
function evaluateMultiTimeframeConfirmation(
  pending: PendingConfirmation,
  signalScore: number,
  priceHistory: number[],
  orderedBars: WeeklyBar[],
  barIndex: number,
  intradayBars: OhlcBar[],
  currentDelta: number,
  bar: WeeklyBar,
): MultiTimeframeConfirmationResult {
  const alignedTimeframes: string[] = [];
  const missingConfirmations: string[] = [];
  const reasoningParts: string[] = [];

  const htf = checkHTFAlignment(pending.direction, signalScore);
  reasoningParts.push(htf.reason);

  if (!htf.aligned) {
    return {
      isConfirmed: false,
      confirmationStatus: "REJECTED",
      alignedTimeframes,
      missingConfirmations: ["HTF bias alignment"],
      reasoning: htf.reason,
      htfAligned: false,
      mtfConfirmed: false,
      ltfTriggered: false,
      mtfPassedChecks: [],
      ltfPassedChecks: [],
      hasIntradayData: intradayBars.length > 0,
    };
  }
  alignedTimeframes.push("HTF");

  const mtf = checkMTFStructure(
    pending.direction,
    priceHistory,
    orderedBars,
    barIndex,
  );
  reasoningParts.push(mtf.reason);

  if (mtf.confirmed) {
    alignedTimeframes.push("MTF");
  } else {
    missingConfirmations.push("MTF structure");
  }

  const ltf = checkLTFTrigger(pending.direction, intradayBars);
  reasoningParts.push(ltf.reason);

  const hasIntradayData = intradayBars.length > 0;
  if (hasIntradayData) {
    if (ltf.triggered) {
      alignedTimeframes.push("LTF");
    } else {
      missingConfirmations.push("LTF trigger");
    }
  }

  // Legacy directional context from v8 checks (non-gating).
  const weeklyMomentum = checkMomentumContinuation(pending.direction, currentDelta);
  const weeklyCandle = checkStrongCandle(pending.direction, bar);
  reasoningParts.push(
    `Weekly context: momentum=${weeklyMomentum ? "aligned" : "not_aligned"}, candle=${weeklyCandle ? "strong" : "weak"}`,
  );

  const ltfRequirementPassed = hasIntradayData ? ltf.triggered : true;
  const isConfirmed = htf.aligned && mtf.confirmed && ltfRequirementPassed;

  if (isConfirmed) {
    if (!hasIntradayData) {
      reasoningParts.push("LTF skipped: no intraday data (graceful HTF+MTF fallback)");
    }
    return {
      isConfirmed: true,
      confirmationStatus: "CONFIRMED",
      alignedTimeframes,
      missingConfirmations,
      reasoning: reasoningParts.join(" | "),
      htfAligned: true,
      mtfConfirmed: true,
      ltfTriggered: hasIntradayData ? ltf.triggered : false,
      mtfPassedChecks: mtf.passedChecks,
      ltfPassedChecks: ltf.passedChecks,
      hasIntradayData,
    };
  }

  if (pending.barsWaited >= CONFIG.CONFIRM_EXPIRY_BARS) {
    return {
      isConfirmed: false,
      confirmationStatus: "REJECTED",
      alignedTimeframes,
      missingConfirmations,
      reasoning: `${reasoningParts.join(" | ")} | Expired after ${pending.barsWaited} bars`,
      htfAligned: true,
      mtfConfirmed: mtf.confirmed,
      ltfTriggered: hasIntradayData ? ltf.triggered : false,
      mtfPassedChecks: mtf.passedChecks,
      ltfPassedChecks: ltf.passedChecks,
      hasIntradayData,
    };
  }

  return {
    isConfirmed: false,
    confirmationStatus: "PENDING",
    alignedTimeframes,
    missingConfirmations,
    reasoning: reasoningParts.join(" | "),
    htfAligned: true,
    mtfConfirmed: mtf.confirmed,
    ltfTriggered: hasIntradayData ? ltf.triggered : false,
    mtfPassedChecks: mtf.passedChecks,
    ltfPassedChecks: ltf.passedChecks,
    hasIntradayData,
  };
}

// ---------------------------------------------------------------------------
// 9.5 Trade readiness scoring
// ---------------------------------------------------------------------------

/**
 * Classify a readiness score into a named readiness level.
 *
 *   0–30  → LOW             (weak alignment)
 *   31–55 → BUILDING        (partial alignment)
 *   56–75 → READY           (sufficient alignment)
 *   76–100→ HIGH_CONVICTION  (strong multi-layer agreement)
 */
function classifyReadinessLevel(score: number): ReadinessLevel {
  if (score <= 30) return "LOW";
  if (score <= 55) return "BUILDING";
  if (score <= 75) return "READY";
  return "HIGH_CONVICTION";
}

/**
 * Scale MTF/LTF passed-check counts to a 0–100 sub-score.
 *
 *   0 checks → 0
 *   1 check  → 50
 *   2 checks → 80
 *   3 checks → 100
 *
 * Caps at 100 for any count >= 3.
 */
function scaleCheckCount(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 50;
  if (count === 2) return 80;
  return 100;
}

/**
 * Compute trade readiness score from all available gating-layer outputs.
 *
 * Called at MTF confirmation time with scores from quality gate, regime
 * detection, signal replay, and multi-timeframe confirmation.
 *
 * Weighted model:
 *   Signal Strength  (15%) — abs(signalScore)/100 → 0-100
 *   Confidence       (15%) — signal confidence already 0-100
 *   Regime Quality   (15%) — regime score already 0-100
 *   HTF Alignment    (20%) — aligned → scale by score strength; opposed → 0
 *   MTF Structure    (20%) — scaled by passed check count
 *   LTF Trigger      (15%) — scaled by passed check count; no data → quality fallback
 */
function computeTradeReadiness(
  signalScore: number,
  signalConfidence: number,
  regimeScore: number,
  htfAligned: boolean,
  mtfPassedChecks: string[],
  ltfPassedChecks: string[],
  hasIntradayData: boolean,
  qualityScore: number,
): TradeReadinessResult {
  // --- Component sub-scores ---

  // 1. Signal Strength: normalise absolute score to 0-100
  const signalStrength = Math.min(100, (Math.abs(signalScore) / 100) * 100);

  // 2. Confidence: already 0-100
  const confidence = Math.min(100, Math.max(0, signalConfidence));

  // 3. Regime Quality: already 0-100
  const regimeQuality = Math.min(100, Math.max(0, regimeScore));

  // 4. HTF Alignment: aligned → scale by signal magnitude, opposed → hard 0
  const htfAlignment = htfAligned
    ? Math.min(100, (Math.abs(signalScore) / 100) * 100)
    : 0;

  // 5. MTF Structure: scale by number of passed checks
  const mtfStructure = scaleCheckCount(mtfPassedChecks.length);

  // 6. LTF Trigger: scale by checks; if no intraday data, fallback to quality score
  const ltfTrigger = hasIntradayData
    ? scaleCheckCount(ltfPassedChecks.length)
    : Math.min(100, Math.max(0, qualityScore));

  // --- Weighted sum ---
  const totalWeight =
    CONFIG.READINESS_WEIGHT_SIGNAL +
    CONFIG.READINESS_WEIGHT_CONFIDENCE +
    CONFIG.READINESS_WEIGHT_REGIME +
    CONFIG.READINESS_WEIGHT_HTF +
    CONFIG.READINESS_WEIGHT_MTF +
    CONFIG.READINESS_WEIGHT_LTF;

  const weightedSum =
    signalStrength * CONFIG.READINESS_WEIGHT_SIGNAL +
    confidence * CONFIG.READINESS_WEIGHT_CONFIDENCE +
    regimeQuality * CONFIG.READINESS_WEIGHT_REGIME +
    htfAlignment * CONFIG.READINESS_WEIGHT_HTF +
    mtfStructure * CONFIG.READINESS_WEIGHT_MTF +
    ltfTrigger * CONFIG.READINESS_WEIGHT_LTF;

  const readinessScore = round3(weightedSum / totalWeight);
  const readinessLevel = classifyReadinessLevel(readinessScore);

  const scoreBreakdown: ReadinessScoreBreakdown = {
    signalStrength: round3(signalStrength),
    confidence: round3(confidence),
    regimeQuality: round3(regimeQuality),
    htfAlignment: round3(htfAlignment),
    mtfStructure: round3(mtfStructure),
    ltfTrigger: round3(ltfTrigger),
  };

  // --- Human-readable reasoning ---
  const parts: string[] = [
    `Signal=${round3(signalStrength)}(w${CONFIG.READINESS_WEIGHT_SIGNAL})`,
    `Conf=${round3(confidence)}(w${CONFIG.READINESS_WEIGHT_CONFIDENCE})`,
    `Regime=${round3(regimeQuality)}(w${CONFIG.READINESS_WEIGHT_REGIME})`,
    `HTF=${round3(htfAlignment)}(w${CONFIG.READINESS_WEIGHT_HTF})${htfAligned ? "" : "[opposed]"}`,
    `MTF=${round3(mtfStructure)}(w${CONFIG.READINESS_WEIGHT_MTF})[${mtfPassedChecks.length} checks]`,
    `LTF=${round3(ltfTrigger)}(w${CONFIG.READINESS_WEIGHT_LTF})${hasIntradayData ? `[${ltfPassedChecks.length} checks]` : "[fallback:quality]"}`,
  ];
  const reasoning = `Readiness ${readinessScore} (${readinessLevel}): ${parts.join(", ")}`;

  return {
    readinessScore,
    readinessLevel,
    scoreBreakdown,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// 9.6 Signal invalidation engine
// ---------------------------------------------------------------------------

/**
 * Severity rank for invalidation types (lower = more severe).
 * Used to determine the primary invalidation type when multiple fire.
 */
const INVALIDATION_SEVERITY: Record<InvalidationType, number> = {
  HTF_SHIFT: 0,
  PRICE: 1,
  MOMENTUM: 2,
  READINESS: 3,
  TIME: 4,
};

/**
 * Check whether a pending signal should be invalidated.
 *
 * Evaluates five independent invalidation rules in parallel, collects
 * ALL that fire, and returns the highest-severity one as primary.
 *
 * Rules (spec MVP):
 *   A. Price — LONG invalidated by lower low, SHORT by higher high
 *   B. Momentum — delta reversal against signal direction
 *   C. HTF Bias Shift — weekly sentiment flipped against direction
 *   D. Time Expiry — unconfirmed beyond INVALIDATION_MAX_BARS
 *   E. Readiness Decay — readiness below threshold for sustained period
 *
 * @param pending         Current pending confirmation state
 * @param bar             Current weekly bar (OHLC)
 * @param signalScore     Current bar's signal score (for HTF bias check)
 * @param currentDelta    Current bar's sentiment delta
 * @param readinessScore  Current bar's readiness score (0–100, or null if not computed)
 */
function checkSignalInvalidation(
  pending: PendingConfirmation,
  bar: WeeklyBar,
  signalScore: number,
  currentDelta: number,
  readinessScore: number | null,
): SignalInvalidationResult {
  const firedReasons: string[] = [];
  const firedTypes: InvalidationType[] = [];

  // --- A. Price-Based Invalidation ---
  // SHORT: price makes higher high relative to signal origin → invalidate
  // LONG: price makes lower low relative to signal origin → invalidate
  if (pending.direction === "SHORT" && pending.highSinceTrigger > pending.triggerPrice) {
    firedReasons.push(
      `Price made higher high (${round3(pending.highSinceTrigger)}) above signal origin (${round3(pending.triggerPrice)}) after bearish signal`,
    );
    firedTypes.push("PRICE");
  } else if (pending.direction === "LONG" && pending.lowSinceTrigger < pending.triggerPrice) {
    firedReasons.push(
      `Price made lower low (${round3(pending.lowSinceTrigger)}) below signal origin (${round3(pending.triggerPrice)}) after bullish signal`,
    );
    firedTypes.push("PRICE");
  }

  // --- B. Momentum Reversal ---
  // SHORT: momentum turns strongly positive → invalidate
  // LONG: momentum turns strongly negative → invalidate
  const momentumThreshold = CONFIG.INVALIDATION_MOMENTUM_THRESHOLD;
  if (pending.direction === "SHORT" && currentDelta > momentumThreshold) {
    firedReasons.push(
      `Momentum reversed strongly positive (delta=${round3(currentDelta)} > ${momentumThreshold}) against SHORT signal`,
    );
    firedTypes.push("MOMENTUM");
  } else if (pending.direction === "LONG" && currentDelta < -momentumThreshold) {
    firedReasons.push(
      `Momentum reversed strongly negative (delta=${round3(currentDelta)} < -${momentumThreshold}) against LONG signal`,
    );
    firedTypes.push("MOMENTUM");
  }

  // --- C. HTF Bias Shift ---
  // If weekly sentiment flips against signal direction → immediate invalidation
  const htf = checkHTFAlignment(pending.direction, signalScore);
  if (!htf.aligned && htf.bias !== "NEUTRAL") {
    firedReasons.push(
      `HTF sentiment shifted to ${htf.bias}, opposing ${pending.direction} signal`,
    );
    firedTypes.push("HTF_SHIFT");
  }

  // --- D. Time-Based Expiry ---
  if (pending.barsWaited >= CONFIG.INVALIDATION_MAX_BARS) {
    firedReasons.push(
      `Signal unconfirmed for ${pending.barsWaited} bars (max=${CONFIG.INVALIDATION_MAX_BARS})`,
    );
    firedTypes.push("TIME");
  }

  // --- E. Readiness Decay ---
  if (readinessScore !== null && readinessScore < CONFIG.INVALIDATION_READINESS_THRESHOLD) {
    if (pending.lowReadinessBars >= CONFIG.INVALIDATION_READINESS_MIN_BARS) {
      firedReasons.push(
        `Readiness score (${round3(readinessScore)}) below ${CONFIG.INVALIDATION_READINESS_THRESHOLD} for ${pending.lowReadinessBars + 1} consecutive bars`,
      );
      firedTypes.push("READINESS");
    }
  }

  // No invalidation fired
  if (firedTypes.length === 0) {
    return {
      isInvalidated: false,
      invalidationReason: "",
      invalidationType: null,
      allReasons: [],
      allTypes: [],
    };
  }

  // Sort fired types by severity (highest first)
  const sortedTypes = [...firedTypes].sort(
    (a, b) => INVALIDATION_SEVERITY[a] - INVALIDATION_SEVERITY[b],
  );

  const primaryType = sortedTypes[0];
  const primaryIdx = firedTypes.indexOf(primaryType);

  return {
    isInvalidated: true,
    invalidationReason: firedReasons[primaryIdx],
    invalidationType: primaryType,
    allReasons: firedReasons,
    allTypes: sortedTypes,
  };
}

// ---------------------------------------------------------------------------
// 10. Trade simulation with position management + risk layer + dynamic sizing
// ---------------------------------------------------------------------------

/**
 * Open position state tracked during simulation.
 */
interface OpenPosition {
  entryDate: string;
  entryPrice: number;
  entryScore: number;
  direction: "LONG" | "SHORT";
  signal: "BUY" | "SELL";
  stage: SignalStage;
  weeksHeld: number;
  /** Best price reached in the trade's favour (high for LONG, low for SHORT). */
  peakPrice: number;
  /** Whether the break-even stop upgrade has activated. */
  breakevenActivated: boolean;
  /** Running max favorable excursion (%). */
  mfe: number;
  /** Running max adverse excursion (%, stored as negative). */
  mae: number;
  /** Position size as fraction of equity at entry. */
  positionSize: number;
  /** Capital allocated to this trade. */
  capitalAllocated: number;
  /** Trade quality confidence score at entry (0–100). */
  qualityScore: number;
  /** Market regime at entry. */
  regimeType: RegimeType;
  /** Market regime favourability score at entry (0–100). */
  regimeScore: number;
  /** Number of confirmation bars waited before entry. */
  confirmationBarsWaited: number;
  /** Number of confirmation checks that passed on the confirming bar. */
  confirmationChecksPassed: number;
  /** Labels of the confirmation checks that passed. */
  confirmationPassedChecks: string[];
  /** Timeframes aligned at confirmation (subset of HTF/MTF/LTF). */
  mtfAlignedTimeframes: string[];
  /** MTF confirmations still missing on confirming/last evaluated bar. */
  mtfMissingConfirmations: string[];
  /** Trade readiness score at confirmation (0–100). */
  readinessScore: number;
  /** Trade readiness level at confirmation. */
  readinessLevel: ReadinessLevel;
  /** Per-component readiness sub-scores at confirmation. */
  readinessBreakdown: ReadinessScoreBreakdown;
  /** Position sizing tier at confirmation. */
  sizingTier: SizingTier;
  /** Human-readable reasoning for position sizing decision. */
  sizingReasoning: string;
  /** Risk percent allocated to this trade. */
  riskPercent: number;
}

/**
 * Pending confirmation state tracked across simulation bars.
 *
 * Created when a signal passes the quality + regime gates but has not
 * yet been confirmed by price action. Persists until either:
 *   - Confirmation conditions are met → promote to OpenPosition
 *   - Expiry (CONFIRM_EXPIRY_BARS elapsed) → discard
 *   - Invalidation (price moves strongly against direction) → discard
 */
interface PendingConfirmation {
  /** Date when the signal first triggered the pending state. */
  triggerDate: string;
  /** Price at the time the signal triggered. */
  triggerPrice: number;
  /** Signal score at trigger. */
  triggerScore: number;
  /** Trade direction inferred from signal. */
  direction: "LONG" | "SHORT";
  /** Raw signal direction. */
  signal: "BUY" | "SELL";
  /** Execution stage at trigger. */
  stage: SignalStage;
  /** Number of bars waited so far (incremented each bar). */
  barsWaited: number;
  /** Trade quality confidence score at trigger (0–100). */
  qualityScore: number;
  /** Market regime at trigger. */
  regimeType: RegimeType;
  /** Market regime favourability score at trigger (0–100). */
  regimeScore: number;
  /** Replay result from the triggering bar (for delta reference). */
  triggerDelta: number;
  /** Signal confidence at trigger (0–100, from signal engine). */
  signalConfidence: number;
  /** Highest bar high observed since trigger (for price invalidation). */
  highSinceTrigger: number;
  /** Lowest bar low observed since trigger (for price invalidation). */
  lowSinceTrigger: number;
  /** Count of consecutive bars where readiness remained below threshold. */
  lowReadinessBars: number;
}

/**
 * Check if a signal qualifies for entry.
 *
 * Entry requires:
 *   - CONFIRMATION stage
 *   - |score| >= CONFIG.ENTRY_THRESHOLD (60)
 *   - Direction is BUY or SELL (not NEUTRAL/CAUTION)
 *   - If CONFIG.USE_TREND_FILTER: price must align with SMA
 *     (LONG only if price > SMA, SHORT only if price < SMA)
 */
function isValidEntry(
  replay: ReplayResult,
  currentPrice: number,
  sma: number | null,
): boolean {
  if (replay.stage !== "CONFIRMATION") return false;
  if (Math.abs(replay.score) < CONFIG.ENTRY_THRESHOLD) return false;
  if (replay.direction !== "BUY" && replay.direction !== "SELL") return false;

  // SMA trend filter (toggleable)
  if (CONFIG.USE_TREND_FILTER && sma !== null) {
    if (replay.direction === "BUY" && currentPrice <= sma) return false;
    if (replay.direction === "SELL" && currentPrice >= sma) return false;
  }

  return true;
}

/**
 * Check signal-based exit conditions for an open position.
 *
 * These are checked AFTER risk exits (stop loss, trailing stop) and
 * only after MIN_HOLD_WEEKS have elapsed.
 *
 * Priority:
 *   1. Strong opposite signal (score + delta confirmation)
 *   2. Hysteresis decay (direction-aware)
 *   3. Max holding period
 */
function checkSignalExit(
  position: OpenPosition,
  replay: ReplayResult,
): ExitReason | null {
  // Enforce minimum holding period — no signal exit before MIN_HOLD_WEEKS
  if (position.weeksHeld < CONFIG.MIN_HOLD_WEEKS) return null;

  // 1. Strong opposite signal (score + delta confirmation)
  if (position.direction === "LONG") {
    if (replay.score <= -CONFIG.ENTRY_THRESHOLD && replay.delta < 0) {
      return "strong_opposite";
    }
  } else {
    if (replay.score >= CONFIG.ENTRY_THRESHOLD && replay.delta > 0) {
      return "strong_opposite";
    }
  }

  // 2. Hysteresis decay (direction-aware thresholds)
  if (position.direction === "LONG") {
    if (replay.score <= CONFIG.EXIT_THRESHOLD) {
      return "hysteresis";
    }
  } else {
    if (replay.score >= -CONFIG.EXIT_THRESHOLD) {
      return "hysteresis";
    }
  }

  // 3. Max holding period safety cap
  if (position.weeksHeld >= CONFIG.MAX_HOLD_WEEKS) return "max_hold";

  return null;
}

/**
 * Update position tracking fields (peak price, MFE, MAE, breakeven)
 * using the current week's bar data.
 */
function updatePositionTracking(
  position: OpenPosition,
  bar: WeeklyBar,
): void {
  if (position.direction === "LONG") {
    // Track highest price (favourable for LONG)
    if (bar.high > position.peakPrice) {
      position.peakPrice = bar.high;
    }
    // MFE: best unrealised gain
    const currentMfe = unrealisedPnl("LONG", position.entryPrice, bar.high);
    if (currentMfe > position.mfe) {
      position.mfe = currentMfe;
    }
    // MAE: worst unrealised drawdown
    const currentMae = unrealisedPnl("LONG", position.entryPrice, bar.low);
    if (currentMae < position.mae) {
      position.mae = currentMae;
    }
  } else {
    // SHORT: track lowest price (favourable)
    if (bar.low < position.peakPrice) {
      position.peakPrice = bar.low;
    }
    // MFE for SHORT: best gain when price drops
    const currentMfe = unrealisedPnl("SHORT", position.entryPrice, bar.low);
    if (currentMfe > position.mfe) {
      position.mfe = currentMfe;
    }
    // MAE for SHORT: worst loss when price rises
    const currentMae = unrealisedPnl("SHORT", position.entryPrice, bar.high);
    if (currentMae < position.mae) {
      position.mae = currentMae;
    }
  }

  // Check breakeven activation
  if (!position.breakevenActivated) {
    const bestPnl = position.mfe;
    if (bestPnl >= CONFIG.BREAKEVEN_ACTIVATION_PCT) {
      position.breakevenActivated = true;
    }
  }
}

/**
 * Close a position and produce a TradeResult.
 */
function closePosition(
  position: OpenPosition,
  exitDate: string,
  exitPrice: number,
  exitScore: number,
  exitReason: ExitReason,
): TradeResult {
  let returnPct: number;
  if (position.direction === "LONG") {
    returnPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  } else {
    returnPct = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
  }

  const pnlContribution = position.capitalAllocated * (returnPct / 100);

  return {
    entryDate: position.entryDate,
    exitDate,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice,
    entryScore: position.entryScore,
    exitScore,
    holdingWeeks: position.weeksHeld,
    returnPct: round3(returnPct),
    exitReason,
    stage: position.stage,
    signal: position.signal,
    mfe: round3(position.mfe),
    mae: round3(position.mae),
    peakPrice: round3(position.peakPrice),
    positionSize: round3(position.positionSize),
    capitalAllocated: round3(position.capitalAllocated),
    pnlContribution: round3(pnlContribution),
    qualityScore: round3(position.qualityScore),
    regimeType: position.regimeType,
    regimeScore: round3(position.regimeScore),
    confirmationBarsWaited: position.confirmationBarsWaited,
    confirmationChecksPassed: position.confirmationChecksPassed,
    confirmationPassedChecks: position.confirmationPassedChecks,
    mtfAlignedTimeframes: position.mtfAlignedTimeframes,
    readinessScore: round3(position.readinessScore),
    readinessLevel: position.readinessLevel,
    readinessBreakdown: position.readinessBreakdown,
    sizingTier: position.sizingTier,
    sizingReasoning: position.sizingReasoning,
    riskPercent: round3(position.riskPercent),
  };
}

/**
 * Simulate trades with production-grade position and risk management,
 * dynamic position sizing via Kelly Criterion + ATR volatility scaling,
 * pre-trade quality gate, market regime detection, and multi-timeframe
 * trade confirmation layer.
 *
 * Entry pipeline (per bar):
 *   1. Check pending confirmation state FIRST (before new signals)
 *      - If CONFIRMED → open position at current bar's close
 *      - If REJECTED (expired) → discard pending, allow new signals
 *   2. If no position and no pending:
 *      - Evaluate signal (CONFIRMATION stage + |score| >= 60 + SMA filter)
 *      - Trade Quality Gate (4 filters)
 *      - Market Regime Gate (3 filters)
 *      - If all pass → create PendingConfirmation (NOT immediate entry)
 *
 * Position sizing:
 *   - Kelly Criterion from rolling 20-trade window (quarter-Kelly)
 *   - ATR-based volatility scaling (14-period, 1% target risk)
 *   - Default 10% until 10 trades completed
 *   - Clamped to [5%, 25%] of equity
 *   - Computed at confirmation time (not trigger time)
 *
 * Exit priority per bar:
 *   1. Stop loss (hard or break-even upgraded)
 *   2. Trailing stop
 *   3. Strong opposite signal
 *   4. Hysteresis decay
 *   5. Max hold
 */
export function simulateTrades(
  cotHistory: CotHistoryPoint[],
  priceMap: Map<string, PricePoint>,
  weeklyBars: Map<string, WeeklyBar>,
  intradayBarMap: Map<string, OhlcBar[]>,
): TradeResult[] {
  const trades: TradeResult[] = [];
  let position: OpenPosition | null = null;
  let equity = CONFIG.STARTING_EQUITY;

  // Collect ordered prices for SMA calculation (indexed by COT week)
  const priceHistory: number[] = [];

  // Build ordered bars array for ATR calculation (parallel to loop index)
  const orderedBars: WeeklyBar[] = [];

  // Rolling signal scores for regime sentiment trend detection
  const scoreHistory: number[] = [];

  // Pending confirmation state — persists across bars until confirmed/rejected
  let pending: PendingConfirmation | null = null;

  for (let i = 1; i < cotHistory.length; i++) {
    const point = cotHistory[i];
    const prevPoint = cotHistory[i - 1];

    // Need price for this week and previous week
    const currentPricePoint = priceMap.get(point.date);
    const prevPricePoint = priceMap.get(prevPoint.date);

    if (!currentPricePoint || !prevPricePoint) continue;

    // Get weekly bar for risk management
    const bar = weeklyBars.get(point.date);
    if (!bar) continue;

    // Build running price history for SMA (look-ahead-free)
    priceHistory.push(currentPricePoint.close);

    // Build ordered bars array for ATR (look-ahead-free)
    orderedBars.push(bar);
    const barIndex = orderedBars.length - 1;

    const replay = replayWeek(
      cotHistory,
      i,
      currentPricePoint.close,
      prevPricePoint.close,
    );

    if (!replay) continue;

    // Track scores for regime sentiment analysis (look-ahead-free)
    scoreHistory.push(replay.score);

    // Compute SMA for trend filter
    const sma = calculateSMA(priceHistory, CONFIG.TREND_MA_PERIOD);

    // --- Position open: check exit conditions ---
    if (position) {
      position.weeksHeld++;

      // Update tracking (MFE, MAE, peak, breakeven) BEFORE exit checks
      updatePositionTracking(position, bar);

      // --- Priority 1-2: Risk exits (fire regardless of hold period) ---
      const riskExit = checkRiskExit(
        position.direction,
        position.entryPrice,
        position.peakPrice,
        position.breakevenActivated,
        bar,
      );

      if (riskExit) {
        const trade = closePosition(
          position,
          bar.date,
          riskExit.exitPrice,
          replay.score,
          riskExit.reason,
        );
        trades.push(trade);
        equity += trade.pnlContribution;
        position = null;
      }

      // --- Priority 3-5: Signal exits (only after min hold) ---
      if (position) {
        const signalExit = checkSignalExit(position, replay);

        if (signalExit) {
          const trade = closePosition(
            position,
            currentPricePoint.date,
            currentPricePoint.close,
            replay.score,
            signalExit,
          );
          trades.push(trade);
          equity += trade.pnlContribution;
          position = null;
        }
      }

      // If position still open after all exit checks, skip entry logic
      if (position) continue;
    }

    // --- Pending confirmation: evaluate on each bar before checking new entries ---
    if (pending && !position) {
      pending.barsWaited++;

      // Update price tracking for invalidation (running high/low since trigger)
      pending.highSinceTrigger = Math.max(pending.highSinceTrigger, bar.high);
      pending.lowSinceTrigger = Math.min(pending.lowSinceTrigger, bar.low);

      // Compute a lightweight readiness score for invalidation decay check.
      // We use the trigger-time values since we haven't confirmed yet —
      // HTF alignment is checked via current signalScore in the invalidation.
      const intradayBars = intradayBarMap.get(point.date) ?? [];
      const pendingReadiness = computeTradeReadiness(
        pending.triggerScore,
        pending.signalConfidence,
        pending.regimeScore,
        checkHTFAlignment(pending.direction, replay.score).aligned,
        [], // no MTF checks passed yet
        [], // no LTF checks passed yet
        intradayBars.length > 0,
        pending.qualityScore,
      );

      // Track consecutive low-readiness bars
      if (pendingReadiness.readinessScore < CONFIG.INVALIDATION_READINESS_THRESHOLD) {
        pending.lowReadinessBars++;
      } else {
        pending.lowReadinessBars = 0; // Reset on recovery
      }

      // --- Signal Invalidation Engine: kill bad signals early ---
      const invalidation = checkSignalInvalidation(
        pending,
        bar,
        replay.score,
        replay.delta,
        pendingReadiness.readinessScore,
      );

      if (invalidation.isInvalidated) {
        pending = null; // Discard — invalidated signal
        continue;
      }

      const confirmation = evaluateMultiTimeframeConfirmation(
        pending,
        replay.score,
        priceHistory,
        orderedBars,
        barIndex,
        intradayBars,
        replay.delta,
        bar,
      );

      if (confirmation.confirmationStatus === "CONFIRMED") {
        // Promote pending to open position
        const direction = pending.direction;
        const signal = pending.signal;

        // Compute trade readiness score from all gating layers
        const readiness = computeTradeReadiness(
          pending.triggerScore,
          pending.signalConfidence,
          pending.regimeScore,
          confirmation.htfAligned,
          confirmation.mtfPassedChecks,
          confirmation.ltfPassedChecks,
          confirmation.hasIntradayData,
          pending.qualityScore,
        );

        // Legacy Kelly+ATR sizing (used as secondary input)
        const kellyFraction = computeKelly(trades);
        const atr = computeATR(orderedBars, barIndex);
        const legacyPosSize = computePositionSize(kellyFraction, atr, currentPricePoint.close);

        // Primary: readiness-driven position sizing
        const sizing = computeReadinessPositionSize(
          readiness.readinessScore,
          equity,
          legacyPosSize,
          atr,
          currentPricePoint.close,
        );

        // NO_TRADE tier: readiness too low — skip entry
        if (sizing.sizingTier === "NO_TRADE") {
          pending = null;
          continue;
        }

        position = {
          entryDate: currentPricePoint.date,
          entryPrice: currentPricePoint.close,
          entryScore: pending.triggerScore,
          direction,
          signal,
          stage: pending.stage,
          weeksHeld: 0,
          peakPrice: currentPricePoint.close,
          breakevenActivated: false,
          mfe: 0,
          mae: 0,
          positionSize: sizing.positionSize,
          capitalAllocated: sizing.capitalAllocated,
          qualityScore: pending.qualityScore,
          regimeType: pending.regimeType,
          regimeScore: pending.regimeScore,
          confirmationBarsWaited: pending.barsWaited,
          confirmationChecksPassed: confirmation.alignedTimeframes.length,
          confirmationPassedChecks: confirmation.alignedTimeframes.map(
            (timeframe) => `${timeframe.toLowerCase()}_aligned`,
          ),
          mtfAlignedTimeframes: confirmation.alignedTimeframes,
          mtfMissingConfirmations: confirmation.missingConfirmations,
          readinessScore: readiness.readinessScore,
          readinessLevel: readiness.readinessLevel,
          readinessBreakdown: readiness.scoreBreakdown,
          sizingTier: sizing.sizingTier,
          sizingReasoning: sizing.reasoning,
          riskPercent: sizing.riskPercent,
        };

        pending = null;
        continue; // Position opened — skip new entry check this bar
      }

      if (confirmation.confirmationStatus === "REJECTED") {
        pending = null; // Discard — expired without confirmation
      }
      // If still PENDING, keep waiting (pending persists to next bar)
    }

    // --- No position and no pending: check entry conditions ---
    if (!position && !pending && isValidEntry(replay, currentPricePoint.close, sma)) {
      // Trade Quality Gate: evaluate all 4 filters before creating pending
      const quality = evaluateTradeQuality(
        replay,
        orderedBars,
        barIndex,
        priceHistory,
        currentPricePoint.close,
      );

      if (!quality.isApproved) continue; // Gate: skip low-quality setups

      // Market Regime Gate: evaluate market conditions before creating pending
      const regime = detectMarketRegime(
        scoreHistory,
        orderedBars,
        barIndex,
        cotHistory,
        i,
      );

      if (!regime.isTradable) continue; // Gate: skip unfavourable regimes

      const direction: "LONG" | "SHORT" = replay.direction === "BUY" ? "LONG" : "SHORT";
      const signal: "BUY" | "SELL" = replay.direction as "BUY" | "SELL";

      // Create pending confirmation — do NOT open position immediately
      pending = {
        triggerDate: currentPricePoint.date,
        triggerPrice: currentPricePoint.close,
        triggerScore: replay.score,
        direction,
        signal,
        stage: replay.stage,
        barsWaited: 0,
        qualityScore: quality.confidenceScore,
        regimeType: regime.regimeType,
        regimeScore: regime.regimeScore,
        triggerDelta: replay.delta,
        signalConfidence: replay.signal.confidence,
        highSinceTrigger: bar.high,
        lowSinceTrigger: bar.low,
        lowReadinessBars: 0,
      };
    }
  }

  // If a position is still open at the end of history, close it
  if (position) {
    const lastPoint = cotHistory[cotHistory.length - 1];
    const lastPrice = priceMap.get(lastPoint.date);

    if (lastPrice) {
      const trade = closePosition(
        position,
        lastPrice.date,
        lastPrice.close,
        0, // No signal at end-of-data
        "end_of_data",
      );
      trades.push(trade);
      equity += trade.pnlContribution;
    }
  }

  return trades;
}

// ---------------------------------------------------------------------------
// 11. Metrics calculation (position-sizing-aware)
// ---------------------------------------------------------------------------

/**
 * Calculate performance metrics from a set of trade results.
 *
 * Returns zeroed metrics if no trades exist.
 */
export function calculateMetrics(trades: TradeResult[]): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgReturn: 0,
      avgWin: 0,
      avgLoss: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      totalReturn: 0,
      avgMfe: 0,
      avgMae: 0,
      avgPositionSize: 0,
      totalPnl: 0,
      finalEquity: CONFIG.STARTING_EQUITY,
      avgQualityScore: 0,
      avgRegimeScore: 0,
      avgConfirmationBars: 0,
      avgMtfTimeframesAligned: 0,
      avgReadinessScore: 0,
      avgRiskPercent: 0,
    };
  }

  const winTrades = trades.filter((t) => t.returnPct > 0);
  const lossTrades = trades.filter((t) => t.returnPct <= 0);

  const avgReturn = trades.reduce((sum, t) => sum + t.returnPct, 0) / trades.length;
  const avgWin = winTrades.length > 0
    ? winTrades.reduce((sum, t) => sum + t.returnPct, 0) / winTrades.length
    : 0;
  const avgLoss = lossTrades.length > 0
    ? lossTrades.reduce((sum, t) => sum + t.returnPct, 0) / lossTrades.length
    : 0;

  // MFE / MAE averages
  const avgMfe = trades.reduce((sum, t) => sum + t.mfe, 0) / trades.length;
  const avgMae = trades.reduce((sum, t) => sum + t.mae, 0) / trades.length;

  // Position sizing stats
  const avgPositionSize = trades.reduce((sum, t) => sum + t.positionSize, 0) / trades.length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlContribution, 0);

  // Quality score average
  const avgQualityScore = trades.reduce((sum, t) => sum + t.qualityScore, 0) / trades.length;

  // Regime score average
  const avgRegimeScore = trades.reduce((sum, t) => sum + t.regimeScore, 0) / trades.length;

  // Confirmation bars average
  const avgConfirmationBars = trades.reduce((sum, t) => sum + t.confirmationBarsWaited, 0) / trades.length;

  // Average number of aligned MTF timeframes per trade
  const avgMtfTimeframesAligned = trades.reduce(
    (sum, t) => sum + t.mtfAlignedTimeframes.length,
    0,
  ) / trades.length;

  // Average trade readiness score at entry
  const avgReadinessScore = trades.reduce(
    (sum, t) => sum + t.readinessScore,
    0,
  ) / trades.length;

  // Average risk percent allocated per trade
  const avgRiskPercent = trades.reduce(
    (sum, t) => sum + t.riskPercent,
    0,
  ) / trades.length;

  // Max drawdown: track equity with position-sized P&L contributions
  let equity: number = CONFIG.STARTING_EQUITY;
  let peak: number = CONFIG.STARTING_EQUITY;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += trade.pnlContribution;
    if (equity > peak) peak = equity;
    const drawdown = ((peak - equity) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const finalEquity = equity;

  // Compounded total return (based on actual equity, not flat %)
  const compoundedReturn = ((finalEquity - CONFIG.STARTING_EQUITY) / CONFIG.STARTING_EQUITY) * 100;

  // Sharpe ratio: mean / stddev of position-sized returns, annualized
  // Use portfolio-level returns: pnlContribution / equity-at-entry
  const portfolioReturns: number[] = [];
  let runningEquity = CONFIG.STARTING_EQUITY;
  for (const trade of trades) {
    const portReturn = runningEquity > 0 ? (trade.pnlContribution / runningEquity) * 100 : 0;
    portfolioReturns.push(portReturn);
    runningEquity += trade.pnlContribution;
  }

  const avgPortReturn = portfolioReturns.reduce((s, v) => s + v, 0) / portfolioReturns.length;
  const stddev = calculateStdDev(portfolioReturns);
  const tradesPerYear = Math.max(1, 52 / Math.max(1, averageHoldingWeeks(trades)));
  const sharpeRatio = stddev > 0
    ? (avgPortReturn / stddev) * Math.sqrt(tradesPerYear)
    : 0;

  return {
    totalTrades: trades.length,
    wins: winTrades.length,
    losses: lossTrades.length,
    winRate: round3((winTrades.length / trades.length) * 100),
    avgReturn: round3(avgReturn),
    avgWin: round3(avgWin),
    avgLoss: round3(avgLoss),
    maxDrawdown: round3(maxDrawdown),
    sharpeRatio: round3(sharpeRatio),
    totalReturn: round3(compoundedReturn),
    avgMfe: round3(avgMfe),
    avgMae: round3(avgMae),
    avgPositionSize: round3(avgPositionSize),
    totalPnl: round3(totalPnl),
    finalEquity: round3(finalEquity),
    avgQualityScore: round3(avgQualityScore),
    avgRegimeScore: round3(avgRegimeScore),
    avgConfirmationBars: round3(avgConfirmationBars),
    avgMtfTimeframesAligned: round3(avgMtfTimeframesAligned),
    avgReadinessScore: round3(avgReadinessScore),
    avgRiskPercent: round3(avgRiskPercent),
  };
}

/**
 * Compute mean holding period in weeks across trades.
 *
 * Returns 1 for empty arrays to avoid division by zero in annualisation.
 */
function averageHoldingWeeks(trades: TradeResult[]): number {
  if (trades.length === 0) return 1;
  const total = trades.reduce((sum, t) => sum + t.holdingWeeks, 0);
  return total / trades.length;
}

/**
 * Compute sample standard deviation for numeric arrays.
 *
 * Returns 0 when fewer than two values are present.
 */
function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Round a number to three decimal places.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 12. Breakdown by stage and score range
// ---------------------------------------------------------------------------

/**
 * Break down trade results by execution stage (SETUP/TRIGGER/CONFIRMATION).
 *
 * With the CONFIRMATION-only entry filter, all trades should be
 * CONFIRMATION stage. This breakdown is kept for validation and
 * future expansion if entry criteria are relaxed.
 */
export function breakdownByStage(trades: TradeResult[]): StageBreakdown[] {
  const stages: SignalStage[] = ["SETUP", "TRIGGER", "CONFIRMATION"];

  return stages
    .map((stage) => {
      const stageTrades = trades.filter((t) => t.stage === stage);
      return {
        stage,
        metrics: calculateMetrics(stageTrades),
        tradeCount: stageTrades.length,
      };
    })
    .filter((b) => b.tradeCount > 0);
}

/**
 * Score range definitions for breakdown.
 *
 * Strong: |score| >= 70 (highest conviction entries)
 * Medium: |score| 60-70  (above entry threshold)
 * Weak:   |score| < 60   (should not appear with ENTRY_THRESHOLD=60)
 *
 * Uses entry score for classification.
 */
const SCORE_RANGES = [
  { range: "strong", minScore: 70, maxScore: 101 },
  { range: "medium", minScore: 60, maxScore: 70 },
  { range: "weak", minScore: 0, maxScore: 60 },
] as const;

/**
 * Break down trade results by entry score magnitude.
 */
export function breakdownByScoreRange(trades: TradeResult[]): ScoreRangeBreakdown[] {
  return SCORE_RANGES
    .map((range) => {
      const rangeTrades = trades.filter((t) => {
        const absScore = Math.abs(t.entryScore);
        return absScore >= range.minScore && absScore < range.maxScore;
      });

      return {
        range: range.range,
        minScore: range.minScore,
        maxScore: range.maxScore,
        metrics: calculateMetrics(rangeTrades),
        tradeCount: rangeTrades.length,
      };
    })
    .filter((b) => b.tradeCount > 0);
}

// ---------------------------------------------------------------------------
// 13. Equity curve and win/loss distribution
// ---------------------------------------------------------------------------

/**
 * Build equity curve data points from trade results.
 *
 * Uses position-sized P&L contributions (not flat % returns) to track
 * actual portfolio equity over time. Starting equity is CONFIG.STARTING_EQUITY.
 */
export function buildEquityCurve(trades: TradeResult[]): EquityPoint[] {
  const curve: EquityPoint[] = [];
  let equity: number = CONFIG.STARTING_EQUITY;
  let peak: number = CONFIG.STARTING_EQUITY;

  // Starting point
  if (trades.length > 0) {
    curve.push({
      date: trades[0].entryDate,
      equity: CONFIG.STARTING_EQUITY,
      drawdown: 0,
    });
  }

  for (const trade of trades) {
    equity += trade.pnlContribution;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    curve.push({
      date: trade.exitDate,
      equity: round3(equity),
      drawdown: round3(drawdown),
    });
  }

  return curve;
}

/**
 * Build a histogram of trade returns for win/loss distribution.
 * Uses 1% buckets from -10% to +10%, with overflow buckets at the edges.
 */
export function buildDistribution(trades: TradeResult[]): WinLossDistribution[] {
  const BUCKET_SIZE = 1;
  const MIN_BUCKET = -10;
  const MAX_BUCKET = 10;

  // Initialize buckets
  const buckets: Map<string, number> = new Map();

  buckets.set(`< ${MIN_BUCKET}%`, 0);
  for (let i = MIN_BUCKET; i < MAX_BUCKET; i += BUCKET_SIZE) {
    buckets.set(`${i}% to ${i + BUCKET_SIZE}%`, 0);
  }
  buckets.set(`>= ${MAX_BUCKET}%`, 0);

  for (const trade of trades) {
    const ret = trade.returnPct;

    if (ret < MIN_BUCKET) {
      buckets.set(`< ${MIN_BUCKET}%`, (buckets.get(`< ${MIN_BUCKET}%`) ?? 0) + 1);
    } else if (ret >= MAX_BUCKET) {
      buckets.set(`>= ${MAX_BUCKET}%`, (buckets.get(`>= ${MAX_BUCKET}%`) ?? 0) + 1);
    } else {
      const bucketStart = Math.floor(ret / BUCKET_SIZE) * BUCKET_SIZE;
      const label = `${bucketStart}% to ${bucketStart + BUCKET_SIZE}%`;
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
    }
  }

  // Filter out empty buckets
  const distribution: WinLossDistribution[] = [];
  for (const [bucket, count] of buckets) {
    if (count > 0) {
      distribution.push({ bucket, count });
    }
  }

  return distribution;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full backtest with production-grade trade execution,
 * risk management, quality filtering, regime detection, and
 * multi-timeframe trade confirmation.
 *
 * 1. Fetch COT history, daily gold prices, and intraday 4h bars in parallel
 * 2. Build price-per-COT-date lookup map, weekly OHLC bars, and intraday week map
 * 3. Simulate trades: signal → quality gate → regime gate → MTF confirmation → execution
 * 4. Calculate metrics with breakdowns (including confirmation stats)
 * 5. Build visualization data (equity curve, distribution)
 *
 * Returns null if insufficient data is available.
 */
export async function runBacktest(): Promise<BacktestReport | null> {
  // Fetch data in parallel
  const [cotHistory, prices, intradayBars] = await Promise.all([
    fetchCotHistory(),
    fetchGoldPriceHistory(),
    fetchIntradayBars(),
  ]);

  if (cotHistory.length === 0) {
    console.error("Backtest: no COT history data available");
    return null;
  }

  if (prices.length === 0) {
    console.error("Backtest: no gold price history data available");
    return null;
  }

  // Build price map (close-only), weekly bars (synthesized OHLC), and intraday map
  const priceMap = buildPriceMap(cotHistory, prices);
  const weeklyBars = buildWeeklyBars(cotHistory, prices);
  const intradayBarMap = buildIntradayBarMap(cotHistory, intradayBars);

  if (priceMap.size < 2) {
    console.error(
      `Backtest: insufficient price-aligned data (${priceMap.size} weeks, need >= 2)`,
    );
    return null;
  }

  // Simulate trades with position + risk management
  const trades = simulateTrades(cotHistory, priceMap, weeklyBars, intradayBarMap);

  // Calculate summary metrics
  const summary = calculateMetrics(trades);

  // Breakdowns
  const byStage = breakdownByStage(trades);
  const byScoreRange = breakdownByScoreRange(trades);

  // Visualization data
  const equityCurve = buildEquityCurve(trades);
  const distribution = buildDistribution(trades);

  // Metadata
  const cotDatesWithPrices = cotHistory
    .filter((p) => priceMap.has(p.date))
    .map((p) => p.date);

  const startDate = cotDatesWithPrices[0] ?? "";
  const endDate = cotDatesWithPrices[cotDatesWithPrices.length - 1] ?? "";

  return {
    summary,
    byStage,
    byScoreRange,
    equityCurve,
    distribution,
    trades,
    metadata: {
      cotHistoryPoints: cotHistory.length,
      pricePoints: prices.length,
      weeksEvaluated: priceMap.size,
      startDate,
      endDate,
      generatedAt: new Date().toISOString(),
    },
  };
}
