// Commitment of Traders (COT) data fetching and processing
// Source: CFTC Disaggregated Futures-Only Report (f_disagg.txt)
// Column spec: https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalViewable/CFTC_023168

const CFTC_DISAGG_URL = "https://www.cftc.gov/dea/newcot/f_disagg.txt";

/**
 * Market identification: the quoted market name field must contain this
 * substring to match gold futures on COMEX.
 */
export const GOLD_MARKET_PATTERN = "GOLD - COMMODITY EXCHANGE";

/**
 * 0-based column indices for the disaggregated futures-only report.
 *
 * Full column listing (All section, indices 0-22):
 *   0  Market_and_Exchange_Names (quoted)
 *   1  As_of_Date_In_Form_YYMMDD
 *   2  Report_Date (YYYY-MM-DD)
 *   3  CFTC_Contract_Market_Code
 *   4  CFTC_Market_Code (exchange abbreviation)
 *   5  CFTC_Region_Code
 *   6  CFTC_Commodity_Code
 *   7  Open_Interest_All
 *   8  Prod_Merc_Positions_Long_All
 *   9  Prod_Merc_Positions_Short_All
 *  10  Swap_Positions_Long_All
 *  11  Swap_Positions_Short_All
 *  12  Swap_Positions_Spread_All
 *  13  M_Money_Positions_Long_All
 *  14  M_Money_Positions_Short_All
 *  15  M_Money_Positions_Spread_All
 *  16  Other_Rept_Positions_Long_All
 *  17  Other_Rept_Positions_Short_All
 *  18  Other_Rept_Positions_Spread_All
 *  19  Tot_Rept_Positions_Long_All
 *  20  Tot_Rept_Positions_Short_All
 *  21  NonRept_Positions_Long_All
 *  22  NonRept_Positions_Short_All
 */
export const COL = {
  MARKET_NAME: 0,
  REPORT_DATE: 2,
  OPEN_INTEREST: 7,
  PROD_MERC_LONG: 8,
  PROD_MERC_SHORT: 9,
  MANAGED_MONEY_LONG: 13,
  MANAGED_MONEY_SHORT: 14,
  NONREPORTABLE_LONG: 21,
  NONREPORTABLE_SHORT: 22,
} as const;

/** Minimum number of fields required for a valid disaggregated row. */
export const MIN_FIELDS = 23;

export interface CotPositionGroup {
  long: number;
  short: number;
  net: number;
}

export interface CotReport {
  market: string;
  date: string;
  openInterest: number;
  commercials: CotPositionGroup;
  largeSpeculators: CotPositionGroup;
  smallTraders: CotPositionGroup;
}

/**
 * Compute net position from long and short contract counts.
 */
export function getNetPosition(long: number, short: number): number {
  return long - short;
}

/**
 * Parse a CSV row that may contain quoted fields (fields with commas inside
 * double quotes). Implements RFC 4180-compliant parsing.
 *
 * Example input:
 *   `"GOLD - COMMODITY EXCHANGE INC.",260331,2026-03-31,002691,CME ,00,002 ,  488618,...`
 *
 * Returns an array of trimmed field values.
 */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (char === ",") {
        fields.push(current.trim());
        current = "";
        i++;
        continue;
      }
      current += char;
      i++;
    }
  }

  // Push the last field
  fields.push(current.trim());

  return fields;
}

/**
 * Parse a numeric field from the CSV. Handles whitespace-padded integers and
 * the CFTC convention of using "." for suppressed/missing data.
 *
 * Returns `null` if the value is missing or unparseable.
 */
export function parseNumericField(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === ".") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ".") {
    return null;
  }

  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
}

/**
 * Parse a numeric field, returning 0 for missing/suppressed data.
 * Use this when a fallback of 0 is acceptable (position fields).
 */
export function parseNumericFieldOrZero(value: string | undefined): number {
  return parseNumericField(value) ?? 0;
}

/**
 * Build a position group from long and short field values.
 */
function buildPositionGroup(
  longValue: string | undefined,
  shortValue: string | undefined,
): CotPositionGroup {
  const long = parseNumericFieldOrZero(longValue);
  const short = parseNumericFieldOrZero(shortValue);
  return {
    long,
    short,
    net: getNetPosition(long, short),
  };
}

/**
 * Validate that a parsed CotReport contains plausible data.
 * Returns an error message if validation fails, or null if valid.
 */
function validateReport(report: CotReport): string | null {
  if (report.openInterest <= 0) {
    return `Invalid open interest: ${report.openInterest}`;
  }

  const totalLong =
    report.commercials.long +
    report.largeSpeculators.long +
    report.smallTraders.long;

  if (totalLong <= 0) {
    return `Total long positions is zero or negative: ${totalLong}`;
  }

  if (!report.date || report.date === "Unknown") {
    return "Missing report date";
  }

  return null;
}

/**
 * Find the GOLD futures row in the parsed CSV rows.
 * Matches rows where the market name contains "GOLD - COMMODITY EXCHANGE".
 */
function findGoldRow(rows: string[][]): string[] | null {
  for (const fields of rows) {
    if (fields.length < MIN_FIELDS) continue;

    const marketName = fields[COL.MARKET_NAME].toUpperCase();
    if (marketName.includes(GOLD_MARKET_PATTERN)) {
      return fields;
    }
  }

  return null;
}

/**
 * Fetch and parse the latest CFTC Disaggregated Futures-Only report to
 * extract gold futures COT data.
 *
 * Fetches the full f_disagg.txt file, parses the CSV, locates the GOLD
 * COMEX row, and returns a structured CotReport.
 *
 * Returns `null` if the fetch fails, the GOLD row is not found, or
 * validation fails.
 */
export async function fetchCotReport(): Promise<CotReport | null> {
  const res = await fetch(CFTC_DISAGG_URL, {
    next: { revalidate: 1200 },
  });

  if (!res.ok) {
    console.error(`CFTC report fetch failed: ${res.status} ${res.statusText}`);
    return null;
  }

  const text = await res.text();

  if (!text || text.trim().length === 0) {
    console.error("CFTC report returned empty response");
    return null;
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    console.error("CFTC report has no data rows");
    return null;
  }

  const rows = lines.map(parseCsvRow);
  const goldFields = findGoldRow(rows);

  if (!goldFields) {
    console.error("GOLD futures row not found in CFTC disaggregated report");
    return null;
  }

  const reportDate = goldFields[COL.REPORT_DATE] || "Unknown";
  const openInterest = parseNumericFieldOrZero(goldFields[COL.OPEN_INTEREST]);

  const commercials = buildPositionGroup(
    goldFields[COL.PROD_MERC_LONG],
    goldFields[COL.PROD_MERC_SHORT],
  );

  const largeSpeculators = buildPositionGroup(
    goldFields[COL.MANAGED_MONEY_LONG],
    goldFields[COL.MANAGED_MONEY_SHORT],
  );

  const smallTraders = buildPositionGroup(
    goldFields[COL.NONREPORTABLE_LONG],
    goldFields[COL.NONREPORTABLE_SHORT],
  );

  const report: CotReport = {
    market: "Gold Futures",
    date: reportDate,
    openInterest,
    commercials,
    largeSpeculators,
    smallTraders,
  };

  const validationError = validateReport(report);
  if (validationError) {
    console.error(`COT report validation failed: ${validationError}`);
    return null;
  }

  return report;
}
