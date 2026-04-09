// Commitment of Traders (COT) data fetching and processing
// Source: CFTC Public Reporting Environment (Socrata API)

const CFTC_API_BASE = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";

interface CftcCotResponse {
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  prod_merc_positions_long: string;
  prod_merc_positions_short: string;
  m_money_positions_long_all: string;
  m_money_positions_short_all: string;
  swap_positions_long_all: string;
  swap__positions_short_all: string;
}

export interface CotPositionGroup {
  long: number;
  short: number;
  net: number;
}

export interface CotReport {
  date: string;
  openInterest: number;
  commercials: CotPositionGroup;
  managedMoney: CotPositionGroup;
  swapDealers: CotPositionGroup;
  longPositions: number;
  shortPositions: number;
  netPosition: number;
}

function parsePosition(value: string | undefined): number {
  if (!value) return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildPositionGroup(long: string | undefined, short: string | undefined): CotPositionGroup {
  const longVal = parsePosition(long);
  const shortVal = parsePosition(short);
  return {
    long: longVal,
    short: shortVal,
    net: longVal - shortVal,
  };
}

export async function fetchCotReport(): Promise<CotReport | null> {
  const params = new URLSearchParams({
    contract_market_name: "GOLD",
    "$limit": "1",
    "$order": "report_date_as_yyyy_mm_dd DESC",
  });

  const res = await fetch(`${CFTC_API_BASE}?${params.toString()}`);

  if (!res.ok) {
    console.error(`CFTC API error: ${res.status} ${res.statusText}`);
    return null;
  }

  const data: CftcCotResponse[] = await res.json();

  if (!data || data.length === 0) {
    console.error("CFTC API returned no COT data for GOLD");
    return null;
  }

  const record = data[0];

  const commercials = buildPositionGroup(
    record.prod_merc_positions_long,
    record.prod_merc_positions_short,
  );
  const managedMoney = buildPositionGroup(
    record.m_money_positions_long_all,
    record.m_money_positions_short_all,
  );
  const swapDealers = buildPositionGroup(
    record.swap_positions_long_all,
    record.swap__positions_short_all,
  );

  const totalLong = commercials.long + managedMoney.long + swapDealers.long;
  const totalShort = commercials.short + managedMoney.short + swapDealers.short;

  const reportDate = record.report_date_as_yyyy_mm_dd
    ? record.report_date_as_yyyy_mm_dd.split("T")[0]
    : "Unknown";

  return {
    date: reportDate,
    openInterest: parsePosition(record.open_interest_all),
    commercials,
    managedMoney,
    swapDealers,
    longPositions: totalLong,
    shortPositions: totalShort,
    netPosition: totalLong - totalShort,
  };
}
