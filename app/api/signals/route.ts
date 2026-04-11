import { NextResponse } from "next/server";

import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import {
  fetchCotHistory,
  computePercentileMetrics,
  getWeeklyDeltas,
  calculateAcceleration,
} from "@/lib/cotHistory";
import { generateSignal } from "@/lib/signals";
import { classifyExecution } from "@/lib/execution";
import { dispatchAlertIfNeeded } from "@/lib/alerts";

import type { Signal, SignalMetrics, OpenInterestTrend, PriceTrend } from "@/lib/signals";
import type { ExecutionSignal, Alert } from "@/lib/execution";

/**
 * GET /api/signals
 *
 * Fetches gold price, COT data, historical COT data, and open interest,
 * then computes a consolidated trading signal using the weighted composite
 * scoring model, plus execution stage classification and alerts.
 *
 * Returns the signal with composite score, per-component breakdown,
 * confidence, reasoning, metrics, execution stage, alerts, and the raw
 * input trends for transparency.
 */

interface SignalResponse {
  signal: Signal;
  execution: ExecutionSignal;
  alerts: Alert[];
  inputs: {
    priceTrend: PriceTrend;
    oiTrend: OpenInterestTrend;
    managedMoneyNet: number;
    commercialNet: number;
    percentileMetrics: SignalMetrics | null;
  };
  timestamp: string;
}

/** Fallback ratio to estimate previous OI when historical data is unavailable. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

export async function GET(): Promise<NextResponse<SignalResponse | { error: string }>> {
  try {
    const [goldPrice, cotReport, cotHistory] = await Promise.all([
      fetchGoldPrice(),
      fetchCotReport(),
      fetchCotHistory(),
    ]);

    if (!cotReport) {
      return NextResponse.json(
        { error: "Signal generation failed — COT data unavailable" },
        { status: 503 },
      );
    }

    // Compute percentile metrics against historical distribution
    const percentiles = computePercentileMetrics(
      cotReport.largeSpeculators.net,
      cotReport.commercials.net,
      cotHistory,
    );

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
    // If historical data is available, use the previous week's OI.
    const oiCurrent = cotReport.openInterest;
    let oiPrevious: number;

    if (cotHistory.length >= 2) {
      // Use second-to-last historical point as previous OI
      oiPrevious = cotHistory[cotHistory.length - 2].openInterest;
    } else {
      oiPrevious = Math.round(oiCurrent * PREVIOUS_OI_ESTIMATE_RATIO);
    }

    const oiTrend: OpenInterestTrend = {
      current: oiCurrent,
      previous: oiPrevious,
      trend: oiCurrent > oiPrevious ? "up" : "down",
    };

    // Compute positioning delta (weekly change) and acceleration (rate of change)
    const deltas = getWeeklyDeltas(cotHistory);
    const acceleration = calculateAcceleration(cotHistory);

    const signalInput = {
      priceTrend,
      oiTrend,
      cotData: cotReport,
      percentiles,
      deltas,
      acceleration,
    };

    const signal = generateSignal(signalInput);

    // Classify execution stage and generate alerts
    const { execution, alerts } = classifyExecution(signal, signalInput);

    // Dispatch Telegram alert if conditions warrant (fire-and-forget).
    // Uses void to explicitly mark the floating promise as intentional —
    // alert delivery should never delay the API response.
    void dispatchAlertIfNeeded({
      execution,
      score: signal.score,
      managedMoneyDelta: deltas?.managedMoney ?? 0,
      oiTrend,
    });

    const response: SignalResponse = {
      signal,
      execution,
      alerts,
      inputs: {
        priceTrend,
        oiTrend,
        managedMoneyNet: cotReport.largeSpeculators.net,
        commercialNet: cotReport.commercials.net,
        percentileMetrics: signal.metrics,
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
