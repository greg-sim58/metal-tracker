// Hook: COT report data from Supabase
//
// Fetches the latest COT report from the cot_reports table.
// Maps the flat DB row back to the CotReport interface used
// throughout the app.

import { useQuery } from "@tanstack/react-query";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

import type { CotReport } from "@/lib/cot";

/** React Query cache key for COT report data. */
export const COT_REPORT_KEY = ["cot-report"] as const;

/** Polling interval fallback (15 minutes — COT updates weekly but stays in sync). */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Fetch the most recent COT report row from Supabase and map it
 * to the existing CotReport interface.
 */
async function fetchCotReportFromSupabase(): Promise<CotReport | null> {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase
    .from("cot_reports")
    .select()
    .order("report_date", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    if (error?.code === "PGRST116") return null;
    if (error) {
      console.error("Failed to fetch COT report from Supabase:", error.message);
    }
    return null;
  }

  return {
    market: data.market,
    date: data.report_date,
    openInterest: data.open_interest,
    commercials: {
      long: data.commercials_long,
      short: data.commercials_short,
      net: data.commercials_net,
    },
    largeSpeculators: {
      long: data.large_spec_long,
      short: data.large_spec_short,
      net: data.large_spec_net,
    },
    smallTraders: {
      long: data.small_traders_long,
      short: data.small_traders_short,
      net: data.small_traders_net,
    },
  };
}

/**
 * React Query hook for the latest COT report.
 *
 * - Polls every 15 minutes as fallback (COT data is weekly).
 * - Returns `null` when the table is empty.
 */
export function useCotReport() {
  return useQuery({
    queryKey: COT_REPORT_KEY,
    queryFn: fetchCotReportFromSupabase,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
