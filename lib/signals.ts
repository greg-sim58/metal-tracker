// Trading signal engine — weighted composite scoring model
//
// Replaces ad-hoc conditional logic with a unified scoring system that:
//   1. Scores each component independently on a -1 to +1 scale
//   2. Applies calibrated weights to each component
//   3. Produces a composite score (-100 to +100)
//   4. Maps the score to a signal direction with agreement-based confidence
//
// Core principle: when managed money (large speculators) are extremely
// positioned in one direction, the trade is crowded and likely to reverse.
// Commercials (producers/merchants) are "smart money" — their positioning
// confirms or contradicts the speculator signal.
//
// Scoring components:
//   - COT positioning (contrarian, percentile-based, commercials-adjusted)
//   - Delta (weekly positioning change, graduated thresholds)
//   - Acceleration (rate of change of delta, second derivative)
//   - Open interest (price + OI trend confirmation)
//   - Price trend (directional bias)

import type { CotReport } from "@/lib/cot";
import type {
  PercentileMetrics,
  PositioningDeltas,
  PositioningAcceleration,
} from "@/lib/cotHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "NEUTRAL" | "CAUTION";

export interface ScoreBreakdown {
  cotPositioning: number;   // -1 to +1
  delta: number;            // -1 to +1
  acceleration: number;     // -1 to +1
  openInterest: number;     // -1 to +1
  priceTrend: number;       // -1 to +1
}

export interface SignalMetrics {
  managedMoneyPercentile: number;
  commercialsPercentile: number;
  managedMoneyDelta: number;
  commercialsDelta: number;
  acceleration: number;
  historyLength: number;
  oldestDate: string;
  newestDate: string;
}

export interface Signal {
  signal: SignalDirection;
  confidence: number;       // 0–100
  score: number;            // -100 to +100 composite
  breakdown: ScoreBreakdown;
  reasoning: string[];
  metrics: SignalMetrics | null;
}

export interface OpenInterestTrend {
  current: number;
  previous: number;
  trend: "up" | "down";
}

export type PriceTrend = "up" | "down";

export interface SignalInput {
  priceTrend: PriceTrend;
  oiTrend: OpenInterestTrend;
  cotData: CotReport;
  percentiles: PercentileMetrics | null;
  deltas: PositioningDeltas | null;
  acceleration: PositioningAcceleration | null;
}

// ---------------------------------------------------------------------------
// Component weights
// ---------------------------------------------------------------------------

/**
 * Relative importance of each scoring component.
 *
 * COT positioning is the primary contrarian indicator.
 * Delta captures the flow (who is moving), often leading price.
 * Acceleration, OI, and price trend are confirming/modifying factors.
 */
const WEIGHTS = {
  cotPositioning: 25,
  delta: 30,
  acceleration: 15,
  openInterest: 15,
  priceTrend: 15,
} as const;

/** Sum of all weights — used to normalize the composite score. */
const TOTAL_WEIGHT =
  WEIGHTS.cotPositioning +
  WEIGHTS.delta +
  WEIGHTS.acceleration +
  WEIGHTS.openInterest +
  WEIGHTS.priceTrend;

// ---------------------------------------------------------------------------
// Percentile thresholds (COT positioning)
// ---------------------------------------------------------------------------

/**
 * Percentile bands for contrarian positioning analysis.
 *
 * EXTREME (90/10): highly crowded — strong contrarian signal.
 * ELEVATED (75/25): noteworthy positioning — moderate signal.
 * Values between 25–75 are considered normal range.
 */
const PERCENTILE_EXTREME_HIGH = 90;
const PERCENTILE_HIGH = 75;
const PERCENTILE_LOW = 25;
const PERCENTILE_EXTREME_LOW = 10;

// ---------------------------------------------------------------------------
// Delta thresholds (contracts/week)
// ---------------------------------------------------------------------------

/**
 * Calibrated against typical gold futures weekly moves
 * (average weekly |delta| ≈ 5,000–10,000 contracts).
 *
 * STRONG: Large directional flow that dominates the signal.
 * MODERATE: Meaningful flow that should influence the score.
 *
 * Negative deltas indicate funds reducing longs / adding shorts.
 */
