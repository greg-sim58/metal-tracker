// Execution & alert layer
//
// Transforms raw composite signals into actionable trading stages:
//   SETUP → early warning (conditions forming, no action yet)
//   TRIGGER → pre-execution (conditions met, prepare to act)
//   CONFIRMATION → execution (multiple factors aligned, act)
//
// Each stage comes with a directional bias (BULLISH/BEARISH/NEUTRAL),
// a human-readable message, and suggested actions.
//
// Alerts are severity-tagged messages for dashboard callouts.

import type {
  Signal,
  SignalInput,
  PriceTrend,
  OpenInterestTrend,
} from "@/lib/signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalStage = "SETUP" | "TRIGGER" | "CONFIRMATION";

export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL";

export type AlertLevel = "info" | "warning" | "critical";

export interface ExecutionSignal {
  stage: SignalStage;
  bias: Bias;
  message: string;
  actions: string[];
}

export interface Alert {
  level: AlertLevel;
  text: string;
}

export interface ExecutionResult {
  execution: ExecutionSignal;
  alerts: Alert[];
}

// ---------------------------------------------------------------------------
// Stage thresholds
//
// Calibrated against the composite scoring engine in signals.ts.
// Score range is -100 to +100, delta thresholds match the scoring engine's
// DELTA_STRONG/MODERATE bands.
// ---------------------------------------------------------------------------

/** Score thresholds for bearish stages (negative scores). */
const BEARISH_SETUP_SCORE = -30;
const BEARISH_TRIGGER_SCORE = -40;
const BEARISH_CONFIRMATION_SCORE = -50;

/** Score thresholds for bullish stages (positive scores). */
const BULLISH_SETUP_SCORE = 30;
const BULLISH_TRIGGER_SCORE = 40;
const BULLISH_CONFIRMATION_SCORE = 50;

/** Delta threshold for managed money flow (contracts/week). */
const DELTA_BEARISH_THRESHOLD = -10_000;
const DELTA_BULLISH_THRESHOLD = 10_000;

// ---------------------------------------------------------------------------
// Stage classification — Bearish
// ---------------------------------------------------------------------------

/**
 * Classify bearish execution stage.
 *
 * CONFIRMATION: score deeply negative + price falling (full alignment).
 * TRIGGER: score strongly negative + OI declining (participation dropping).
 * SETUP: score moderately negative + bearish delta + price still rising
 *        (divergence — early warning before the turn).
 *
 * Returns null if no bearish stage conditions are met.
 */
