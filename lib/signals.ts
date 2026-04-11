// Trading signal engine — contrarian model with dynamic percentile thresholds
//
// Core principle: when managed money (large speculators) are extremely
// positioned in one direction, the trade is crowded and likely to reverse.
// Commercials (producers/merchants) are "smart money" — their positioning
// confirms or contradicts the speculator signal.
//
// Positioning extremes are defined dynamically using percentile rank
// against 1–3 years of historical COT data, replacing static contract
// count thresholds.
//
// Signal strength is further modulated by open interest trend (confirms
// or diverges from price) and price direction.

import type { CotReport } from "@/lib/cot";
import type { PercentileMetrics } from "@/lib/cotHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "NEUTRAL" | "CAUTION";

export interface Signal {
  signal: SignalDirection;
  confidence: number; // 0–100
  reasoning: string[];
  metrics: PercentileMetrics | null;
}

export interface OpenInterestTrend {
  current: number;
  previous: number;
  trend: "up" | "down";
}

export type PriceTrend = "up" | "down";

// ---------------------------------------------------------------------------
// Percentile thresholds
// ---------------------------------------------------------------------------

/**
 * Percentile thresholds for positioning extremes.
 *
 * EXTREME: 90th / 10th percentile — highly crowded, strong contrarian signal.
 * HIGH: 75th / 25th percentile — elevated positioning, moderate signal.
 */
const PERCENTILE_EXTREME_HIGH = 90;
const PERCENTILE_HIGH = 75;
const PERCENTILE_EXTREME_LOW = 10;
const PERCENTILE_LOW = 25;

/**
 * Open interest absolute levels for context.
 */
const OI_HIGH = 300_000;
const OI_LOW = 200_000;

// ---------------------------------------------------------------------------
// COT positioning analysis (contrarian, percentile-based)
// ---------------------------------------------------------------------------

interface CotAssessment {
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
}

/**
 * Format a percentile value for display in reasoning strings.
 */
