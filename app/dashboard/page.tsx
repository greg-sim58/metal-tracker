import PriceChart from "@/components/PriceChart";
import SentimentPanel from "@/components/SentimentPanel";
import SignalIndicator from "@/components/SignalIndicator";
import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";
import { generateSignals } from "@/lib/signals";

export default async function DashboardPage() {
  const [goldPrice, cotReport, signals] = await Promise.all([
    fetchGoldPrice(),
    fetchCotReport(),
    generateSignals(),
  ]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
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
          <SignalIndicator signals={signals} />
        </div>
      </main>
    </div>
  );
}
