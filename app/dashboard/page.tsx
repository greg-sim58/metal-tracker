import DashboardRefresh from "@/components/DashboardRefresh";
import PriceChart from "@/components/PriceChart";
import SentimentPanel from "@/components/SentimentPanel";
import SignalIndicator from "@/components/SignalIndicator";
import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import { fetchCotHistory, computePercentileMetrics } from "@/lib/cotHistory";
import { generateSignal } from "@/lib/signals";

import type { OpenInterestTrend, PriceTrend } from "@/lib/signals";

/** Fallback ratio to estimate previous OI when historical data is unavailable. */
const PREVIOUS_OI_ESTIMATE_RATIO = 0.95;

export default async function DashboardPage() {
  const [goldPrice, cotReport, cotHistory] = await Promise.all([
    fetchGoldPrice(),
    fetchCotReport(),
    fetchCotHistory(),
  ]);

  // Generate the combined signal when COT data is available
  let signal = null;
  if (cotReport) {
    // Compute percentile metrics against historical distribution
    const percentiles = computePercentileMetrics(
      cotReport.largeSpeculators.net,
      cotReport.commercials.net,
      cotHistory,
    );

    // Derive price trend — placeholder until historical price comparison
    // is implemented. Defaults to "up".
    const priceTrend: PriceTrend = "up";

    // Derive OI trend from COT open interest.
    // Use previous week's historical OI when available.
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

    signal = generateSignal({
      priceTrend,
      oiTrend,
      cotData: cotReport,
      percentiles,
    });
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <DashboardRefresh />
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Gold Dashboard
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Market data and trading signals
        </p>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          <PriceChart data={goldPrice} />
          <SentimentPanel data={cotReport} />
        </div>
        <div className="mt-6">
          <SignalIndicator signal={signal} />
        </div>
      </main>
    </div>
  );
}
