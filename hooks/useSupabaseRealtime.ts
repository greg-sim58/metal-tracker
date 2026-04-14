// Hook: Supabase Realtime subscriptions + React Query cache invalidation
//
// Subscribes to Postgres changes on gold_prices, cot_reports, and cot_history
// tables. On any INSERT or UPDATE, the corresponding React Query cache key
// is invalidated so the UI re-fetches fresh data.
//
// Includes connection status tracking for hybrid polling fallback:
// when Realtime is connected, polling can be reduced; when disconnected,
// polling takes over.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { GOLD_PRICE_KEY } from "@/hooks/useGoldPrice";
import { COT_REPORT_KEY } from "@/hooks/useCotReport";
import { COT_HISTORY_KEY } from "@/hooks/useCotHistory";

import type { RealtimeChannel } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

export interface UseSupabaseRealtimeResult {
  /** Current WebSocket connection status. */
  status: RealtimeStatus;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to Supabase Realtime changes on all dashboard tables.
 *
 * On receiving a change event, invalidates the corresponding React Query
 * cache key so the hook re-fetches from Supabase automatically.
 *
 * Usage: call once in the dashboard root component.
 *
 * ```tsx
 * const { status } = useSupabaseRealtime();
 * ```
 */
export function useSupabaseRealtime(): UseSupabaseRealtimeResult {
  const queryClient = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const channel = supabase
      .channel("dashboard-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "gold_prices" },
        () => {
          queryClient.invalidateQueries({ queryKey: [...GOLD_PRICE_KEY] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cot_reports" },
        () => {
          queryClient.invalidateQueries({ queryKey: [...COT_REPORT_KEY] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cot_history" },
        () => {
          queryClient.invalidateQueries({ queryKey: [...COT_HISTORY_KEY] });
        },
      )
      .subscribe((subscriptionStatus) => {
        if (subscriptionStatus === "SUBSCRIBED") {
          setStatus("connected");
        } else if (
          subscriptionStatus === "CLOSED" ||
          subscriptionStatus === "CHANNEL_ERROR"
        ) {
          setStatus("disconnected");
        } else {
          setStatus("connecting");
        }
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [queryClient]);

  return { status };
}
