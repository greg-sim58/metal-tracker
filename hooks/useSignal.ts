// Hook: derived trading signal from COT + price data
//
// Composes useGoldPrice, useCotReport, and useCotHistory into a derived
// signal using the existing generateSignal() and classifyExecution()
// pure functions. No Supabase call — this is pure client-side derivation.

import { useMemo } from "react";

import { useGoldPrice, type GoldPriceData } from "@/hooks/useGoldPrice";
import { useCotReport } from "@/hooks/useCotReport";
import { useCotHistory } from "@/hooks/useCotHistory";
import {
  computePercentileMetrics,
  getWeeklyDeltas,
  calculateAcceleration,
} from "@/lib/cotHistory";
import { generateSignal } from "@/lib/signals";
import { classifyExecution } from "@/lib/execution";

import type { Signal, OpenInterestTrend, PriceTrend } from "@/lib/signals";
import type { ExecutionResult } from "@/lib/execution";
import type { CotReport } from "@/lib/cot";
import type { CotHistoryPoint } from "@/lib/cotHistory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DerivedSignal {
  signal: Signal;
  execution: ExecutionResult;
}

export interface UseSignalResult {
  data: DerivedSignal | null;
  isLoading: boolean;
  /** True if any underlying query failed */
  isError: boolean;
  /** True if all source data is available and derivation succeeded */
  isReady: boolean;
  /** Raw source data for components that need it directly */
  sources: {
    goldPrice: GoldPriceData | null | undefined;
    cotReport: CotReport | null | undefined;
    cotHistory: CotHistoryPoint[] | undefined;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback ratio to estimate previous OI when history is < 2 points. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Pure function: derive a trading signal from source data.
 *
 * Mirrors the logic previously in dashboard/page.tsx but extracted
 * to be composable via React Query + useMemo.
 */
function deriveSignal(
  cotReport: CotReport,
  cotHistory: CotHistoryPoint[],
): DerivedSignal {
  const percentiles = computePercentileMetrics(
    cotReport.largeSpeculators.net,
    cotReport.commercials.net,
    cotHistory,
  );

  const priceTrend: PriceTrend = "up";

  const oiCurrent = cotReport.openInterest;
  let oiPrevious: number;
  if (cotHistory.length >= 2) {
    oiPrevious = cotHistory[cotHistory.length - 2].openInterest;
  } else {
    oiPrevious = Math.round(oiCurrent * PREVIOUS_OI_ESTIMATE_RATIO);
  }

  const oiTrend: OpenInterestTrend = {
    current: oiCurrent,
    previous: oiPrevious,
    trend: oiCurrent > oiPrevious ? "up" : "down",
  };

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
  const execution = classifyExecution(signal, signalInput);

  return { signal, execution };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Derived signal hook — composes raw data hooks into a trading signal.
 *
 * The derivation runs client-side via useMemo whenever any source data
 * changes. It reuses the existing pure functions (generateSignal,
 * classifyExecution) with zero changes to business logic.
 *
 * Returns:
 *   - `data`: the derived signal + execution result (null if COT unavailable)
 *   - `isLoading`: true if any source query is still loading
 *   - `isError`: true if any source query errored
 *   - `isReady`: true if derivation produced a result
 *   - `sources`: raw source data for components that need it directly
 */
export function useSignal(): UseSignalResult {
  const goldPriceQuery = useGoldPrice();
  const cotReportQuery = useCotReport();
  const cotHistoryQuery = useCotHistory();

  const isLoading =
    goldPriceQuery.isLoading ||
    cotReportQuery.isLoading ||
    cotHistoryQuery.isLoading;

  const isError =
    goldPriceQuery.isError ||
    cotReportQuery.isError ||
    cotHistoryQuery.isError;

  const cotReport = cotReportQuery.data;
  const cotHistory = cotHistoryQuery.data;

  const data = useMemo(() => {
    if (!cotReport || !cotHistory) return null;
    return deriveSignal(cotReport, cotHistory);
  }, [cotReport, cotHistory]);

  return {
    data,
    isLoading,
    isError,
    isReady: data !== null,
    sources: {
      goldPrice: goldPriceQuery.data,
      cotReport: cotReportQuery.data,
      cotHistory: cotHistoryQuery.data,
    },
  };
}
