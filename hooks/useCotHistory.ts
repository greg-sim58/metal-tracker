// Hook: historical COT data from Supabase
//
// Fetches 3 years of weekly COT history from the cot_history table
// for percentile / delta / acceleration analysis.

import { useQuery } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

import type { CotHistoryPoint } from "@/lib/cotHistory";

/** React Query cache key for COT history. */
export const COT_HISTORY_KEY = ["cot-history"] as const;

/** Polling interval fallback (15 minutes — history rarely changes). */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Fetch all COT history rows from Supabase, ordered by date ascending.
 * Maps to the CotHistoryPoint interface used by the analysis functions.
 */
async function fetchCotHistoryFromSupabase(): Promise<CotHistoryPoint[]> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("cot_history")
    .select()
    .order("report_date", { ascending: true });

  if (error) {
    console.error("Failed to fetch COT history from Supabase:", error.message);
    return [];
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row) => ({
    date: row.report_date,
    managedMoneyNet: row.managed_money_net,
    commercialsNet: row.commercials_net,
    openInterest: row.open_interest,
  }));
}

/**
 * React Query hook for historical COT data.
 *
 * - Returns an empty array when the table is empty.
 * - Polls every 10 minutes as fallback.
 * - Data is marked stale after 5 minutes (longer than price data).
 */
export function useCotHistory() {
  return useQuery({
    queryKey: COT_HISTORY_KEY,
    queryFn: fetchCotHistoryFromSupabase,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 5 * 60 * 1000,
  });
}
