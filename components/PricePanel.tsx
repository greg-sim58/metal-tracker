"use client";

import type { PricePanelProps } from "@/components/types";

export default function PricePanel({ price, currency, lastUpdated }: PricePanelProps) {
  if (price === null) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Gold Price
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Price data unavailable
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Gold Price
      </h2>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
          ${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {currency}
        </span>
      </div>
      {lastUpdated && (
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          Last updated: {new Date(lastUpdated).toLocaleString("en-US")}
        </p>
      )}
    </div>
  );
}
