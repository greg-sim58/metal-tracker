// Trading signal generation from gold price and COT data

import { fetchGoldPrice } from "@/lib/gold";
import { fetchCotReport } from "@/lib/cot";

import type { CotReport } from "@/lib/cot";

export interface Signal {
  type: "buy" | "sell" | "hold";
  strength: number;
  reason: string;
  timestamp: string;
}

function managedMoneySentiment(cot: CotReport, timestamp: string): Signal {
  const net = cot.managedMoney.net;

  if (net > 80000) {
    const strength = net > 120000 ? 5 : 4;
    return {
      type: "buy",
      strength,
      reason: `Managed money strongly net long (${net.toLocaleString("en-US")} contracts)`,
      timestamp,
    };
  }

  if (net < 20000) {
    const strength = net < 0 ? 5 : net < 10000 ? 4 : 3;
    return {
      type: "sell",
      strength,
      reason: `Managed money weak/net short (${net.toLocaleString("en-US")} contracts)`,
      timestamp,
    };
  }

  const strength = net > 50000 ? 3 : 2;
  return {
    type: "hold",
    strength,
    reason: `Managed money neutral (${net.toLocaleString("en-US")} contracts)`,
    timestamp,
  };
}

function commercialContrarian(cot: CotReport, timestamp: string): Signal {
  const net = cot.commercials.net;

  if (net < -30000) {
    const strength = net < -50000 ? 5 : 4;
    return {
      type: "buy",
      strength,
      reason: `Commercials heavily hedging (net ${net.toLocaleString("en-US")}) — bullish contrarian`,
      timestamp,
    };
  }

  if (net > -5000) {
    const strength = net > 0 ? 5 : 4;
    return {
      type: "sell",
      strength,
      reason: `Commercials near flat/long (net ${net.toLocaleString("en-US")}) — unusual, bearish`,
      timestamp,
    };
  }

  return {
    type: "hold",
    strength: 2,
    reason: `Commercial hedging moderate (net ${net.toLocaleString("en-US")})`,
    timestamp,
  };
}

function openInterestConviction(cot: CotReport, timestamp: string): Signal {
  const oi = cot.openInterest;
  const managedNet = cot.managedMoney.net;

  if (oi > 300000 && managedNet > 50000) {
    return {
      type: "buy",
      strength: 4,
      reason: `High open interest (${oi.toLocaleString("en-US")}) with bullish positioning — strong conviction`,
      timestamp,
    };
  }

  if (oi > 300000 && managedNet < 10000) {
    return {
      type: "sell",
      strength: 4,
      reason: `High open interest (${oi.toLocaleString("en-US")}) with bearish positioning — strong conviction`,
      timestamp,
    };
  }

  if (oi < 200000) {
    return {
      type: "hold",
      strength: 2,
      reason: `Low open interest (${oi.toLocaleString("en-US")}) — thin market, low conviction`,
      timestamp,
    };
  }

  return {
    type: "hold",
    strength: 3,
    reason: `Moderate open interest (${oi.toLocaleString("en-US")}) — mixed signals`,
    timestamp,
  };
}

export async function generateSignals(): Promise<Signal[]> {
  const [goldPrice, cotReport] = await Promise.all([
    fetchGoldPrice(),
    fetchCotReport(),
  ]);

  if (!cotReport) {
    return [];
  }

  const timestamp = goldPrice?.timestamp ?? new Date().toISOString();

  return [
    managedMoneySentiment(cotReport, timestamp),
    commercialContrarian(cotReport, timestamp),
    openInterestConviction(cotReport, timestamp),
  ];
}
