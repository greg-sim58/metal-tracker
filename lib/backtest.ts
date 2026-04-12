// Backtesting engine for the gold sentiment model (v5)
//
// Replays the signal engine against historical COT data with a
// production-grade trade execution, risk management, and dynamic
// position sizing layer:
//
//   Entry:
//     - CONFIRMATION stage + |score| >= ENTRY_THRESHOLD (60)
//     - Optional SMA trend filter (LONG only above MA, SHORT below)
//     - Single position at a time (no overlapping trades)
//
//   Position Sizing:
//     - Kelly Criterion from rolling 20-trade window (quarter-Kelly)
//     - ATR-based volatility scaling (14-period, 1% target risk per trade)
//     - Default 10% sizing until 10 trades completed
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
//
//   Constraints:
//     - No same-bar exits (min hold = 2 weeks)
//     - Look-ahead-free: each week uses only data available at that time
//     - Deterministic: same input always produces same output

import type { CotReport } from "@/lib/cot";
import {
  fetchCotHistory,
  computePercentileMetrics,
  getWeeklyDeltas,
  calculateAcceleration,
} from "@/lib/cotHistory";
import type { CotHistoryPoint } from "@/lib/cotHistory";
import { generateSignal } from "@/lib/signals";
import type {
  Signal,
  SignalInput,
  PriceTrend,
  OpenInterestTrend,
  SignalDirection,
} from "@/lib/signals";
import { classifyExecution } from "@/lib/execution";
import type { SignalStage } from "@/lib/execution";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "hysteresis"
  | "strong_opposite"
  | "max_hold"
  | "end_of_data";

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
}

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
}

export interface StageBreakdown {
  stage: SignalStage;
  metrics: PerformanceMetrics;
  tradeCount: number;
}

export interface ScoreRangeBreakdown {
  range: string;            // "strong", "medium", "weak"
  minScore: number;
  maxScore: number;
  metrics: PerformanceMetrics;
  tradeCount: number;
}

export interface EquityPoint {
  date: string;
  equity: number;           // cumulative return starting at 100
  drawdown: number;         // current drawdown from peak (percent)
}

export interface WinLossDistribution {
  bucket: string;           // e.g. "-3% to -2%", "0% to 1%"
  count: number;
}

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

function determinePriceTrend(current: number, previous: number): PriceTrend {
  return current >= previous ? "up" : "down";
}

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
// 7. Trade simulation with position management + risk layer + dynamic sizing
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
  };
}

/**
 * Simulate trades with production-grade position and risk management,
 * and dynamic position sizing via Kelly Criterion + ATR volatility scaling.
 *
 * Rules:
 *   - Single position at a time (no overlapping trades)
 *   - Entry: CONFIRMATION stage + |score| >= 60 + optional SMA filter
 *   - Risk exits checked every bar: stop loss → trailing stop
 *   - Signal exits checked after risk: strong opposite → hysteresis → max hold
 *   - Minimum hold: 2 weeks (for signal exits; stops fire anytime)
 *   - BUY -> LONG, SELL -> SHORT (never both)
 *
 * Position sizing:
 *   - Kelly Criterion from rolling 20-trade window (quarter-Kelly)
 *   - ATR-based volatility scaling (14-period, 1% target risk)
 *   - Default 10% until 10 trades completed
 *   - Clamped to [5%, 25%] of equity
 *   - Equity updated dynamically after each trade
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
): TradeResult[] {
  const trades: TradeResult[] = [];
  let position: OpenPosition | null = null;
  let equity = CONFIG.STARTING_EQUITY;

  // Collect ordered prices for SMA calculation (indexed by COT week)
  const priceHistory: number[] = [];

  // Build ordered bars array for ATR calculation (parallel to loop index)
  const orderedBars: WeeklyBar[] = [];

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

    // --- No position: check entry conditions ---
    if (isValidEntry(replay, currentPricePoint.close, sma)) {
      const direction: "LONG" | "SHORT" = replay.direction === "BUY" ? "LONG" : "SHORT";
      const signal: "BUY" | "SELL" = replay.direction as "BUY" | "SELL";

      // Compute dynamic position size
      const kellyFraction = computeKelly(trades);
      const atr = computeATR(orderedBars, barIndex);
      const posSize = computePositionSize(kellyFraction, atr, currentPricePoint.close);
      const capitalAllocated = equity * posSize;

      position = {
        entryDate: currentPricePoint.date,
        entryPrice: currentPricePoint.close,
        entryScore: replay.score,
        direction,
        signal,
        stage: replay.stage,
        weeksHeld: 0,
        peakPrice: currentPricePoint.close,
        breakevenActivated: false,
        mfe: 0,
        mae: 0,
        positionSize: posSize,
        capitalAllocated,
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
// 8. Metrics calculation (position-sizing-aware)
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
  };
}

function averageHoldingWeeks(trades: TradeResult[]): number {
  if (trades.length === 0) return 1;
  const total = trades.reduce((sum, t) => sum + t.holdingWeeks, 0);
  return total / trades.length;
}

function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 9. Breakdown by stage and score range
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
// 10. Equity curve and win/loss distribution
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
 * Run the full backtest with production-grade trade execution and
 * risk management.
 *
 * 1. Fetch COT history and gold price history in parallel
 * 2. Build price-per-COT-date lookup map and weekly OHLC bars
 * 3. Simulate trades with hysteresis thresholds, SMA filter, and stops
 * 4. Calculate metrics with breakdowns (including MFE/MAE)
 * 5. Build visualization data (equity curve, distribution)
 *
 * Returns null if insufficient data is available.
 */
export async function runBacktest(): Promise<BacktestReport | null> {
  // Fetch data in parallel
  const [cotHistory, prices] = await Promise.all([
    fetchCotHistory(),
    fetchGoldPriceHistory(),
  ]);

  if (cotHistory.length === 0) {
    console.error("Backtest: no COT history data available");
    return null;
  }

  if (prices.length === 0) {
    console.error("Backtest: no gold price history data available");
    return null;
  }

  // Build price map (close-only) and weekly bars (synthesized OHLC)
  const priceMap = buildPriceMap(cotHistory, prices);
  const weeklyBars = buildWeeklyBars(cotHistory, prices);

  if (priceMap.size < 2) {
    console.error(
      `Backtest: insufficient price-aligned data (${priceMap.size} weeks, need >= 2)`,
    );
    return null;
  }

  // Simulate trades with position + risk management
  const trades = simulateTrades(cotHistory, priceMap, weeklyBars);

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
