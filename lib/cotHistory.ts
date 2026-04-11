// Historical COT data fetching and percentile analysis
//
// Fetches 2+ years of weekly CFTC Disaggregated Futures-Only reports for
// gold futures via the CFTC Socrata JSON API. Computes percentile rank of
// current managed money and commercial net positions against the
// historical distribution.
//
// Data is cached in-memory with a 24-hour TTL to avoid refetching on
// every request.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CotHistoryPoint {
  date: string;
  managedMoneyNet: number;
  commercialsNet: number;
  openInterest: number;
}

export interface PercentileMetrics {
  managedMoneyPercentile: number;
  commercialsPercentile: number;
  historyLength: number;
  oldestDate: string;
  newestDate: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface HistoryCache {
  data: CotHistoryPoint[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cache: HistoryCache | null = null;

// ---------------------------------------------------------------------------
// Socrata API configuration
// ---------------------------------------------------------------------------

/**
 * CFTC Socrata JSON API for Disaggregated Futures-Only reports.
 *
 * Dataset ID: 72hh-3qpy
 * Using the /resource/ endpoint which properly supports SoQL ($select,
 * $where, $order) and returns compact JSON instead of full CSV.
 *
 * Docs: https://dev.socrata.com/foundry/publicreporting.cftc.gov/72hh-3qpy
 */
const SOCRATA_BASE =
  "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";

/**
 * Number of years of history to fetch. More data = better percentile
 * distribution, but diminishing returns beyond 3 years.
 */
const HISTORY_YEARS = 3;

// ---------------------------------------------------------------------------
// Socrata JSON row shape
// ---------------------------------------------------------------------------

/**
 * Shape of each JSON row returned by the Socrata $select query.
 * All numeric fields come back as strings from the API.
 *
 * Note: Socrata column names differ slightly from f_disagg.txt headers:
 *   - prod/merc columns omit the "_all" suffix
 *   - dates include a T00:00:00.000 timestamp suffix
 */
interface SocrataRow {
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  m_money_positions_long_all: string;
  m_money_positions_short_all: string;
  prod_merc_positions_long: string;
  prod_merc_positions_short: string;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Build the Socrata SoQL query URL for gold futures COT data.
 *
 * Uses $select to fetch only the 6 columns we need (vs. 100+),
 * reducing payload from ~200 MB to ~50 KB.
 */
function buildSocrataUrl(): string {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setFullYear(startDate.getFullYear() - HISTORY_YEARS);

  const startStr = formatSocrataDate(startDate);
  const endStr = formatSocrataDate(now);

  const select = [
    "report_date_as_yyyy_mm_dd",
    "open_interest_all",
    "m_money_positions_long_all",
    "m_money_positions_short_all",
    "prod_merc_positions_long",
    "prod_merc_positions_short",
  ].join(",");

  // SoQL $where: gold futures on COMEX, within date range.
  // The `like` operator is case-insensitive in Socrata, no upper() needed.
  const where =
    `market_and_exchange_names like '%GOLD - COMMODITY EXCHANGE%'` +
    ` AND report_date_as_yyyy_mm_dd >= '${startStr}'` +
    ` AND report_date_as_yyyy_mm_dd <= '${endStr}'`;

  const params = new URLSearchParams({
    $select: select,
    $where: where,
    $order: "report_date_as_yyyy_mm_dd ASC",
    $limit: "10000",
  });

  return `${SOCRATA_BASE}?${params.toString()}`;
}

/**
 * Format a Date as YYYY-MM-DD for Socrata queries.
 */
function formatSocrataDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse a numeric string from Socrata JSON, returning 0 for missing values.
 */
function parseNumeric(value: string | undefined): number {
  if (!value || value === "" || value === ".") return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Convert Socrata JSON rows to CotHistoryPoint[].
 */
function parseSocrataRows(rows: SocrataRow[]): CotHistoryPoint[] {
  const points: CotHistoryPoint[] = [];

  for (const row of rows) {
    const date = row.report_date_as_yyyy_mm_dd;
    if (!date) continue;

    // Extract the YYYY-MM-DD portion if the date includes a timestamp
    const dateStr = date.length > 10 ? date.substring(0, 10) : date;

    const managedLong = parseNumeric(row.m_money_positions_long_all);
    const managedShort = parseNumeric(row.m_money_positions_short_all);
    const commercialLong = parseNumeric(row.prod_merc_positions_long);
    const commercialShort = parseNumeric(row.prod_merc_positions_short);
    const openInterest = parseNumeric(row.open_interest_all);

    points.push({
      date: dateStr,
      managedMoneyNet: managedLong - managedShort,
      commercialsNet: commercialLong - commercialShort,
      openInterest,
    });
  }

  // Sort by date ascending (should already be from $order, but ensure)
  points.sort((a, b) => a.date.localeCompare(b.date));

  return points;
}

/**
 * Fetch historical COT data for gold futures.
 * Uses in-memory cache with 24-hour TTL.
 *
 * Returns the cached data if fresh, otherwise fetches from Socrata.
 * Returns an empty array if the fetch fails.
 */
export async function fetchCotHistory(): Promise<CotHistoryPoint[]> {
  // Return cached data if fresh
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const url = buildSocrataUrl();

  try {
    const res = await fetch(url, {
      // Use Next.js cache with long revalidation since we have our own TTL
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      console.error(
        `Socrata COT history fetch failed: ${res.status} ${res.statusText}`,
      );
      // Return stale cache if available
      return cache?.data ?? [];
    }

    const rows: SocrataRow[] = await res.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error("No gold futures data found in Socrata response");
      return cache?.data ?? [];
    }

    const points = parseSocrataRows(rows);

    if (points.length === 0) {
      console.error("No valid data points after parsing Socrata response");
      return cache?.data ?? [];
    }

    cache = {
      data: points,
      fetchedAt: Date.now(),
    };

    return points;
  } catch (error) {
    console.error("Socrata COT history fetch error:", error);
    return cache?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Percentile calculations
// ---------------------------------------------------------------------------

/**
 * Calculate the percentile rank of a value within a dataset.
 *
 * Uses the "percentage of values below" method:
 *   percentile = (count of values < x) / total * 100
 *
 * Returns a value from 0 to 100.
 */
export function calculatePercentile(value: number, dataset: number[]): number {
  if (dataset.length === 0) return 50; // No data — assume midpoint

  let below = 0;
  for (const v of dataset) {
    if (v < value) below++;
  }

  return Math.round((below / dataset.length) * 100);
}

/**
 * Get the 10th and 90th percentile thresholds from a dataset.
 * Used for identifying extreme positioning.
 */
export function getExtremes(dataset: number[]): { p10: number; p90: number } {
  if (dataset.length === 0) {
    return { p10: 0, p90: 0 };
  }

  const sorted = [...dataset].sort((a, b) => a - b);
  const p10Index = Math.floor(sorted.length * 0.10);
  const p90Index = Math.floor(sorted.length * 0.90);

  return {
    p10: sorted[Math.min(p10Index, sorted.length - 1)],
    p90: sorted[Math.min(p90Index, sorted.length - 1)],
  };
}

/**
 * Compute percentile metrics for current managed money and commercial
 * net positions against the historical distribution.
 *
 * Returns null if historical data is insufficient (fewer than 26 weeks).
 */
export function computePercentileMetrics(
  currentManagedNet: number,
  currentCommercialsNet: number,
  history: CotHistoryPoint[],
): PercentileMetrics | null {
  const MIN_HISTORY_POINTS = 26; // At least ~6 months of weekly data

  if (history.length < MIN_HISTORY_POINTS) {
    console.warn(
      `Insufficient COT history for percentile analysis: ${history.length} points (need ${MIN_HISTORY_POINTS})`,
    );
    return null;
  }

  const managedMoneyDataset = history.map((p) => p.managedMoneyNet);
  const commercialsDataset = history.map((p) => p.commercialsNet);

  return {
    managedMoneyPercentile: calculatePercentile(currentManagedNet, managedMoneyDataset),
    commercialsPercentile: calculatePercentile(currentCommercialsNet, commercialsDataset),
    historyLength: history.length,
    oldestDate: history[0].date,
    newestDate: history[history.length - 1].date,
  };
}