const DELTA_STRONG_BULLISH = 20_000;
const DELTA_MODERATE_BULLISH = 10_000;
const DELTA_MODERATE_BEARISH = -10_000;
const DELTA_STRONG_BEARISH = -20_000;

// ---------------------------------------------------------------------------
// Acceleration thresholds (contracts/week²)
// ---------------------------------------------------------------------------

/**
 * Second derivative of weekly positioning delta.
 * Typical values are much smaller than first-order deltas.
 *
 * STRONG: Momentum clearly shifting direction.
 * MODERATE: Noticeable change in buying/selling pressure.
 */
const ACCEL_STRONG = 8_000;
const ACCEL_MODERATE = 3_000;

// ---------------------------------------------------------------------------
// OI context
// ---------------------------------------------------------------------------

/**
 * Open interest absolute levels for liquidity context.
 * Below OI_LOW, all signals are less reliable (thin market).
 */
const OI_HIGH = 300_000;
const OI_LOW = 200_000;

// ---------------------------------------------------------------------------
// Signal mapping thresholds
// ---------------------------------------------------------------------------

/**
 * Composite score ranges mapped to signal directions.
 * Scores closer to zero produce NEUTRAL; extreme scores produce BUY/SELL.
 *
 * |score| >= STRONG → BUY or SELL (high conviction)
 * |score| >= MODERATE → CAUTION (developing trend, watch closely)
 * |score| < MODERATE → NEUTRAL (no actionable signal)
 */
const SIGNAL_THRESHOLD_STRONG = 40;
const SIGNAL_THRESHOLD_MODERATE = 15;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Linearly interpolate a value between two thresholds to a 0–1 output range.
 * Values below the lower threshold return 0; above the upper return 1.
 * Used to graduate scores smoothly instead of binary 0/1 jumps.
 */
function lerp(value: number, lower: number, upper: number): number {
  if (value <= lower) return 0;
  if (value >= upper) return 1;
  return (value - lower) / (upper - lower);
}

/**
 * Return the ordinal suffix for a number (st, nd, rd, th).
 */
function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  const mod10 = n % 10;
  if (mod10 === 1) return "st";
  if (mod10 === 2) return "nd";
  if (mod10 === 3) return "rd";
  return "th";
}

function formatPercentile(percentile: number): string {
  return `${percentile}${ordinalSuffix(percentile)} percentile`;
}

// ---------------------------------------------------------------------------
// 1. COT Positioning Score (contrarian, with commercials modifier)
// ---------------------------------------------------------------------------

interface ComponentResult {
  score: number;   // -1 to +1
  reasons: string[];
}

/**
 * Score managed money positioning using a contrarian model.
 *
 * High percentile → bearish (crowded long → expect reversion)
 * Low percentile → bullish (depressed → expect recovery)
 *
 * Commercials (smart money) act as a modifier:
 *   - Commercials confirming the contrarian signal amplify the score
 *   - Commercials diverging dampen the score
 *
 * Returns 0 when percentile data is unavailable (graceful fallback).
 */
