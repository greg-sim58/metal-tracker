"use client";

import type { Signal, SignalDirection, SignalMetrics, ScoreBreakdown } from "@/lib/signals";
import type { ExecutionSignal, Alert, SignalStage, Bias, AlertLevel } from "@/lib/execution";

interface SignalIndicatorProps {
  signal: Signal | null;
  execution: ExecutionSignal | null;
  alerts: Alert[];
}

const directionStyles: Record<SignalDirection, {
  bg: string;
  border: string;
  text: string;
  badge: string;
  icon: string;
}> = {
  BUY: {
    bg: "bg-green-50 dark:bg-green-950/40",
    border: "border-green-200 dark:border-green-800",
    text: "text-green-700 dark:text-green-300",
    badge: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    icon: "\u2191",
  },
  SELL: {
    bg: "bg-red-50 dark:bg-red-950/40",
    border: "border-red-200 dark:border-red-800",
    text: "text-red-700 dark:text-red-300",
    badge: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    icon: "\u2193",
  },
  CAUTION: {
    bg: "bg-amber-50 dark:bg-amber-950/40",
    border: "border-amber-200 dark:border-amber-800",
    text: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    icon: "\u26A0",
  },
  NEUTRAL: {
    bg: "bg-zinc-50 dark:bg-zinc-800/40",
    border: "border-zinc-200 dark:border-zinc-700",
    text: "text-zinc-600 dark:text-zinc-300",
    badge: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    icon: "\u2014",
  },
};

// ---------------------------------------------------------------------------
// Score display
// ---------------------------------------------------------------------------

/**
 * Large composite score badge — the primary signal number.
 * Green for positive, red for negative, zinc for zero.
 */
