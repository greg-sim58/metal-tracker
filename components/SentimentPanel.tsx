"use client";

import type { CotReport } from "@/lib/cot";

interface SentimentPanelProps {
  data: CotReport | null;
}

function PositionRow({ label, long, short, net }: {
  label: string;
  long: number;
  short: number;
  net: number;
}) {
  const netColor =
    net > 0
      ? "text-green-600 dark:text-green-400"
      : net < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-600 dark:text-zinc-400";

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <div className="flex justify-between text-sm">
        <span className="text-zinc-600 dark:text-zinc-300">
          Long: {long.toLocaleString()}
        </span>
        <span className="text-zinc-600 dark:text-zinc-300">
          Short: {short.toLocaleString()}
        </span>
        <span className={`font-medium ${netColor}`}>
          Net: {net > 0 ? "+" : ""}{net.toLocaleString()}
        </span>
      </div>
    </div>
  );
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

  const sentiment =
    data.netPosition > 0 ? "Bullish" : data.netPosition < 0 ? "Bearish" : "Neutral";
  const sentimentColor =
    data.netPosition > 0
      ? "text-green-600 dark:text-green-400"
      : data.netPosition < 0
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-600 dark:text-zinc-400";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Market Sentiment
        </h2>
        <span className={`text-sm font-semibold ${sentimentColor}`}>
          {sentiment}
        </span>
      </div>

      <div className="mt-4 flex justify-between border-b border-zinc-100 pb-3 dark:border-zinc-800">
        <div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Open Interest</span>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {data.openInterest.toLocaleString()}
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Net Position</span>
          <p className={`text-sm font-medium ${sentimentColor}`}>
            {data.netPosition > 0 ? "+" : ""}{data.netPosition.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <PositionRow
          label="Managed Money"
          long={data.managedMoney.long}
          short={data.managedMoney.short}
          net={data.managedMoney.net}
        />
        <PositionRow
          label="Commercials"
          long={data.commercials.long}
          short={data.commercials.short}
          net={data.commercials.net}
        />
        <PositionRow
          label="Swap Dealers"
          long={data.swapDealers.long}
          short={data.swapDealers.short}
          net={data.swapDealers.net}
        />
      </div>

      <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">
        CFTC report date: {data.date}
      </p>
    </div>
  );
}
