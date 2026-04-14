"use client";

import type { LifecyclePanelProps, LifecycleStatus } from "@/components/types";

// ---------------------------------------------------------------------------
// Status badge styles
// ---------------------------------------------------------------------------

const lifecycleStyles: Record<LifecycleStatus, { bg: string; text: string; label: string; pulse: boolean }> = {
  ACTIVE: {
    bg: "bg-blue-100 dark:bg-blue-900",
    text: "text-blue-800 dark:text-blue-200",
    label: "Active",
    pulse: true,
  },
  WAITING: {
    bg: "bg-amber-100 dark:bg-amber-900",
    text: "text-amber-800 dark:text-amber-200",
    label: "Waiting",
    pulse: false,
  },
  CONFIRMED: {
    bg: "bg-green-100 dark:bg-green-900",
    text: "text-green-800 dark:text-green-200",
    label: "Confirmed",
    pulse: false,
  },
  INVALIDATED: {
    bg: "bg-red-100 dark:bg-red-900",
    text: "text-red-800 dark:text-red-200",
    label: "Invalidated",
    pulse: false,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(fromISO: string): string {
  const from = new Date(fromISO).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - from);

  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  return `${minutes}m ago`;
}

function formatCountdown(expiresISO: string): { text: string; urgent: boolean; expired: boolean } {
  const expires = new Date(expiresISO).getTime();
  const now = Date.now();
  const remainMs = expires - now;

  if (remainMs <= 0) return { text: "Expired", urgent: false, expired: true };

  const minutes = Math.floor(remainMs / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return { text: `${hours}h ${minutes % 60}m remaining`, urgent: false, expired: false };
  }
  return { text: `${minutes}m remaining`, urgent: true, expired: false };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LifecyclePanel({ lifecycle }: LifecyclePanelProps) {
  const style = lifecycleStyles[lifecycle.status];

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Signal Lifecycle
      </h2>

      {/* Status badge */}
      <div className="mt-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${style.bg} ${style.text}`}>
          {style.pulse && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          )}
          {style.label}
        </span>
      </div>

      {/* Info rows */}
      <div className="mt-4 space-y-3">
        {/* Time since creation */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            Signal Age
          </span>
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {formatDuration(lifecycle.createdAt)}
          </span>
        </div>

        {/* Expiry countdown */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            Expiry
          </span>
          {lifecycle.expiresAt ? (
            (() => {
              const countdown = formatCountdown(lifecycle.expiresAt);
              const color = countdown.expired
                ? "text-red-600 dark:text-red-400"
                : countdown.urgent
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-zinc-900 dark:text-zinc-100";
              return (
                <span className={`text-sm font-medium ${color}`}>
                  {countdown.text}
                </span>
              );
            })()
          ) : (
            <span className="text-sm text-zinc-400 dark:text-zinc-500">
              No expiry
            </span>
          )}
        </div>
      </div>

      {/* Invalidation warning */}
      {lifecycle.invalidationWarning && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/50">
          <div className="flex items-start gap-2">
            <span className="mt-px flex-shrink-0 text-sm">⚠</span>
            <span className="text-sm text-amber-800 dark:text-amber-200">
              {lifecycle.invalidationWarning}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