function CompositeScoreBadge({ score }: { score: number }) {
  const color =
    score > 0
      ? "text-green-600 dark:text-green-400"
      : score < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-500 dark:text-zinc-400";

  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-3xl font-bold tabular-nums ${color}`}>
        {score > 0 ? "+" : ""}{score}
      </span>
      <span className="text-xs text-zinc-400 dark:text-zinc-500">/ 100</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence bar
// ---------------------------------------------------------------------------

function ConfidenceBar({ confidence }: { confidence: number }) {
  const barColor =
    confidence >= 70
      ? "bg-green-500 dark:bg-green-400"
      : confidence >= 45
        ? "bg-amber-500 dark:bg-amber-400"
        : "bg-zinc-400 dark:bg-zinc-500";

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">Confidence</span>
        <span className="font-medium text-zinc-700 dark:text-zinc-200">
          {confidence}%
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${confidence}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score breakdown
// ---------------------------------------------------------------------------

/** Human-readable labels for each scoring component. */
const COMPONENT_LABELS: Record<keyof ScoreBreakdown, string> = {
  cotPositioning: "COT Positioning",
  delta: "Flow (Delta)",
  acceleration: "Acceleration",
  openInterest: "Open Interest",
  priceTrend: "Price Trend",
};

/** Component weights — mirrored from signals.ts for display purposes. */
const COMPONENT_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  cotPositioning: 25,
  delta: 30,
  acceleration: 15,
  openInterest: 15,
  priceTrend: 15,
};

/**
 * Color for a component score value.
 * Positive = bullish (green), negative = bearish (red), zero = neutral.
 */
function componentScoreColor(value: number): string {
  if (value > 0.1) return "text-green-600 dark:text-green-400";
  if (value < -0.1) return "text-red-600 dark:text-red-400";
  return "text-zinc-500 dark:text-zinc-400";
}

/**
 * Bar color for a component score.
 * Uses green for positive, red for negative.
 */
function componentBarColor(value: number): string {
  if (value > 0) return "bg-green-500 dark:bg-green-400";
  if (value < 0) return "bg-red-500 dark:bg-red-400";
  return "bg-zinc-300 dark:bg-zinc-600";
}

/**
 * Individual component score row with a mini bar visualization.
 * Bar is centered at 50% (representing 0) and extends left for negative,
 * right for positive values.
 */
function ComponentScoreRow({
  label,
  score,
  weight,
}: {
  label: string;
  score: number;
  weight: number;
}) {
  // Score is -1 to +1; bar width is 0–50% of the track (half-width for each direction)
  const barWidth = Math.abs(score) * 50;
  const isPositive = score >= 0;
  const barColor = componentBarColor(score);
  const scoreColor = componentScoreColor(score);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">
          {label}
          <span className="ml-1 text-zinc-300 dark:text-zinc-600">({weight}%)</span>
        </span>
        <span className={`font-mono font-medium ${scoreColor}`}>
          {score > 0 ? "+" : ""}{score.toFixed(2)}
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        {/* Center line marker */}
        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-300 dark:bg-zinc-600" />
        {/* Score bar — extends from center left or right */}
        <div
          className={`absolute top-0 h-full rounded-full transition-all ${barColor}`}
          style={{
            width: `${barWidth}%`,
            left: isPositive ? "50%" : `${50 - barWidth}%`,
          }}
        />
      </div>
    </div>
  );
}

function BreakdownSection({ breakdown }: { breakdown: ScoreBreakdown }) {
  const keys = Object.keys(COMPONENT_LABELS) as Array<keyof ScoreBreakdown>;

  return (
    <div className="mt-4 space-y-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Score Breakdown
      </span>
      <div className="space-y-2">
        {keys.map((key) => (
          <ComponentScoreRow
            key={key}
            label={COMPONENT_LABELS[key]}
            score={breakdown[key]}
            weight={COMPONENT_WEIGHTS[key]}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Percentile bars
// ---------------------------------------------------------------------------

/**
 * Return the color class for a percentile bar segment based on its value.
 * Extremes (>90 or <10) are highlighted; moderate values are subdued.
 */
function percentileBarColor(percentile: number): string {
  if (percentile >= 90) return "bg-red-500 dark:bg-red-400";
  if (percentile >= 75) return "bg-amber-500 dark:bg-amber-400";
  if (percentile <= 10) return "bg-green-500 dark:bg-green-400";
  if (percentile <= 25) return "bg-emerald-400 dark:bg-emerald-500";
  return "bg-blue-400 dark:bg-blue-500";
}

/**
 * Return a human-readable label for the percentile zone.
 */
function percentileLabel(percentile: number): string {
  if (percentile >= 90) return "Extreme High";
  if (percentile >= 75) return "Elevated";
  if (percentile <= 10) return "Extreme Low";
  if (percentile <= 25) return "Depressed";
  return "Normal";
}

function PercentileBar({
  label,
  percentile,
}: {
  label: string;
  percentile: number;
}) {
  const barColor = percentileBarColor(percentile);
  const zone = percentileLabel(percentile);

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className="font-medium text-zinc-700 dark:text-zinc-200">
          {percentile}th pctl
          <span className="ml-1.5 text-zinc-400 dark:text-zinc-500">
            ({zone})
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${percentile}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delta / acceleration indicators
// ---------------------------------------------------------------------------

/**
 * Format a delta value with sign and locale formatting.
 * Returns "+12,000" for positive, "-8,000" for negative, "0" for zero.
 */
function formatDelta(value: number): string {
  const formatted = Math.abs(value).toLocaleString("en-US");
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return "0";
}

/**
 * Color class for delta values — green for positive (increasing longs),
 * red for negative (decreasing longs / increasing shorts).
 */
function deltaColor(value: number): string {
  if (value > 0) return "text-green-600 dark:text-green-400";
  if (value < 0) return "text-red-600 dark:text-red-400";
  return "text-zinc-500 dark:text-zinc-400";
}

function DeltaIndicator({
  label,
  delta,
}: {
  label: string;
  delta: number;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={`font-mono font-medium ${deltaColor(delta)}`}>
        {formatDelta(delta)} /wk
      </span>
    </div>
  );
}

function AccelerationIndicator({ acceleration }: { acceleration: number }) {
  const isIncreasing = acceleration > 0;
  const label = isIncreasing ? "Momentum increasing" : "Momentum slowing";
  const icon = isIncreasing ? "\u25B2" : "\u25BC";
  const color = isIncreasing
    ? "text-green-600 dark:text-green-400"
    : "text-amber-600 dark:text-amber-400";

  if (acceleration === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-500">
        <span>\u2014</span>
        <span>Momentum flat</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warning callouts
// ---------------------------------------------------------------------------

/**
 * Detect warning-worthy reasoning strings and render as prominent callouts.
 * Matches key patterns from the detectWarnings() function in signals.ts.
 */
function WarningCallouts({ reasoning }: { reasoning: string[] }) {
  const warningPatterns = [
    "exhaustion",
    "capitulation",
    "weakening trend",
  ];

  const warnings = reasoning.filter((reason) =>
    warningPatterns.some((pattern) => reason.toLowerCase().includes(pattern))
  );

  if (warnings.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200"
        >
          <span className="mt-px flex-shrink-0">{"\u26A0\uFE0F"}</span>
          <span>{warning}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution stage display
// ---------------------------------------------------------------------------

/** Stage badge styles — escalating visual prominence. */
const stageStyles: Record<SignalStage, {
  bg: string;
  text: string;
  ring: string;
}> = {
  SETUP: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
    ring: "ring-blue-300 dark:ring-blue-700",
  },
  TRIGGER: {
    bg: "bg-amber-100 dark:bg-amber-900/50",
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-300 dark:ring-amber-700",
  },
  CONFIRMATION: {
    bg: "bg-red-100 dark:bg-red-900/50",
    text: "text-red-700 dark:text-red-300",
    ring: "ring-red-300 dark:ring-red-700",
  },
};

/** Bias indicator styles. */
const biasStyles: Record<Bias, {
  text: string;
  icon: string;
}> = {
  BULLISH: { text: "text-green-600 dark:text-green-400", icon: "\u25B2" },
  BEARISH: { text: "text-red-600 dark:text-red-400", icon: "\u25BC" },
  NEUTRAL: { text: "text-zinc-500 dark:text-zinc-400", icon: "\u2014" },
};

function ExecutionStageSection({ execution }: { execution: ExecutionSignal }) {
  const stage = stageStyles[execution.stage];
  const bias = biasStyles[execution.bias];

  return (
    <div className="mt-4 space-y-3">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Execution Stage
      </span>

      {/* Stage badge + bias indicator */}
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${stage.bg} ${stage.text} ${stage.ring}`}>
          {execution.stage}
        </span>
        <span className={`inline-flex items-center gap-1 text-sm font-semibold ${bias.text}`}>
          <span>{bias.icon}</span>
          {execution.bias}
        </span>
      </div>

      {/* Stage message */}
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        {execution.message}
      </p>

      {/* Action suggestions */}
      {execution.actions.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Suggested Actions
          </span>
          <ul className="space-y-1">
            {execution.actions.map((action) => (
              <li
                key={action}
                className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300"
              >
                <span className="mt-0.5 flex-shrink-0 text-zinc-400 dark:text-zinc-500">{"\u25B8"}</span>
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts display
// ---------------------------------------------------------------------------

/** Alert level styles — escalating visual intensity. */
const alertStyles: Record<AlertLevel, {
  bg: string;
  border: string;
  text: string;
  icon: string;
}> = {
  info: {
    bg: "bg-blue-50 dark:bg-blue-950/40",
    border: "border-blue-200 dark:border-blue-800",
    text: "text-blue-700 dark:text-blue-300",
    icon: "\u2139\uFE0F",
  },
  warning: {
    bg: "bg-amber-50 dark:bg-amber-950/40",
    border: "border-amber-200 dark:border-amber-800",
    text: "text-amber-700 dark:text-amber-300",
    icon: "\u26A0\uFE0F",
  },
  critical: {
    bg: "bg-red-50 dark:bg-red-950/40",
    border: "border-red-200 dark:border-red-800",
    text: "text-red-700 dark:text-red-300",
    icon: "\uD83D\uDEA8",
  },
};

function AlertsSection({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Alerts
      </span>
      <div className="space-y-1.5">
        {alerts.map((alert) => {
          const style = alertStyles[alert.level];
          return (
            <div
              key={alert.text}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${style.bg} ${style.border} ${style.text}`}
            >
              <span className="mt-px flex-shrink-0">{style.icon}</span>
              <span>{alert.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics detail section (delta + acceleration)
// ---------------------------------------------------------------------------

function DeltaSection({ metrics }: { metrics: SignalMetrics }) {
  const hasDeltaData = metrics.managedMoneyDelta !== 0 || metrics.commercialsDelta !== 0;

  if (!hasDeltaData && metrics.acceleration === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Weekly Positioning Change
      </span>
      {hasDeltaData && (
        <div className="space-y-1">
          <DeltaIndicator label="Managed Money" delta={metrics.managedMoneyDelta} />
          <DeltaIndicator label="Commercials" delta={metrics.commercialsDelta} />
        </div>
      )}
      <AccelerationIndicator acceleration={metrics.acceleration} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SignalIndicator({ signal, execution, alerts }: SignalIndicatorProps) {
  if (!signal) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Trading Signal
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Signal data unavailable
        </p>
      </div>
    );
  }

  const style = directionStyles[signal.signal];
  const metrics = signal.metrics;

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-6`}>
      {/* Header: title + signal badge */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Trading Signal
        </h2>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${style.badge}`}>
          <span>{style.icon}</span>
          {signal.signal}
        </span>
      </div>

      {/* Composite score + confidence */}
      <div className="mt-3">
        <CompositeScoreBadge score={signal.score} />
      </div>

      <ConfidenceBar confidence={signal.confidence} />

      {/* Score breakdown per component */}
      <BreakdownSection breakdown={signal.breakdown} />

      {/* Percentile positioning + delta/acceleration details */}
      {metrics && (
        <>
          <div className="mt-4 space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Percentile Positioning
            </span>
            <PercentileBar
              label="Managed Money"
              percentile={metrics.managedMoneyPercentile}
            />
            <PercentileBar
              label="Commercials"
              percentile={metrics.commercialsPercentile}
            />
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
              Based on {metrics.historyLength.toLocaleString("en-US")} weeks of data
              ({metrics.oldestDate} to {metrics.newestDate})
            </p>
          </div>

          <DeltaSection metrics={metrics} />
        </>
      )}

      {/* Warning callouts */}
      <WarningCallouts reasoning={signal.reasoning} />

      {/* Execution stage */}
      {execution && <ExecutionStageSection execution={execution} />}

      {/* Alerts */}
      <AlertsSection alerts={alerts} />

      {/* Full analysis reasoning */}
      <div className="mt-4">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Analysis
        </span>
        <ul className="mt-2 space-y-1.5">
          {signal.reasoning.map((reason) => (
            <li
              key={reason}
              className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300"
            >
              <span className="mt-1 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500" />
              {reason}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
