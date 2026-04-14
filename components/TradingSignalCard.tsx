"use client";

import type {
  TradingSignalCardProps,
  TradeStatus,
  TradeDecision,
  SignalBias,
  InvalidationRisk,
} from "@/components/types";

// ---------------------------------------------------------------------------
// Status badge styles
// ---------------------------------------------------------------------------

const statusStyles: Record<TradeStatus, { bg: string; text: string; label: string }> = {
  WAIT: {
    bg: "bg-amber-100 dark:bg-amber-900",
    text: "text-amber-800 dark:text-amber-200",
    label: "Waiting",
  },
  READY: {
    bg: "bg-green-100 dark:bg-green-900",
    text: "text-green-800 dark:text-green-200",
    label: "Ready",
  },
  INVALIDATED: {
    bg: "bg-red-100 dark:bg-red-900",
    text: "text-red-800 dark:text-red-200",
    label: "Invalidated",
  },
};

// ---------------------------------------------------------------------------
// Bias display
// ---------------------------------------------------------------------------

const biasConfig: Record<SignalBias, { color: string; label: string }> = {
  BULLISH: { color: "text-green-600 dark:text-green-400", label: "Bullish" },
  BEARISH: { color: "text-red-600 dark:text-red-400", label: "Bearish" },
  NEUTRAL: { color: "text-zinc-500 dark:text-zinc-400", label: "Neutral" },
};

// ---------------------------------------------------------------------------
// Invalidation risk
// ---------------------------------------------------------------------------

const riskConfig: Record<InvalidationRisk, { dot: string; color: string; label: string }> = {
  LOW: { dot: "bg-green-500", color: "text-green-600 dark:text-green-400", label: "Low Risk" },
  MEDIUM: { dot: "bg-amber-500", color: "text-amber-600 dark:text-amber-400", label: "Medium Risk" },
  HIGH: { dot: "bg-red-500", color: "text-red-600 dark:text-red-400", label: "High Risk" },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: TradeStatus }) {
  const style = statusStyles[status];
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function SignalBiasDisplay({ bias, score }: { bias: SignalBias; score: number }) {
  const config = biasConfig[bias];
  const scoreColor =
    score > 0
      ? "text-green-600 dark:text-green-400"
      : score < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-500 dark:text-zinc-400";

  return (
    <div>
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Signal Bias
      </span>
      <div className="mt-1 flex items-baseline gap-3">
        <span className={`text-lg font-semibold ${config.color}`}>
          {config.label}
        </span>
        <span className={`text-3xl font-bold tabular-nums ${scoreColor}`}>
          {score > 0 ? "+" : ""}{score}
        </span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">/ 100</span>
      </div>
    </div>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const barColor =
    confidence >= 70
      ? "bg-green-500 dark:bg-green-400"
      : confidence >= 45
        ? "bg-amber-500 dark:bg-amber-400"
        : "bg-zinc-400 dark:bg-zinc-500";

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Confidence
        </span>
        <span className="font-medium text-zinc-700 dark:text-zinc-200">
          {confidence}%
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${confidence}%` }}
        />
      </div>
    </div>
  );
}

function ReadinessBar({ score }: { score: number }) {
  const barColor =
    score >= 80
      ? "bg-green-500 dark:bg-green-400"
      : score >= 60
        ? "bg-blue-500 dark:bg-blue-400"
        : score >= 40
          ? "bg-amber-500 dark:bg-amber-400"
          : "bg-red-500 dark:bg-red-400";

  const scoreColor =
    score >= 80
      ? "text-green-600 dark:text-green-400"
      : score >= 60
        ? "text-blue-600 dark:text-blue-400"
        : score >= 40
          ? "text-amber-600 dark:text-amber-400"
          : "text-red-600 dark:text-red-400";

  return (
    <div>
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Readiness Score
      </span>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-2xl font-bold tabular-nums ${scoreColor}`}>
          {score}
        </span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">/ 100</span>
      </div>
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

function DecisionBlock({ decision }: { decision: TradeDecision }) {
  if (decision === "EXECUTE_TRADE") {
    return (
      <div className="rounded-xl bg-green-600 p-4 text-center">
        <span className="text-lg font-bold text-white">
          ✓ Execute Trade
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-red-600 p-4 text-center">
      <span className="text-lg font-bold text-white">
        ✕ Do Not Trade
      </span>
    </div>
  );
}

function InvalidationRiskIndicator({ risk }: { risk: InvalidationRisk }) {
  const config = riskConfig[risk];
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Invalidation Risk
      </span>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${config.dot}`} />
        <span className={`text-sm font-medium ${config.color}`}>
          {config.label}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TradingSignalCard({
  signalBias,
  signalScore,
  confidence,
  readinessScore,
  status,
  decision,
  invalidationRisk,
}: TradingSignalCardProps) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header: title + status badge */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Trade Decision
        </h2>
        <StatusBadge status={status} />
      </div>

      {/* Signal bias + score */}
      <div className="mt-4">
        <SignalBiasDisplay bias={signalBias} score={signalScore} />
      </div>

      {/* Confidence */}
      <div className="mt-4">
        <ConfidenceBar confidence={confidence} />
      </div>

      {/* Readiness score */}
      <div className="mt-4">
        <ReadinessBar score={readinessScore} />
      </div>

      {/* Trade decision — most prominent element */}
      <div className="mt-5">
        <DecisionBlock decision={decision} />
      </div>

      {/* Invalidation risk */}
      <div className="mt-4">
        <InvalidationRiskIndicator risk={invalidationRisk} />
      </div>
    </div>
  );
}
