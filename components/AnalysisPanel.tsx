"use client";

import type { AnalysisPanelProps } from "@/components/types";

export default function AnalysisPanel({ reasoning, highlightMessage }: AnalysisPanelProps) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Analysis
      </h2>

      {/* Highlight message */}
      <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
        <p className="text-sm font-medium italic text-zinc-800 dark:text-zinc-200">
          {highlightMessage}
        </p>
      </div>

      {/* Reasoning bullets */}
      {reasoning.length > 0 && (
        <ul className="mt-4 space-y-2">
          {reasoning.map((reason) => (
            <li key={reason} className="flex items-start gap-2.5">
              <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500" />
              <span className="text-sm text-zinc-600 dark:text-zinc-300">
                {reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
