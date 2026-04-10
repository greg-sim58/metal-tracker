import { NextResponse } from "next/server";

import { fetchCotReport } from "@/lib/cot";

import type { OpenInterestTrend } from "@/lib/signals";

/**
 * GET /api/open-interest
 *
 * Returns the current open interest level and trend direction for gold futures.
 *
 * Currently derives OI from the COT report (which contains the latest weekly
 * OI figure). The "previous" value is estimated at 95% of current as a
 * placeholder until a real historical data source (CME DataMine, Quandl, etc.)
 * is integrated.
 *
 * TODO: Replace placeholder previous-week OI with real historical data:
 *   - Option A: CME DataMine API (requires subscription)
 *   - Option B: Store weekly OI snapshots in a database
 *   - Option C: Parse multiple weeks from CFTC historical archives
 */

/** Fallback ratio to estimate previous OI when historical data is unavailable. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

export async function GET(): Promise<NextResponse<OpenInterestTrend | { error: string }>> {
  try {
    const cotReport = await fetchCotReport();

    if (!cotReport) {
      return NextResponse.json(
        { error: "Open interest data unavailable — COT report fetch failed" },
        { status: 503 },
      );
    }

    const current = cotReport.openInterest;
    const previous = Math.round(current * PREVIOUS_OI_ESTIMATE_RATIO);
    const trend = current > previous ? "up" : "down";

    const data: OpenInterestTrend = { current, previous, trend };

    return NextResponse.json(data);
  } catch (error) {
    console.error("Open interest API route error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