function scoreCotPositioning(
  cot: CotReport,
  percentiles: PercentileMetrics | null,
): ComponentResult {
  const reasons: string[] = [];

  if (!percentiles) {
    reasons.push(
      "Historical data unavailable — percentile scoring disabled, defaulting to neutral",
    );
    return { score: 0, reasons };
  }

  const mmPct = percentiles.managedMoneyPercentile;
  const cmPct = percentiles.commercialsPercentile;
  const managedNet = cot.largeSpeculators.net;
  const commercialNet = cot.commercials.net;

  let baseScore = 0;

  // Bearish zone (contrarian): high managed money percentile → sell signal
  if (mmPct >= PERCENTILE_EXTREME_HIGH) {
    // Interpolate from -0.5 at 90th to -1.0 at 100th
    baseScore = -(0.5 + 0.5 * lerp(mmPct, PERCENTILE_EXTREME_HIGH, 100));
    reasons.push(
      `Managed money at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — crowded long trade`,
    );
  } else if (mmPct >= PERCENTILE_HIGH) {
    // Interpolate from 0 at 75th to -0.5 at 90th
    baseScore = -0.5 * lerp(mmPct, PERCENTILE_HIGH, PERCENTILE_EXTREME_HIGH);
    reasons.push(
      `Managed money at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — elevated positioning`,
    );
  } else if (mmPct <= PERCENTILE_EXTREME_LOW) {
    // Interpolate from +0.5 at 10th to +1.0 at 0th
    baseScore = 0.5 + 0.5 * lerp(PERCENTILE_EXTREME_LOW - mmPct, 0, PERCENTILE_EXTREME_LOW);
    reasons.push(
      `Managed money at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — contrarian bullish`,
    );
  } else if (mmPct <= PERCENTILE_LOW) {
    // Interpolate from 0 at 25th to +0.5 at 10th
    baseScore = 0.5 * lerp(PERCENTILE_LOW - mmPct, 0, PERCENTILE_LOW - PERCENTILE_EXTREME_LOW);
    reasons.push(
      `Managed money at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — depressed positioning`,
    );
  } else {
    reasons.push(
      `Managed money at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — normal range`,
    );
  }

  // Commercials modifier: smart money confirmation/divergence
  // If base is bearish (negative) and commercials are net short → confirms
  // If base is bullish (positive) and commercials are net long → confirms
  const commercialsConfirm =
    (baseScore < 0 && commercialNet < 0) ||
    (baseScore > 0 && commercialNet > 0);

  if (baseScore !== 0) {
    if (commercialsConfirm) {
      // Amplify by up to 20%
      baseScore *= 1.2;
      reasons.push(
        `Commercials ${commercialNet > 0 ? "net long" : "net short"} ` +
        `(${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — smart money confirms`,
      );
    } else if (commercialNet !== 0) {
      // Dampen by 20%
      baseScore *= 0.8;
      reasons.push(
        `Commercials ${commercialNet > 0 ? "net long" : "net short"} ` +
        `(${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — smart money diverges`,
      );
    }
  } else {
    reasons.push(
      `Commercials at ${formatPercentile(cmPct)} — net position: ${commercialNet.toLocaleString("en-US")}`,
    );
  }

  // Clamp to [-1, +1] after modifier
  const score = Math.max(-1, Math.min(1, baseScore));
  return { score, reasons };
}

// ---------------------------------------------------------------------------
// 2. Delta Score (weekly positioning change)
// ---------------------------------------------------------------------------

/**
 * Score the weekly change in managed money net positioning.
 *
 * Large positive delta → funds adding longs (bullish flow).
 * Large negative delta → funds liquidating longs / adding shorts (bearish flow).
 *
 * Graduated scoring with linear interpolation between moderate and strong
 * thresholds prevents binary jumps.
 *
 * Returns 0 when delta data is unavailable (< 2 weeks of history).
 */
