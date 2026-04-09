"use client";

import type { CotReport } from "@/lib/cot";

interface SentimentPanelProps {
  data: CotReport | null;
}

export default function SentimentPanel({ data }: SentimentPanelProps) {
  if (!data) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Market Sentiment
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          COT data unavailable
        </p>
      </div>
    );
  }

  const sentiment = data.netPosition > 0 ? "Bullish" : data.netPosition < 0 ? "Bearish" : "Neutral";
  const sentimentColor =
    data.netPosition > 0
      ? "text-green-600 dark:text-green-400"
      : data.netPosition < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-600 dark:text-zinc-400";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Market Sentiment
      </h2>
      <div className="mt-4 space-y-3">
        <div className="flex justify-between">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            Net Position
          </span>
          <span className={`text-sm font-medium ${sentimentColor}`}>
            {data.netPosition > 0 ? "+" : ""}
            {data.netPosition.toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            Long Positions
          </span>
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {data.longPositions.toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            Short Positions
          </span>
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {data.shortPositions.toLocaleString()}
          </span>
        </div>
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="flex justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Outlook
            </span>
            <span className={`text-sm font-semibold ${sentimentColor}`}>
              {sentiment}
            </span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
        Report date: {data.date}
      </p>
    </div>
  );
}
