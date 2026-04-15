// Hook: gold price data from Supabase
//
// Fetches the latest gold price from the gold_prices table.
// Falls back to polling every 60 seconds when Realtime is not connected.

import { useQuery } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

import type { GoldPrice } from "@/lib/gold";

/** React Query cache key for gold price data. */
export const GOLD_PRICE_KEY = ["gold-price"] as const;

/** Polling interval when Realtime is not handling updates (15 minutes). */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Fetch the most recent gold price row from Supabase.
 *
 * Returns the data mapped to the existing GoldPrice interface
 * so downstream components don't need to change.
 */
async function fetchGoldPriceFromSupabase(): Promise<GoldPrice | null> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("gold_prices")
    .select()
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    // PGRST116 = "no rows returned" — not a real error, just empty table
    if (error?.code === "PGRST116") return null;
    if (error) {
      console.error("Failed to fetch gold price from Supabase:", error.message);
    }
    return null;
  }

  return {
    price: Number(data.price),
    currency: data.currency,
    timestamp: data.source_timestamp,
  };
}

/**
 * React Query hook for the latest gold price.
 *
 * - Polls every 15 min as fallback (Realtime invalidation is primary).
 * - Returns `null` data when the table is empty (pre-ingestion).
 */
export function useGoldPrice() {
  return useQuery({
    queryKey: GOLD_PRICE_KEY,
    queryFn: fetchGoldPriceFromSupabase,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
