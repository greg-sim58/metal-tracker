// Data ingestion API route
//
// POST /api/ingest
//
// Fetches latest gold price and COT data from external sources
// (gold-api.com, CFTC) and writes them into Supabase tables.
// Designed to be called by a cron job (Vercel Cron, external scheduler).
//
// Auth: Bearer token via INGEST_API_KEY env var.
// Write access: uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import { fetchCotHistory } from "@/lib/cotHistory";

import type { Database } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS)
// ---------------------------------------------------------------------------

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
    );
  }

  return createClient<Database>(url, serviceKey);
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

function isAuthorized(request: Request): boolean {
  const apiKey = process.env.INGEST_API_KEY;

  // If no key is configured, reject all requests for safety
  if (!apiKey) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  // Expect "Bearer <key>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;

  return parts[1] === apiKey;
}

// ---------------------------------------------------------------------------
// Ingestion logic
// ---------------------------------------------------------------------------

interface IngestResult {
  goldPrice: { inserted: boolean; error?: string };
  cotReport: { upserted: boolean; error?: string };
  cotHistory: { upserted: number; error?: string };
}

async function ingestGoldPrice(
  supabase: ReturnType<typeof getAdminClient>,
): Promise<IngestResult["goldPrice"]> {
  const gold = await fetchGoldPrice();
  if (!gold) {
    return { inserted: false, error: "Failed to fetch gold price from upstream" };
  }

  const { error } = await supabase.from("gold_prices").insert({
    price: gold.price,
    currency: gold.currency,
    source_timestamp: gold.timestamp,
  });

  if (error) {
    return { inserted: false, error: error.message };
  }

  return { inserted: true };
}

async function ingestCotReport(
  supabase: ReturnType<typeof getAdminClient>,
): Promise<IngestResult["cotReport"]> {
  const report = await fetchCotReport();
  if (!report) {
    return { upserted: false, error: "Failed to fetch COT report from upstream" };
  }

  const { error } = await supabase.from("cot_reports").upsert(
    {
      report_date: report.date,
      market: report.market,
      open_interest: report.openInterest,
      commercials_long: report.commercials.long,
      commercials_short: report.commercials.short,
      commercials_net: report.commercials.net,
      large_spec_long: report.largeSpeculators.long,
      large_spec_short: report.largeSpeculators.short,
      large_spec_net: report.largeSpeculators.net,
      small_traders_long: report.smallTraders.long,
      small_traders_short: report.smallTraders.short,
      small_traders_net: report.smallTraders.net,
    },
    { onConflict: "report_date" },
  );

  if (error) {
    return { upserted: false, error: error.message };
  }

  return { upserted: true };
}

async function ingestCotHistory(
  supabase: ReturnType<typeof getAdminClient>,
): Promise<IngestResult["cotHistory"]> {
  const history = await fetchCotHistory();
  if (!history || history.length === 0) {
    return { upserted: 0, error: "Failed to fetch COT history from upstream" };
  }

  const rows = history.map((point) => ({
    report_date: point.date,
    managed_money_net: point.managedMoneyNet,
    commercials_net: point.commercialsNet,
    open_interest: point.openInterest,
  }));

  // Upsert in batches of 500 to avoid payload limits
  const BATCH_SIZE = 500;
  let totalUpserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("cot_history")
      .upsert(batch, { onConflict: "report_date" });

    if (error) {
      return {
        upserted: totalUpserted,
        error: `Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`,
      };
    }

    totalUpserted += batch.length;
  }

  return { upserted: totalUpserted };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const supabase = getAdminClient();

    const [goldResult, cotResult, historyResult] = await Promise.all([
      ingestGoldPrice(supabase),
      ingestCotReport(supabase),
      ingestCotHistory(supabase),
    ]);

    const result: IngestResult = {
      goldPrice: goldResult,
      cotReport: cotResult,
      cotHistory: historyResult,
    };

    // Determine overall status
    const hasErrors =
      goldResult.error || cotResult.error || historyResult.error;

    return NextResponse.json(
      { data: result, timestamp: new Date().toISOString() },
      { status: hasErrors ? 207 : 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown ingestion error";

    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