function formatPercentile(percentile: number): string {
  return `${percentile}${ordinalSuffix(percentile)} percentile`;
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

/**
 * Evaluate COT positioning using contrarian logic with percentile thresholds.
 *
 * When percentile metrics are available:
 * - Managed money >= 90th percentile + commercials net short → CAUTION (crowded long)
 * - Managed money >= 75th percentile + commercials net short → CAUTION (elevated)
 * - Managed money <= 10th percentile → BUY (contrarian bullish)
 * - Managed money <= 25th percentile + commercials net long → BUY (moderate)
 *
 * Falls back to raw contract counts with conservative thresholds when
 * historical data is unavailable.
 */
function assessCotPositioning(
  cot: CotReport,
  percentiles: PercentileMetrics | null,
): CotAssessment {
  const managedNet = cot.largeSpeculators.net;
  const commercialNet = cot.commercials.net;
  const reasons: string[] = [];

  // If percentile data is available, use dynamic thresholds
  if (percentiles) {
    return assessWithPercentiles(
      managedNet,
      commercialNet,
      percentiles,
      reasons,
    );
  }

  // Fallback: no historical data — use conservative NEUTRAL
  reasons.push(
    `Managed money net position: ${managedNet.toLocaleString("en-US")} contracts`,
  );
  reasons.push(
    `Commercials net position: ${commercialNet.toLocaleString("en-US")}`,
  );
  reasons.push(
    "Historical data unavailable — percentile analysis not possible, defaulting to neutral",
  );

  return { direction: "NEUTRAL", confidence: 20, reasons };
}

/**
 * Assess COT positioning using percentile-based thresholds.
 */
function assessWithPercentiles(
  managedNet: number,
  commercialNet: number,
  percentiles: PercentileMetrics,
  reasons: string[],
): CotAssessment {
  const mmPct = percentiles.managedMoneyPercentile;
  const cmPct = percentiles.commercialsPercentile;

  // ------ SELL / CAUTION zone (managed money extremely long) ------
  if (mmPct >= PERCENTILE_EXTREME_HIGH && commercialNet < 0) {
    reasons.push(
      `Managed money net long at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — crowded trade`,
    );
    reasons.push(
      `Commercials net short (${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — smart money selling`,
    );

    // Scale confidence: 90th pct = 65, 100th = 85
    const overExtension = Math.min((mmPct - PERCENTILE_EXTREME_HIGH) / 10, 1);
    const confidence = Math.round(65 + overExtension * 20);

    return { direction: "CAUTION", confidence, reasons };
  }

  if (mmPct >= PERCENTILE_HIGH && commercialNet < 0) {
    reasons.push(
      `Managed money net long at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — approaching crowded levels`,
    );
    reasons.push(
      `Commercials net short (${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — producers hedging`,
    );

    return { direction: "CAUTION", confidence: 55, reasons };
  }

  // ------ BUY zone (managed money extremely short) ------
  if (mmPct <= PERCENTILE_EXTREME_LOW) {
    reasons.push(
      `Managed money net position at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — contrarian bullish`,
    );

    if (commercialNet > 0) {
      reasons.push(
        `Commercials net long (${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — smart money buying`,
      );
      // Scale confidence: 10th pct = 70, 0th = 90
      const overExtension = Math.min((PERCENTILE_EXTREME_LOW - mmPct) / 10, 1);
      return { direction: "BUY", confidence: Math.round(70 + overExtension * 20), reasons };
    }

    reasons.push(
      `Commercials still net short (${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — not fully confirmed`,
    );
    return { direction: "BUY", confidence: 55, reasons };
  }

  if (mmPct <= PERCENTILE_LOW && commercialNet > 0) {
    reasons.push(
      `Managed money net position at ${formatPercentile(mmPct)} ` +
      `(${managedNet.toLocaleString("en-US")} contracts) — bearish crowd`,
    );
    reasons.push(
      `Commercials net long (${commercialNet.toLocaleString("en-US")}) at ${formatPercentile(cmPct)} — smart money accumulating`,
    );
    return { direction: "BUY", confidence: 50, reasons };
  }

  // ------ NEUTRAL zone ------
  reasons.push(
    `Managed money net position at ${formatPercentile(mmPct)} ` +
    `(${managedNet.toLocaleString("en-US")} contracts) — no extreme`,
  );
  reasons.push(
    `Commercials at ${formatPercentile(cmPct)} — net position: ${commercialNet.toLocaleString("en-US")}`,
  );
  return { direction: "NEUTRAL", confidence: 30, reasons };
}

// ---------------------------------------------------------------------------
// Open interest trend confirmation
// ---------------------------------------------------------------------------

interface OiAssessment {
  confirmed: boolean;
  reason: string;
  confidenceAdjustment: number;
}

/**
 * Evaluate whether open interest confirms or diverges from the price trend.
 *
 * Strong (confirmed):  price up + OI up, or price down + OI up
 * Weak (divergent):    price up + OI down (rally losing participation)
 */
function assessOiTrend(
  priceTrend: PriceTrend,
  oiTrend: OpenInterestTrend,
): OiAssessment {
  const oiLevel = oiTrend.current;
  const oiDir = oiTrend.trend;

  if (priceTrend === "up" && oiDir === "up") {
    return {
      confirmed: true,
      reason: `Price rising with increasing open interest (${oiLevel.toLocaleString("en-US")}) — strong bullish`,
      confidenceAdjustment: 10,
    };
  }

  if (priceTrend === "up" && oiDir === "down") {
    return {
      confirmed: false,
      reason: `Price rising but open interest declining (${oiLevel.toLocaleString("en-US")}) — weak rally`,
      confidenceAdjustment: -10,
    };
  }

  if (priceTrend === "down" && oiDir === "up") {
    return {
      confirmed: true,
      reason: `Price falling with increasing open interest (${oiLevel.toLocaleString("en-US")}) — strong bearish`,
      confidenceAdjustment: 10,
    };
  }

  // price down + OI down
  return {
    confirmed: false,
    reason: `Price falling with declining open interest (${oiLevel.toLocaleString("en-US")}) — weak selloff (short covering)`,
    confidenceAdjustment: -5,
  };
}

// ---------------------------------------------------------------------------
// OI absolute level context
// ---------------------------------------------------------------------------

function assessOiLevel(oiCurrent: number): string | null {
  if (oiCurrent > OI_HIGH) {
    return `Open interest elevated (${oiCurrent.toLocaleString("en-US")}) — high market participation`;
  }
  if (oiCurrent < OI_LOW) {
    return `Open interest thin (${oiCurrent.toLocaleString("en-US")}) — low liquidity, signals less reliable`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Combined signal generation
// ---------------------------------------------------------------------------

export interface SignalInput {
  priceTrend: PriceTrend;
  oiTrend: OpenInterestTrend;
  cotData: CotReport;
  percentiles: PercentileMetrics | null;
}

/**
 * Produce a single consolidated trading signal by combining:
 *   1. COT positioning (contrarian model with percentile thresholds)
 *   2. Open interest trend confirmation
 *   3. Price direction context
 *
 * Confidence is clamped to 0–100.
 */
export function generateSignal(input: SignalInput): Signal {
  const { priceTrend, oiTrend, cotData, percentiles } = input;

  // Step 1 — COT positioning (primary signal, percentile-based)
  const cot = assessCotPositioning(cotData, percentiles);

  // Step 2 — OI trend confirmation / divergence
  const oi = assessOiTrend(priceTrend, oiTrend);

  // Step 3 — Build combined reasoning
  const reasoning = [...cot.reasons];
  reasoning.push(oi.reason);

  const oiLevelNote = assessOiLevel(oiTrend.current);
  if (oiLevelNote) {
    reasoning.push(oiLevelNote);
  }

  // Step 4 — Adjust confidence based on OI confirmation
  let confidence = cot.confidence + oi.confidenceAdjustment;

  // Penalize when OI diverges from expected direction for the signal
  if (cot.direction === "BUY" && priceTrend === "up" && !oi.confirmed) {
    reasoning.push("Open interest diverging from price — rally may lack conviction");
    confidence -= 5;
  }

  if (
    (cot.direction === "CAUTION" || cot.direction === "SELL") &&
    priceTrend === "down" &&
    !oi.confirmed
  ) {
    reasoning.push("Open interest declining with price — selloff may be exhausting");
    confidence -= 5;
  }

  // Low OI reduces conviction across the board
  if (oiTrend.current < OI_LOW) {
    confidence -= 5;
  }

  // Clamp to 0–100
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    signal: cot.direction,
    confidence,
    reasoning,
    metrics: percentiles,
  };
}
