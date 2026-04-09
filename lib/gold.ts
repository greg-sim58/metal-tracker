// Gold price data fetching and processing via gold-api.com

const GOLD_API_BASE = "https://api.gold-api.com";

export interface GoldPrice {
  price: number;
  currency: string;
  timestamp: string;
}

interface GoldApiResponse {
  currency: string;
  currencySymbol: string;
  exchangeRate: number;
  name: string;
  price: number;
  symbol: string;
  updatedAt: string;
  updatedAtReadable: string;
}

export async function fetchGoldPrice(): Promise<GoldPrice | null> {
  const res = await fetch(`${GOLD_API_BASE}/price/XAU`);

  if (!res.ok) {
    console.error(`Gold API error: ${res.status} ${res.statusText}`);
    return null;
  }

  const data: GoldApiResponse = await res.json();

  return {
    price: data.price,
    currency: data.currency,
    timestamp: data.updatedAt,
  };
}
