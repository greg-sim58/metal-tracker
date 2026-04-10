// Trading signal engine — contrarian model
//
// Core principle: when managed money (large speculators) are extremely
// positioned in one direction, the trade is crowded and likely to reverse.
// Commercials (producers/merchants) are "smart money" — their positioning
// confirms or contradicts the speculator signal.
//
// Signal strength is further modulated by open interest trend (confirms
// or diverges from price) and price direction.

import type { CotReport } from "@/lib/cot";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "NEUTRAL" | "CAUTION";

export interface Signal {
  signal: SignalDirection;
  confidence: number; // 0–100
  reasoning: string[];
}

export interface OpenInterestTrend {
  current: number;
  previous: number;
  trend: "up" | "down";
}

export type PriceTrend = "up" | "down";

// ---------------------------------------------------------------------------
// Configurable thresholds
// ---------------------------------------------------------------------------

/**
 * Managed money net position thresholds (contract count).
 *
 * EXTREME_LONG: crowded long — contrarian bearish.
 * EXTREME_SHORT: crowded short — contrarian bullish.
 * HIGH_LONG / LOW_LONG: softer thresholds for moderate signals.
 */
const EXTREME_LONG = 80_000;
const HIGH_LONG = 50_000;
const EXTREME_SHORT = -60_000;
const LOW_SHORT = -20_000;

/**
 * Open interest absolute levels for context.
 */
const OI_HIGH = 300_000;
const OI_LOW = 200_000;

// ---------------------------------------------------------------------------
// COT positioning analysis (contrarian)
// ---------------------------------------------------------------------------

interface CotAssessment {
  direction: SignalDirection;
  confidence: number;
  reasons: string[];
}

/**
 * Evaluate COT positioning using contrarian logic.
 *
 * - Managed money extreme net long + commercials net short → SELL / CAUTION
 * - Managed money extreme net short + commercials improving → BUY
 * - Everything else → NEUTRAL
 */
function assessCotPositioning(cot: CotReport): CotAssessment {
  const managedNet = cot.largeSpeculators.net;
  const commercialNet = cot.commercials.net;
  const reasons: string[] = [];

  // ------ SELL / CAUTION zone ------
  if (managedNet > EXTREME_LONG && commercialNet < 0) {
    reasons.push(
      `Managed money extremely net long (${managedNet.toLocaleString("en-US")} contracts) — crowded trade`,
    );
    reasons.push(
      `Commercials net short (${commercialNet.toLocaleString("en-US")}) — smart money selling`,
    );

    const overExtension = Math.min((managedNet - EXTREME_LONG) / EXTREME_LONG, 1);
    const confidence = Math.round(65 + overExtension * 20);

    return { direction: "CAUTION", confidence, reasons };
  }

  if (managedNet > HIGH_LONG && commercialNet < 0) {
    reasons.push(
      `Managed money heavily net long (${managedNet.toLocaleString("en-US")} contracts) — approaching crowded levels`,
    );
    reasons.push(
      `Commercials net short (${commercialNet.toLocaleString("en-US")}) — producers hedging`,
    );

    return { direction: "CAUTION", confidence: 55, reasons };
  }

  // ------ BUY zone ------
  if (managedNet < EXTREME_SHORT) {
    reasons.push(
      `Managed money extremely net short (${managedNet.toLocaleString("en-US")} contracts) — contrarian bullish`,
    );

    if (commercialNet > 0) {
      reasons.push(
        `Commercials net long (${commercialNet.toLocaleString("en-US")}) — smart money buying`,
      );
      const overExtension = Math.min(
        (Math.abs(managedNet) - Math.abs(EXTREME_SHORT)) / Math.abs(EXTREME_SHORT),
        1,
      );
      return { direction: "BUY", confidence: Math.round(70 + overExtension * 20), reasons };
    }

    reasons.push(
      `Commercials still net short (${commercialNet.toLocaleString("en-US")}) — not fully confirmed`,
    );
    return { direction: "BUY", confidence: 55, reasons };
  }

  if (managedNet < LOW_SHORT && commercialNet > 0) {
    reasons.push(
      `Managed money net short (${managedNet.toLocaleString("en-US")} contracts) — bearish crowd`,
    );
    reasons.push(
      `Commercials net long (${commercialNet.toLocaleString("en-US")}) — smart money accumulating`,
    );
    return { direction: "BUY", confidence: 50, reasons };
  }

  // ------ NEUTRAL zone ------
  reasons.push(
    `Managed money positioning moderate (${managedNet.toLocaleString("en-US")} contracts) — no extreme`,
  );
  reasons.push(
    `Commercials net position: ${commercialNet.toLocaleString("en-US")}`,
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
}

/**
 * Produce a single consolidated trading signal by combining:
 *   1. COT positioning (contrarian model)
 *   2. Open interest trend confirmation
 *   3. Price direction context
 *
 * Confidence is clamped to 0–100.
 */
export function generateSignal(input: SignalInput): Signal {
  const { priceTrend, oiTrend, cotData } = input;

  // Step 1 — COT positioning (primary signal)
  const cot = assessCotPositioning(cotData);

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
  };
}
