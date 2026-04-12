import { NextResponse } from "next/server";

import { runBacktest } from "@/lib/backtest";

/**
 * GET /api/backtest
 *
 * Run the full backtesting engine against historical COT and gold price data.
 *
 * Returns a comprehensive JSON report including:
 *   - Summary performance metrics (win rate, Sharpe, drawdown, etc.)
 *   - Breakdown by execution stage (SETUP/TRIGGER/CONFIRMATION)
 *   - Breakdown by composite score range (strong/medium/weak)
 *   - Equity curve data points for visualization
 *   - Win/loss return distribution histogram
 *   - Individual trade records
 *
 * This endpoint is expensive (~5-10 seconds) due to fetching external data
 * and replaying the signal engine for every historical week. Results are
 * deterministic for the same input data, so client-side caching is
 * recommended.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await runBacktest();

    if (!report) {
      return NextResponse.json(
        { error: "Insufficient data for backtesting — COT or price history unavailable" },
        { status: 503 },
      );
    }

    return NextResponse.json(report);
  } catch (error) {
    console.error("Backtest API error:", error);
    return NextResponse.json(
      { error: "Internal server error during backtesting" },
      { status: 500 },
    );
  }
}
