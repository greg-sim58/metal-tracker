import DashboardRefresh from "@/components/DashboardRefresh";
import PricePanel from "@/components/PricePanel";
import SentimentPanel from "@/components/SentimentPanel";
import TradingSignalCard from "@/components/TradingSignalCard";
import MTFPanel from "@/components/MTFPanel";
import ReadinessBreakdown from "@/components/ReadinessBreakdown";
import LifecyclePanel from "@/components/LifecyclePanel";
import AnalysisPanel from "@/components/AnalysisPanel";
import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import {
  fetchCotHistory,
  computePercentileMetrics,
  getWeeklyDeltas,
  calculateAcceleration,
} from "@/lib/cotHistory";
import { generateSignal } from "@/lib/signals";
import { classifyExecution } from "@/lib/execution";

import type { OpenInterestTrend, PriceTrend } from "@/lib/signals";
import type { ExecutionResult } from "@/lib/execution";
import type {
  TradeStatus,
  TradeDecision,
  SignalBias,
  InvalidationRisk,
  TimeframeEntry,
  ReadinessComponent,
  SignalLifecycle,
} from "@/components/types";

/** Fallback ratio to estimate previous OI when historical data is unavailable. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

// ---------------------------------------------------------------------------
// Signal-to-dashboard mapping
// ---------------------------------------------------------------------------

/**
 * Map the raw signal direction to a decision-engine bias.
 * Removes BUY/SELL action language — uses BULLISH/BEARISH/NEUTRAL only.
 */
function deriveSignalBias(signalDirection: string): SignalBias {
  if (signalDirection === "BUY") return "BULLISH";
  if (signalDirection === "SELL") return "BEARISH";
  return "NEUTRAL";
}

/**
 * Derive trade status from execution stage and confidence.
 * CONFIRMATION stage with high confidence = READY.
 * Low confidence or no strong stage = WAIT.
 */
function deriveTradeStatus(
  stage: string,
  confidence: number,
  score: number,
): TradeStatus {
  if (Math.abs(score) < 15) return "WAIT";
  if (stage === "CONFIRMATION" && confidence >= 60) return "READY";
  return "WAIT";
}

/**
 * Derive trade decision from status.
 */
function deriveTradeDecision(status: TradeStatus): TradeDecision {
  return status === "READY" ? "EXECUTE_TRADE" : "NO_TRADE";
}

/**
 * Derive invalidation risk from confidence and score alignment.
 */
function deriveInvalidationRisk(confidence: number, score: number): InvalidationRisk {
  if (confidence >= 70 && Math.abs(score) >= 50) return "LOW";
  if (confidence >= 45 && Math.abs(score) >= 30) return "MEDIUM";
  return "HIGH";
}

/**
 * Derive a synthetic readiness score from confidence, score magnitude, and stage.
 * This is a simplified proxy until the full readiness engine is wired up.
 */
function deriveReadinessScore(confidence: number, score: number, stage: string): number {
  const magnitudeContrib = Math.min(Math.abs(score), 100) * 0.4;
  const confidenceContrib = confidence * 0.4;
  const stageContrib =
    stage === "CONFIRMATION" ? 20
      : stage === "TRIGGER" ? 12
        : 5;
  return Math.round(magnitudeContrib + confidenceContrib + stageContrib);
}

/**
 * Map execution stage to MTF timeframe entries.
 * Uses execution context to derive alignment status.
 */
function deriveMTFEntries(
  stage: string,
  bias: string,
  score: number,
): TimeframeEntry[] {
  const isBullish = bias === "BULLISH";
  const isBearish = bias === "BEARISH";
  const hasDirection = isBullish || isBearish;
  const isStrong = Math.abs(score) >= 40;

  return [
    {
      label: "HTF (Sentiment)",
      description: "Weekly COT sentiment bias",
      status: hasDirection ? "ALIGNED" : "PENDING",
    },
    {
      label: "MTF (Structure)",
      description: "Daily price structure confirmation",
      status: hasDirection && isStrong ? "ALIGNED" : hasDirection ? "PENDING" : "NOT_ALIGNED",
    },
    {
      label: "LTF (Trigger)",
      description: "Intraday entry trigger",
      status: stage === "CONFIRMATION" ? "ALIGNED" : stage === "TRIGGER" ? "PENDING" : "NOT_ALIGNED",
    },
  ];
}

/**
 * Derive readiness breakdown components from signal data.
 */
function deriveReadinessComponents(
  confidence: number,
  score: number,
  stage: string,
  bias: string,
): ReadinessComponent[] {
  const absScore = Math.abs(score);
  const hasDirection = bias === "BULLISH" || bias === "BEARISH";

  return [
    { label: "Signal Strength", score: Math.min(absScore, 100), weight: 15 },
    { label: "Confidence", score: confidence, weight: 15 },
    { label: "Regime", score: hasDirection ? 60 : 30, weight: 15 },
    { label: "HTF Alignment", score: hasDirection ? 75 : 20, weight: 20 },
    { label: "MTF Structure", score: absScore >= 40 ? 65 : 25, weight: 20 },
    { label: "LTF Trigger", score: stage === "CONFIRMATION" ? 80 : stage === "TRIGGER" ? 45 : 15, weight: 15 },
  ];
}

/**
 * Derive a highlight message for the analysis panel.
 */
