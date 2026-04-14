"use client";

import type { MTFPanelProps, TimeframeEntry, TimeframeStatus } from "@/components/types";

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

const statusConfig: Record<TimeframeStatus, { dot: string; text: string; label: string }> = {
  ALIGNED: {
    dot: "bg-green-500",
    text: "text-green-600 dark:text-green-400",
    label: "Aligned",
  },
  NOT_ALIGNED: {
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
    label: "Not Aligned",
  },
  PENDING: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    label: "Pending",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TimeframeRow({ entry }: { entry: TimeframeEntry }) {
  const config = statusConfig[entry.status];

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          {entry.label}
        </span>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {entry.description}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${config.dot}`} />
        <span className={`text-sm font-medium ${config.text}`}>
          {config.label}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MTFPanel({ timeframes, isAligned }: MTFPanelProps) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Multi-Timeframe Alignment
      </h2>

      <div className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {timeframes.map((entry) => (
          <TimeframeRow key={entry.label} entry={entry} />
        ))}
      </div>

      {/* Summary */}
      <div className="mt-3">
        {isAligned ? (
          <div className="rounded-lg bg-green-50 p-3 text-center dark:bg-green-950/30">
            <span className="text-sm font-semibold text-green-700 dark:text-green-300">
              ✓ All Timeframes Aligned
            </span>
          </div>
        ) : (
          <div className="rounded-lg bg-amber-50 p-3 text-center dark:bg-amber-950/30">
            <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">
              ⚠ Not Aligned
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
