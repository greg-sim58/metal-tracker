// Server action: Refresh dashboard data
//
// Calls the ingestion logic to fetch fresh data from external APIs
// and invalidate the React Query cache. Called from the dashboard
// "Update Data" button.
//
// This runs on the server, so it has access to SUPABASE_SERVICE_ROLE_KEY
// and INGEST_API_KEY without exposing them to the client.

"use server";

import { createClient } from "@supabase/supabase-js";

import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import { fetchCotHistory } from "@/lib/cotHistory";

import type { Database } from "@/lib/supabase/types";

interface RefreshResult {
  success: boolean;
  goldPrice?: { price: number; currency: string; timestamp: string };
  cotReport?: { reportDate: string };
  cotHistory?: { count: number };
  error?: string;
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient<Database>(url, serviceKey);
}

export async function refreshDashboardData(): Promise<RefreshResult> {
  try {
    const supabase = getAdminClient();

    // Fetch gold price from external API
    const goldData = await fetchGoldPrice();
    if (goldData) {
      const { error: goldError } = await supabase
        .from("gold_prices")
        .insert({
          price: goldData.price,
          currency: goldData.currency,
          source_timestamp: goldData.timestamp,
        });

      if (goldError) {
        console.error("Failed to insert gold price:", goldError);
      }
    }

    // Fetch COT report from external API
    const cotData = await fetchCotReport();
    if (cotData) {
      const { error: cotError } = await supabase
        .from("cot_reports")
        .upsert(
          {
            report_date: cotData.date,
            market: cotData.market,
            open_interest: cotData.openInterest,
            commercials_long: cotData.commercials.long,
            commercials_short: cotData.commercials.short,
            commercials_net: cotData.commercials.net,
            large_spec_long: cotData.largeSpeculators.long,
            large_spec_short: cotData.largeSpeculators.short,
            large_spec_net: cotData.largeSpeculators.net,
            small_traders_long: cotData.smallTraders.long,
            small_traders_short: cotData.smallTraders.short,
            small_traders_net: cotData.smallTraders.net,
          },
          { onConflict: "report_date" },
        );

      if (cotError) {
        console.error("Failed to upsert COT report:", cotError);
      }
    }

    // Fetch COT history from external API
    const historyData = await fetchCotHistory();
    if (historyData && historyData.length > 0) {
      // Deduplicate by report_date — Socrata can return multiple rows for the same date
      interface HistoryRow {
        report_date: string;
        managed_money_net: number;
        commercials_net: number;
        open_interest: number;
      }

      const deduped = new Map<string, HistoryRow>();
      for (const point of historyData) {
        deduped.set(point.date, {
          report_date: point.date,
          managed_money_net: point.managedMoneyNet,
          commercials_net: point.commercialsNet,
          open_interest: point.openInterest,
        });
      }
      const rows = Array.from(deduped.values());

      // Upsert in batches of 500
      const BATCH_SIZE = 500;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error: historyError } = await supabase
          .from("cot_history")
          .upsert(batch, { onConflict: "report_date" });

        if (historyError) {
          console.error("Failed to upsert COT history batch:", historyError);
        }
      }
    }

    return {
      success: true,
      goldPrice: goldData
        ? { price: goldData.price, currency: goldData.currency, timestamp: goldData.timestamp }
        : undefined,
      cotReport: cotData ? { reportDate: cotData.date } : undefined,
      cotHistory: historyData ? { count: historyData.length } : undefined,
    };
  } catch (error) {
    console.error("refreshDashboardData error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}