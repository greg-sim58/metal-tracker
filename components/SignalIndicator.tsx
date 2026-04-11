"use client";

import type { Signal, SignalDirection } from "@/lib/signals";

interface SignalIndicatorProps {
  signal: Signal | null;
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

export default function SignalIndicator({ signal }: SignalIndicatorProps) {
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Trading Signal
        </h2>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${style.badge}`}>
          <span>{style.icon}</span>
          {signal.signal}
        </span>
      </div>

      <ConfidenceBar confidence={signal.confidence} />

      {metrics && (
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
      )}

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
