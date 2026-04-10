import { NextResponse } from "next/server";

import { generateSignals } from "@/lib/signals";

export async function GET() {
  try {
    const signals = await generateSignals();

    return NextResponse.json({
      signals,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Signals API route error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
