"use client";

// Dashboard client component
//
// Replaces the server-side data fetching with React Query hooks +
// Supabase Realtime subscriptions. All data flows through the hook
// layer; the derive* functions remain pure.

import PricePanel from "@/components/PricePanel";
import SentimentPanel from "@/components/SentimentPanel";
import TradingSignalCard from "@/components/TradingSignalCard";
import MTFPanel from "@/components/MTFPanel";
import ReadinessBreakdown from "@/components/ReadinessBreakdown";
import LifecyclePanel from "@/components/LifecyclePanel";
import AnalysisPanel from "@/components/AnalysisPanel";
import { useSignal } from "@/hooks/useSignal";
import { useSupabaseRealtime } from "@/hooks/useSupabaseRealtime";

import type {
  TradeStatus,
  TradeDecision,
  SignalBias,
  InvalidationRisk,
  TimeframeEntry,
  ReadinessComponent,
  SignalLifecycle,
} from "@/components/types";

// ---------------------------------------------------------------------------
// Signal-to-dashboard mapping (pure functions, unchanged from server version)
// ---------------------------------------------------------------------------

function deriveSignalBias(signalDirection: string): SignalBias {
  if (signalDirection === "BUY") return "BULLISH";
  if (signalDirection === "SELL") return "BEARISH";
  return "NEUTRAL";
}

function deriveTradeStatus(
  stage: string,
  confidence: number,
  score: number,
): TradeStatus {
  if (Math.abs(score) < 15) return "WAIT";
  if (stage === "CONFIRMATION" && confidence >= 60) return "READY";
  return "WAIT";
}

function deriveTradeDecision(status: TradeStatus): TradeDecision {
  return status === "READY" ? "EXECUTE_TRADE" : "NO_TRADE";
}

function deriveInvalidationRisk(confidence: number, score: number): InvalidationRisk {
  if (confidence >= 70 && Math.abs(score) >= 50) return "LOW";
  if (confidence >= 45 && Math.abs(score) >= 30) return "MEDIUM";
  return "HIGH";
}

function deriveReadinessScore(confidence: number, score: number, stage: string): number {
  const magnitudeContrib = Math.min(Math.abs(score), 100) * 0.4;
  const confidenceContrib = confidence * 0.4;
  const stageContrib =
    stage === "CONFIRMATION" ? 20
      : stage === "TRIGGER" ? 12
        : 5;
  return Math.round(magnitudeContrib + confidenceContrib + stageContrib);
}

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
// Realtime status indicator
// ---------------------------------------------------------------------------

function RealtimeIndicator({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500 animate-pulse"
        : "bg-red-500";

  const label =
    status === "connected"
      ? "Live"
      : status === "connecting"
        ? "Connecting..."
        : "Offline";

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="mt-6 h-56 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function DashboardError() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-800 dark:bg-red-950">
        <h2 className="text-lg font-semibold text-red-900 dark:text-red-100">
          Failed to load dashboard data
        </h2>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          Check your Supabase connection and try refreshing the page.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard client
// ---------------------------------------------------------------------------

export default function DashboardClient() {
  const { data, isLoading, isError, sources } = useSignal();
  const { status: realtimeStatus } = useSupabaseRealtime();

  if (isLoading) return <DashboardSkeleton />;
  if (isError) return <DashboardError />;

  // Derive dashboard state from signal data
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
  let reasoning: string[] = ["Waiting for data to generate signal"];
  let highlightMessage = "No data available. Waiting for market data.";
  let reportTimestamp = new Date().toISOString();

  if (data) {
    const { signal, execution } = data;
    const stage = execution.execution.stage;
    const bias = execution.execution.bias;

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

  if (sources.cotReport) {
    reportTimestamp = new Date(sources.cotReport.date).toISOString();
  }

  const lifecycle: SignalLifecycle = {
    status: tradeStatus === "READY" ? "CONFIRMED" : tradeStatus === "INVALIDATED" ? "INVALIDATED" : "ACTIVE",
    createdAt: reportTimestamp,
    expiresAt: null,
    invalidationWarning: invalidationRisk === "HIGH"
      ? "High invalidation risk \u2014 conditions may shift against this setup"
      : null,
  };

  return (
    <>
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              Gold Dashboard
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Decision engine &mdash; COMEX gold futures
            </p>
          </div>
          <RealtimeIndicator status={realtimeStatus} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* TOP ROW: Price + Sentiment */}
        <div className="grid gap-6 md:grid-cols-2">
          <PricePanel
            price={sources.goldPrice?.price ?? null}
            currency={sources.goldPrice?.currency ?? "USD"}
            lastUpdated={sources.goldPrice?.timestamp ?? null}
          />
          <SentimentPanel data={sources.cotReport ?? null} />
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
    </>
  );
}