function classifyBearish(
  score: number,
  priceTrend: PriceTrend,
  oiTrend: OpenInterestTrend,
  managedMoneyDelta: number,
): ExecutionSignal | null {
  // CONFIRMATION: full bearish alignment — score < -50, price confirming
  if (score <= BEARISH_CONFIRMATION_SCORE && priceTrend === "down") {
    return {
      stage: "CONFIRMATION",
      bias: "BEARISH",
      message: "Bearish confirmation — composite score deeply negative with price following through to the downside",
      actions: [
        "Execute short bias positions or reduce long exposure",
        "Set protective stops above recent swing high",
        "Watch for capitulation flush as potential exit signal",
      ],
    };
  }

  // TRIGGER: strong bearish score + declining participation
  if (score <= BEARISH_TRIGGER_SCORE && oiTrend.trend === "down") {
    return {
      stage: "TRIGGER",
      bias: "BEARISH",
      message: "Bearish trigger — strong negative score with declining open interest suggests waning bullish participation",
      actions: [
        "Prepare short bias entries on next resistance test",
        "Tighten stops on existing long positions",
        "Monitor for price breakdown confirmation",
      ],
    };
  }

  // SETUP: early warning — score turning negative, funds reducing longs,
  // but price still rising (classic divergence)
  if (
    score <= BEARISH_SETUP_SCORE &&
    managedMoneyDelta <= DELTA_BEARISH_THRESHOLD &&
    priceTrend === "up"
  ) {
    return {
      stage: "SETUP",
      bias: "BEARISH",
      message: "Bearish setup — funds reducing longs while price still rising, watch for trend exhaustion",
      actions: [
        "Begin monitoring for bearish confirmation signals",
        "Avoid initiating new long positions at current levels",
        "Identify key support levels for potential breakdown targets",
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stage classification — Bullish
// ---------------------------------------------------------------------------

/**
 * Classify bullish execution stage.
 *
 * CONFIRMATION: score deeply positive + price rising (breakout confirmed).
 * TRIGGER: score strongly positive + OI rising (fresh money entering).
 * SETUP: score moderately positive + bullish delta + price still falling
 *        (capitulation / recovery divergence — early contrarian signal).
 *
 * Returns null if no bullish stage conditions are met.
 */
function classifyBullish(
  score: number,
  priceTrend: PriceTrend,
  oiTrend: OpenInterestTrend,
  managedMoneyDelta: number,
): ExecutionSignal | null {
  // CONFIRMATION: full bullish alignment — score > +50, price rising
  if (score >= BULLISH_CONFIRMATION_SCORE && priceTrend === "up") {
    return {
      stage: "CONFIRMATION",
      bias: "BULLISH",
      message: "Bullish confirmation — composite score strongly positive with price breaking out to the upside",
      actions: [
        "Execute long bias positions or increase existing exposure",
        "Set protective stops below recent swing low",
        "Watch for euphoria / exhaustion signals as potential exit",
      ],
    };
  }

  // TRIGGER: strong positive score + rising OI (fresh participation)
  if (score >= BULLISH_TRIGGER_SCORE && oiTrend.trend === "up") {
    return {
      stage: "TRIGGER",
      bias: "BULLISH",
      message: "Bullish trigger — strong positive score with rising open interest indicates fresh buying entering the market",
      actions: [
        "Prepare long entries on next support test or pullback",
        "Reduce short exposure if applicable",
        "Monitor for price breakout confirmation",
      ],
    };
  }

  // SETUP: early contrarian — score turning positive, funds adding longs,
  // but price still falling (capitulation recovery pattern)
  if (
    score >= BULLISH_SETUP_SCORE &&
    managedMoneyDelta >= DELTA_BULLISH_THRESHOLD &&
    priceTrend === "down"
  ) {
    return {
      stage: "SETUP",
      bias: "BULLISH",
      message: "Bullish setup — funds rebuilding longs during price weakness, potential capitulation recovery forming",
      actions: [
        "Begin monitoring for bullish confirmation signals",
        "Avoid initiating new short positions at current levels",
        "Identify key resistance levels for potential breakout targets",
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Alert generation
// ---------------------------------------------------------------------------

/**
 * Generate severity-tagged alerts from signal data.
 *
 * Critical: extreme scores or CONFIRMATION stage.
 * Warning: TRIGGER stage or notable divergences.
 * Info: SETUP stage or general market context.
 */
function generateAlerts(
  signal: Signal,
  input: SignalInput,
  execution: ExecutionSignal,
): Alert[] {
  const alerts: Alert[] = [];
  const score = signal.score;
  const metrics = signal.metrics;

  // Stage-based alerts
  if (execution.stage === "CONFIRMATION") {
    alerts.push({
      level: "critical",
      text: `${execution.bias} CONFIRMATION active — composite score at ${score > 0 ? "+" : ""}${score} with price trend aligned`,
    });
  } else if (execution.stage === "TRIGGER") {
    alerts.push({
      level: "warning",
      text: `${execution.bias} TRIGGER forming — score at ${score > 0 ? "+" : ""}${score}, awaiting price confirmation`,
    });
  } else if (execution.stage === "SETUP") {
    alerts.push({
      level: "info",
      text: `${execution.bias} SETUP detected — early divergence signal, monitoring for development`,
    });
  }

  // Extreme percentile alerts
  if (metrics) {
    if (metrics.managedMoneyPercentile >= 90) {
      alerts.push({
        level: "warning",
        text: `Managed money at ${metrics.managedMoneyPercentile}th percentile — extreme crowding, reversal risk elevated`,
      });
    } else if (metrics.managedMoneyPercentile <= 10) {
      alerts.push({
        level: "warning",
        text: `Managed money at ${metrics.managedMoneyPercentile}th percentile — extreme depressed positioning, contrarian bullish`,
      });
    }

    // Large delta moves
    if (Math.abs(metrics.managedMoneyDelta) >= 20_000) {
      const direction = metrics.managedMoneyDelta > 0 ? "adding" : "liquidating";
      alerts.push({
        level: "warning",
        text: `Large fund flow: managed money ${direction} ${Math.abs(metrics.managedMoneyDelta).toLocaleString("en-US")} contracts/week`,
      });
    }

    // Acceleration shift
    if (Math.abs(metrics.acceleration) >= 8_000) {
      const direction = metrics.acceleration > 0 ? "accelerating" : "decelerating";
      alerts.push({
        level: "info",
        text: `Momentum ${direction} sharply (${metrics.acceleration > 0 ? "+" : ""}${metrics.acceleration.toLocaleString("en-US")} contracts/week\u00B2)`,
      });
    }
  }

  // OI context
  if (input.oiTrend.current < 200_000) {
    alerts.push({
      level: "info",
      text: `Open interest thin (${input.oiTrend.current.toLocaleString("en-US")}) — signals less reliable in low-liquidity environment`,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classify the execution stage and generate alerts from a signal and its inputs.
 *
 * Evaluates bearish conditions first (higher urgency in a rising market where
 * the contrarian model's primary value is identifying tops), then bullish.
 * Falls back to NEUTRAL if no stage conditions are met.
 */
export function classifyExecution(
  signal: Signal,
  input: SignalInput,
): ExecutionResult {
  const { score } = signal;
  const { priceTrend, oiTrend, deltas } = input;
  const managedMoneyDelta = deltas?.managedMoney ?? 0;

  // Try bearish classification first, then bullish
  const execution =
    classifyBearish(score, priceTrend, oiTrend, managedMoneyDelta) ??
    classifyBullish(score, priceTrend, oiTrend, managedMoneyDelta) ??
    buildNeutral(score);

  const alerts = generateAlerts(signal, input, execution);

  return { execution, alerts };
}

/**
 * Neutral fallback when no stage conditions are met.
 * Still provides directional lean from the score for context.
 */
function buildNeutral(score: number): ExecutionSignal {
  const lean =
    score > 0 ? "slight bullish lean" :
    score < 0 ? "slight bearish lean" :
    "no directional lean";

  return {
    stage: "SETUP",
    bias: "NEUTRAL",
    message: `No actionable stage conditions met — ${lean} (score: ${score > 0 ? "+" : ""}${score})`,
    actions: [
      "Maintain current positions and risk management",
      "Continue monitoring for developing stage conditions",
    ],
  };
}