function scoreDelta(
  deltas: PositioningDeltas | null,
): ComponentResult {
  const reasons: string[] = [];

  if (!deltas) {
    reasons.push("Insufficient history for delta analysis (need ≥ 2 weeks)");
    return { score: 0, reasons };
  }

  const mmDelta = deltas.managedMoney;
  const cmDelta = deltas.commercials;
  let score = 0;

  if (mmDelta >= DELTA_STRONG_BULLISH) {
    score = 1;
    reasons.push(
      `Managed money adding longs rapidly (+${mmDelta.toLocaleString("en-US")} contracts/week) — strong bullish flow`,
    );
  } else if (mmDelta >= DELTA_MODERATE_BULLISH) {
    score = lerp(mmDelta, DELTA_MODERATE_BULLISH, DELTA_STRONG_BULLISH);
    reasons.push(
      `Managed money adding longs (+${mmDelta.toLocaleString("en-US")} contracts/week) — bullish flow`,
    );
  } else if (mmDelta <= DELTA_STRONG_BEARISH) {
    score = -1;
    reasons.push(
      `Managed money liquidating longs (${mmDelta.toLocaleString("en-US")} contracts/week) — strong bearish flow`,
    );
  } else if (mmDelta <= DELTA_MODERATE_BEARISH) {
    score = -lerp(-mmDelta, -DELTA_MODERATE_BEARISH, -DELTA_STRONG_BEARISH);
    reasons.push(
      `Managed money reducing longs (${mmDelta.toLocaleString("en-US")} contracts/week) — bearish flow`,
    );
  } else {
    reasons.push(
      `Managed money delta modest (${mmDelta >= 0 ? "+" : ""}${mmDelta.toLocaleString("en-US")} contracts/week) — no strong flow signal`,
    );
  }

  // Annotate commercial flow for context (does not modify delta score —
  // commercials are already weighted in the COT positioning component)
  if (Math.abs(cmDelta) >= DELTA_MODERATE_BULLISH) {
    reasons.push(
      `Commercials: ${cmDelta >= 0 ? "+" : ""}${cmDelta.toLocaleString("en-US")} contracts/week`,
    );
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// 3. Acceleration Score (rate of change of delta)
// ---------------------------------------------------------------------------

/**
 * Score the acceleration of managed money positioning changes.
 *
 * Positive acceleration → buying pressure increasing (bullish momentum).
 * Negative acceleration → selling pressure increasing (bearish momentum).
 *
 * Graduated between moderate and strong thresholds.
 * Returns 0 when acceleration data is unavailable (< 3 weeks of history).
 */
function scoreAcceleration(
  acceleration: PositioningAcceleration | null,
): ComponentResult {
  const reasons: string[] = [];

  if (!acceleration) {
    reasons.push("Insufficient history for acceleration analysis (need ≥ 3 weeks)");
    return { score: 0, reasons };
  }

  const mmAccel = acceleration.managedMoney;
  let score = 0;

  if (mmAccel >= ACCEL_STRONG) {
    score = 1;
    reasons.push(
      `Buying momentum accelerating sharply (+${mmAccel.toLocaleString("en-US")} contracts/week\u00B2)`,
    );
  } else if (mmAccel >= ACCEL_MODERATE) {
    score = lerp(mmAccel, ACCEL_MODERATE, ACCEL_STRONG);
    reasons.push(
      `Buying momentum increasing (+${mmAccel.toLocaleString("en-US")} contracts/week\u00B2)`,
    );
  } else if (mmAccel <= -ACCEL_STRONG) {
    score = -1;
    reasons.push(
      `Selling momentum accelerating sharply (${mmAccel.toLocaleString("en-US")} contracts/week\u00B2)`,
    );
  } else if (mmAccel <= -ACCEL_MODERATE) {
    score = -lerp(-mmAccel, ACCEL_MODERATE, ACCEL_STRONG);
    reasons.push(
      `Selling momentum increasing (${mmAccel.toLocaleString("en-US")} contracts/week\u00B2)`,
    );
  } else {
    reasons.push(
      `Momentum stable (${mmAccel >= 0 ? "+" : ""}${mmAccel.toLocaleString("en-US")} contracts/week\u00B2)`,
    );
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// 4. Open Interest Score (price + OI trend confirmation)
// ---------------------------------------------------------------------------

/**
 * Score the relationship between price trend and open interest trend.
 *
 * Strong bullish:  price up + OI up (fresh money entering in direction of move)
 * Weak bullish:    price down + OI down (short covering — selloff exhausting)
 * Strong bearish:  price down + OI up (fresh shorts entering)
 * Weak bearish:    price up + OI down (rally losing participation)
 */
function scoreOpenInterest(
  priceTrend: PriceTrend,
  oiTrend: OpenInterestTrend,
): ComponentResult {
  const reasons: string[] = [];
  const oiLevel = oiTrend.current;
  const oiDir = oiTrend.trend;
  let score = 0;

  if (priceTrend === "up" && oiDir === "up") {
    score = 1;
    reasons.push(
      `Price rising with increasing open interest (${oiLevel.toLocaleString("en-US")}) — strong bullish confirmation`,
    );
  } else if (priceTrend === "up" && oiDir === "down") {
    score = -0.5;
    reasons.push(
      `Price rising but open interest declining (${oiLevel.toLocaleString("en-US")}) — rally losing participation`,
    );
  } else if (priceTrend === "down" && oiDir === "up") {
    score = -1;
    reasons.push(
      `Price falling with increasing open interest (${oiLevel.toLocaleString("en-US")}) — strong bearish pressure`,
    );
  } else {
    // price down + OI down
    score = 0.5;
    reasons.push(
      `Price falling with declining open interest (${oiLevel.toLocaleString("en-US")}) — selloff exhausting (short covering)`,
    );
  }

  // OI absolute level context
  if (oiLevel > OI_HIGH) {
    reasons.push(
      `Open interest elevated (${oiLevel.toLocaleString("en-US")}) — high market participation`,
    );
  } else if (oiLevel < OI_LOW) {
    // Dampen OI score when liquidity is thin — signal less reliable
    score *= 0.5;
    reasons.push(
      `Open interest thin (${oiLevel.toLocaleString("en-US")}) — low liquidity, OI signal dampened`,
    );
  }

  return { score: Math.max(-1, Math.min(1, score)), reasons };
}

// ---------------------------------------------------------------------------
// 5. Price Trend Score
// ---------------------------------------------------------------------------

/**
 * Score the current price direction.
 *
 * This is the weakest signal (price trend alone tells you where you've been,
 * not where you're going), hence the ±0.5 cap and lowest-tier weighting.
 */
function scorePriceTrend(priceTrend: PriceTrend): ComponentResult {
  if (priceTrend === "up") {
    return {
      score: 0.5,
      reasons: ["Price trending up — current directional bias bullish"],
    };
  }
  return {
    score: -0.5,
    reasons: ["Price trending down — current directional bias bearish"],
  };
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

/**
 * Calculate the weighted composite score from individual component scores.
 *
 * Formula: (Σ score_i × weight_i) / (Σ weight_i) × 100
 *
 * Returns a value between -100 and +100.
 */
function calculateCompositeScore(breakdown: ScoreBreakdown): number {
  const weighted =
    breakdown.cotPositioning * WEIGHTS.cotPositioning +
    breakdown.delta * WEIGHTS.delta +
    breakdown.acceleration * WEIGHTS.acceleration +
    breakdown.openInterest * WEIGHTS.openInterest +
    breakdown.priceTrend * WEIGHTS.priceTrend;

  return Math.round((weighted / TOTAL_WEIGHT) * 100);
}

// ---------------------------------------------------------------------------
// Signal mapping
// ---------------------------------------------------------------------------

/**
 * Map a composite score (-100 to +100) to a signal direction.
 *
 * Strong conviction (|score| >= 40) → BUY or SELL
 * Moderate conviction (|score| >= 15) → CAUTION (developing, watch closely)
 * Low conviction (|score| < 15) → NEUTRAL
 */
function mapScoreToSignal(score: number): SignalDirection {
  if (score >= SIGNAL_THRESHOLD_STRONG) return "BUY";
  if (score <= -SIGNAL_THRESHOLD_STRONG) return "SELL";
  if (Math.abs(score) >= SIGNAL_THRESHOLD_MODERATE) return "CAUTION";
  return "NEUTRAL";
}

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

/**
 * Calculate confidence based on both score magnitude and component agreement.
 *
 * Two factors:
 *   1. Magnitude: how far the composite score is from zero (0–100 scale)
 *   2. Agreement: what fraction of components point in the same direction
 *      as the composite score (0–1 scale)
 *
 * When 4/5 components agree, confidence gets a bonus.
 * When only 2/5 agree, confidence is penalized — even a strong score
 * driven by a single extreme component should have lower confidence.
 *
 * Final confidence = magnitude × (0.5 + 0.5 × agreement), clamped 0–100.
 */
function calculateConfidence(score: number, breakdown: ScoreBreakdown): number {
  const magnitude = Math.min(100, Math.abs(score));

  // Count how many components agree with the score direction
  const direction = Math.sign(score);
  if (direction === 0) return 0;

  const components = [
    breakdown.cotPositioning,
    breakdown.delta,
    breakdown.acceleration,
    breakdown.openInterest,
    breakdown.priceTrend,
  ];

  const agreeing = components.filter((c) =>
    direction > 0 ? c > 0 : c < 0,
  ).length;

  // agreement = 0.0 (0/5 agree) to 1.0 (5/5 agree)
  const agreement = agreeing / components.length;

  // Scale magnitude by agreement factor (0.5 baseline + 0.5 from agreement)
  const confidence = Math.round(magnitude * (0.5 + 0.5 * agreement));
  return Math.max(0, Math.min(100, confidence));
}

// ---------------------------------------------------------------------------
// Warning detection
// ---------------------------------------------------------------------------

/**
 * Detect high-conviction warning patterns that warrant prominent callouts.
 *
 * These are specific multi-factor confluences where the combination of
 * signals is more meaningful than any individual component.
 */
function detectWarnings(
  breakdown: ScoreBreakdown,
  deltas: PositioningDeltas | null,
  percentiles: PercentileMetrics | null,
  priceTrend: PriceTrend,
): string[] {
  const warnings: string[] = [];

  if (!deltas) return warnings;

  const mmDelta = deltas.managedMoney;

  // Exhaustion: high COT score (bearish contrarian) + rapid long build-up
  if (breakdown.cotPositioning < -0.3 && mmDelta > DELTA_MODERATE_BULLISH && breakdown.acceleration > 0) {
    warnings.push(
      `Rapid increase in managed money longs (+${mmDelta.toLocaleString("en-US")} contracts/week, accelerating) — possible exhaustion forming`,
    );
  }

  // Capitulation: extreme negative delta at already-depressed percentile
  const mmPct = percentiles?.managedMoneyPercentile ?? 50;
  if (mmDelta <= DELTA_STRONG_BEARISH && mmPct < PERCENTILE_LOW) {
    warnings.push(
      `Rapid long liquidation (${mmDelta.toLocaleString("en-US")} contracts/week) at ${formatPercentile(mmPct)} — capitulation signal`,
    );
  }

  // Divergence: funds reducing longs during price rally
  if (mmDelta < DELTA_MODERATE_BEARISH && priceTrend === "up") {
    warnings.push(
      `Funds reducing longs (${mmDelta.toLocaleString("en-US")} contracts/week) during rally — weakening trend`,
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Metrics builder
// ---------------------------------------------------------------------------

/**
 * Build the unified SignalMetrics from percentiles, deltas, and acceleration.
 * Returns null if percentile data is unavailable (baseline requirement).
 */
function buildSignalMetrics(
  percentiles: PercentileMetrics | null,
  deltas: PositioningDeltas | null,
  acceleration: PositioningAcceleration | null,
): SignalMetrics | null {
  if (!percentiles) return null;

  return {
    managedMoneyPercentile: percentiles.managedMoneyPercentile,
    commercialsPercentile: percentiles.commercialsPercentile,
    managedMoneyDelta: deltas?.managedMoney ?? 0,
    commercialsDelta: deltas?.commercials ?? 0,
    acceleration: acceleration?.managedMoney ?? 0,
    historyLength: percentiles.historyLength,
    oldestDate: percentiles.oldestDate,
    newestDate: percentiles.newestDate,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a consolidated trading signal using weighted composite scoring.
 *
 * Scores five independent components, combines them with calibrated weights,
 * and maps the result to a signal direction with agreement-based confidence.
 *
 * The function is the sole public entry point for signal generation.
 * All internal scoring functions are private implementation details.
 */
export function generateSignal(input: SignalInput): Signal {
  const { priceTrend, oiTrend, cotData, percentiles, deltas, acceleration } = input;

  // Score each component independently
  const cotResult = scoreCotPositioning(cotData, percentiles);
  const deltaResult = scoreDelta(deltas);
  const accelResult = scoreAcceleration(acceleration);
  const oiResult = scoreOpenInterest(priceTrend, oiTrend);
  const priceResult = scorePriceTrend(priceTrend);

  // Build breakdown
  const breakdown: ScoreBreakdown = {
    cotPositioning: cotResult.score,
    delta: deltaResult.score,
    acceleration: accelResult.score,
    openInterest: oiResult.score,
    priceTrend: priceResult.score,
  };

  // Calculate composite score and map to signal
  const score = calculateCompositeScore(breakdown);
  const direction = mapScoreToSignal(score);
  const confidence = calculateConfidence(score, breakdown);

  // Combine reasoning from all components
  const reasoning = [
    ...cotResult.reasons,
    ...deltaResult.reasons,
    ...accelResult.reasons,
    ...oiResult.reasons,
    ...priceResult.reasons,
  ];

  // Detect and prepend warning callouts
  const warnings = detectWarnings(breakdown, deltas, percentiles, priceTrend);
  if (warnings.length > 0) {
    reasoning.push(...warnings);
  }

  return {
    signal: direction,
    confidence,
    score,
    breakdown,
    reasoning,
    metrics: buildSignalMetrics(percentiles, deltas, acceleration),
  };
}