function deriveHighlightMessage(
  status: TradeStatus,
  bias: string,
  stage: string,
): string {
  if (status === "READY") {
    const direction = bias === "BULLISH" ? "bullish" : "bearish";
    return `${direction.charAt(0).toUpperCase() + direction.slice(1)} setup confirmed. All conditions met for execution.`;
  }

  if (status === "INVALIDATED") {
    return "Signal invalidated. Conditions no longer support this trade idea.";
  }

  if (stage === "TRIGGER") {
    const direction = bias === "BULLISH" ? "bullish" : bias === "BEARISH" ? "bearish" : "neutral";
    return `${direction.charAt(0).toUpperCase() + direction.slice(1)} setup forming but not confirmed. Waiting for price confirmation.`;
  }

  if (stage === "SETUP") {
    return "Early signal detected. Multiple confirmations still required before trade execution.";
  }

  return "No actionable setup detected. Monitoring market conditions.";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const [goldPrice, cotReport, cotHistory] = await Promise.all([
    fetchGoldPrice(),
    fetchCotReport(),
    fetchCotHistory(),
  ]);

  // Generate the combined signal when COT data is available
  let signalBias: SignalBias = "NEUTRAL";
  let signalScore = 0;
  let confidence = 0;
  let readinessScore = 0;
  let tradeStatus: TradeStatus = "WAIT";
  let tradeDecision: TradeDecision = "NO_TRADE";
  let invalidationRisk: InvalidationRisk = "HIGH";
  let mtfEntries: TimeframeEntry[] = deriveMTFEntries("SETUP", "NEUTRAL", 0);
  let mtfAligned = false;
  let readinessComponents: ReadinessComponent[] = deriveReadinessComponents(0, 0, "SETUP", "NEUTRAL");
  let reasoning: string[] = ["Waiting for COT data to generate signal"];
  let highlightMessage = "No data available. Waiting for market data.";
  let executionResult: ExecutionResult | null = null;

  if (cotReport) {
    const percentiles = computePercentileMetrics(
      cotReport.largeSpeculators.net,
      cotReport.commercials.net,
      cotHistory,
    );

    const priceTrend: PriceTrend = "up";

    const oiCurrent = cotReport.openInterest;
    let oiPrevious: number;
    if (cotHistory.length >= 2) {
      oiPrevious = cotHistory[cotHistory.length - 2].openInterest;
    } else {
      oiPrevious = Math.round(oiCurrent * PREVIOUS_OI_ESTIMATE_RATIO);
    }

    const oiTrend: OpenInterestTrend = {
      current: oiCurrent,
      previous: oiPrevious,
      trend: oiCurrent > oiPrevious ? "up" : "down",
    };

    const deltas = getWeeklyDeltas(cotHistory);
    const acceleration = calculateAcceleration(cotHistory);

    const signalInput = {
      priceTrend,
      oiTrend,
      cotData: cotReport,
      percentiles,
      deltas,
      acceleration,
    };

    const signal = generateSignal(signalInput);
    executionResult = classifyExecution(signal, signalInput);

    const stage = executionResult.execution.stage;
    const bias = executionResult.execution.bias;

    signalBias = deriveSignalBias(signal.signal);
    signalScore = signal.score;
    confidence = signal.confidence;
    readinessScore = deriveReadinessScore(confidence, signalScore, stage);
    tradeStatus = deriveTradeStatus(stage, confidence, signalScore);
    tradeDecision = deriveTradeDecision(tradeStatus);
    invalidationRisk = deriveInvalidationRisk(confidence, signalScore);
    mtfEntries = deriveMTFEntries(stage, bias, signalScore);
    mtfAligned = mtfEntries.every((e) => e.status === "ALIGNED");
    readinessComponents = deriveReadinessComponents(confidence, signalScore, stage, bias);
    reasoning = signal.reasoning;
    highlightMessage = deriveHighlightMessage(tradeStatus, bias, stage);
  }

  // Lifecycle timestamps are derived from COT report date when available,
  // otherwise use static sample values.  Avoids Date.now() which is impure
  // inside a React server component render.
  const reportTimestamp = cotReport
    ? new Date(cotReport.date).toISOString()
    : "2025-04-12T00:00:00.000Z";

  const lifecycle: SignalLifecycle = {
    status: tradeStatus === "READY" ? "CONFIRMED" : tradeStatus === "INVALIDATED" ? "INVALIDATED" : "ACTIVE",
    createdAt: reportTimestamp,
    expiresAt: null,
    invalidationWarning: invalidationRisk === "HIGH"
      ? "High invalidation risk — conditions may shift against this setup"
      : null,
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <DashboardRefresh />
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Gold Dashboard
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Decision engine — COMEX gold futures
        </p>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* TOP ROW: Price + Sentiment */}
        <div className="grid gap-6 md:grid-cols-2">
          <PricePanel
            price={goldPrice?.price ?? null}
            currency={goldPrice?.currency ?? "USD"}
            lastUpdated={goldPrice?.timestamp ?? null}
          />
          <SentimentPanel data={cotReport} />
        </div>

        {/* MAIN SECTION: Trading Signal Card (full width) */}
        <div className="mt-6">
          <TradingSignalCard
            signalBias={signalBias}
            signalScore={signalScore}
            confidence={confidence}
            readinessScore={readinessScore}
            status={tradeStatus}
            decision={tradeDecision}
            invalidationRisk={invalidationRisk}
          />
        </div>

        {/* SECOND ROW: MTF + Readiness */}
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <MTFPanel
            timeframes={mtfEntries}
            isAligned={mtfAligned}
          />
          <ReadinessBreakdown
            components={readinessComponents}
            totalScore={readinessScore}
          />
        </div>

        {/* THIRD ROW: Lifecycle + Analysis */}
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <LifecyclePanel lifecycle={lifecycle} />
          <AnalysisPanel
            reasoning={reasoning}
            highlightMessage={highlightMessage}
          />
        </div>
      </main>
    </div>
  );
}
