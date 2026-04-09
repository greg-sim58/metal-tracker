import { NextResponse } from "next/server";

import { fetchCotReport } from "@/lib/cot";

export async function GET() {
  try {
    const report = await fetchCotReport();

    if (!report) {
      return NextResponse.json(
        { error: "COT data unavailable" },
        { status: 503 },
      );
    }

    return NextResponse.json({
      report,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("COT API route error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
