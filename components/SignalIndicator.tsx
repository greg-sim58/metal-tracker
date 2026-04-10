"use client";

import type { Signal } from "@/lib/signals";

interface SignalIndicatorProps {
  signals: Signal[];
}

const signalStyles: Record<Signal["type"], { bg: string; text: string; label: string }> = {
  buy: {
    bg: "bg-green-50 dark:bg-green-950",
    text: "text-green-700 dark:text-green-300",
    label: "BUY",
  },
  sell: {
    bg: "bg-red-50 dark:bg-red-950",
    text: "text-red-700 dark:text-red-300",
    label: "SELL",
  },
  hold: {
    bg: "bg-zinc-50 dark:bg-zinc-800",
    text: "text-zinc-700 dark:text-zinc-300",
    label: "HOLD",
  },
};

export default function SignalIndicator({ signals }: SignalIndicatorProps) {
  if (signals.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Trading Signals
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          No signals available
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Trading Signals
      </h2>
      <div className="mt-4 space-y-3">
        {signals.map((signal) => {
          const style = signalStyles[signal.type];
          const key = `${signal.type}-${signal.timestamp}-${signal.reason}`;
          return (
            <div
              key={key}
              className={`flex items-center justify-between rounded-md px-4 py-3 ${style.bg}`}
            >
              <div className="flex-1">
                <span className={`text-sm font-semibold ${style.text}`}>
                  {style.label}
                </span>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {signal.reason}
                </p>
              </div>
              <div className="ml-4 text-right">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((dot) => (
                    <div
                      key={`${key}-dot-${dot}`}
                      className={`h-2 w-2 rounded-full ${
                        dot <= signal.strength
                          ? signal.type === "buy"
                            ? "bg-green-500"
                            : signal.type === "sell"
                              ? "bg-red-500"
                              : "bg-zinc-400"
                          : "bg-zinc-200 dark:bg-zinc-700"
                      }`}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                  {new Date(signal.timestamp).toLocaleDateString("en-US")}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
