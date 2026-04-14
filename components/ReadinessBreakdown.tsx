"use client";

import type { ReadinessBreakdownProps } from "@/components/types";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-600 dark:text-green-400";
  if (score >= 50) return "text-blue-600 dark:text-blue-400";
  if (score >= 30) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function barColor(score: number): string {
  if (score >= 70) return "bg-green-500 dark:bg-green-400";
  if (score >= 50) return "bg-blue-500 dark:bg-blue-400";
  if (score >= 30) return "bg-amber-500 dark:bg-amber-400";
  return "bg-red-500 dark:bg-red-400";
}

function totalColor(score: number): string {
  if (score >= 80) return "text-green-600 dark:text-green-400";
  if (score >= 60) return "text-blue-600 dark:text-blue-400";
  if (score >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ReadinessBreakdown({ components, totalScore }: ReadinessBreakdownProps) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Readiness Breakdown
      </h2>

      {/* Total score */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className={`text-3xl font-bold tabular-nums ${totalColor(totalScore)}`}>
          {totalScore}
        </span>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">/ 100</span>
      </div>

      {/* Component rows */}
      <div className="mt-4 space-y-3">
        {components.map((component) => (
          <div key={component.label}>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">
                {component.label}
                <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500">
                  ({component.weight}%)
                </span>
              </span>
              <span className={`font-mono font-medium ${scoreColor(component.score)}`}>
                {component.score}
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div
                className={`h-full rounded-full transition-all ${barColor(component.score)}`}
                style={{ width: `${component.score}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
