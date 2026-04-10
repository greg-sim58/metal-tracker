import { NextResponse } from "next/server";

import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import { generateSignal } from "@/lib/signals";

import type { Signal, OpenInterestTrend, PriceTrend } from "@/lib/signals";

/**
 * GET /api/signals
 *
 * Fetches gold price, COT data, and open interest, then computes
 * a consolidated trading signal using the contrarian model.
 *
 * Returns the signal with confidence and reasoning, plus the raw
 * input trends for transparency.
 */

interface SignalResponse {
  signal: Signal;
  inputs: {
    priceTrend: PriceTrend;
    oiTrend: OpenInterestTrend;
    managedMoneyNet: number;
    commercialNet: number;
  };
  timestamp: string;
}

/** Fallback ratio to estimate previous OI when historical data is unavailable. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

export async function GET(): Promise<NextResponse<SignalResponse | { error: string }>> {
  try {
    const [goldPrice, cotReport] = await Promise.all([
      fetchGoldPrice(),
      fetchCotReport(),
    ]);

    if (!cotReport) {
      return NextResponse.json(
        { error: "Signal generation failed — COT data unavailable" },
        { status: 503 },
      );
    }

    // Derive price trend from gold price data.
    // The free gold-api.com endpoint only returns the current spot price,
    // so we default to "up" as a placeholder. In production, this would
    // compare current price to a stored previous close or moving average.
    //
    // TODO: Replace with real price trend detection:
    //   - Compare to previous day's close (requires historical storage)
    //   - Compare to 20-day SMA (requires price history API)
    const priceTrend: PriceTrend = "up";

    // Derive OI trend from COT report open interest.
    // Uses estimated previous value until real historical OI is available.
    const oiCurrent = cotReport.openInterest;
    const oiPrevious = Math.round(oiCurrent * PREVIOUS_OI_ESTIMATE_RATIO);
    const oiTrend: OpenInterestTrend = {
      current: oiCurrent,
      previous: oiPrevious,
      trend: oiCurrent > oiPrevious ? "up" : "down",
    };

    const signal = generateSignal({
      priceTrend,
      oiTrend,
      cotData: cotReport,
    });

    const response: SignalResponse = {
      signal,
      inputs: {
        priceTrend,
        oiTrend,
        managedMoneyNet: cotReport.largeSpeculators.net,
        commercialNet: cotReport.commercials.net,
      },
      timestamp: goldPrice?.timestamp ?? new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Signals API route error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
