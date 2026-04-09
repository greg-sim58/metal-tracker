import { NextResponse } from "next/server";

import { fetchGoldPrice } from "@/lib/gold";

export async function GET() {
  try {
    const data = await fetchGoldPrice();

    if (!data) {
      return NextResponse.json(
        { error: "Gold price data unavailable" },
        { status: 503 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to fetch gold price:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
