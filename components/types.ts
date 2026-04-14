// Dashboard component data contracts
//
// These types define the props for the decision-driven trading dashboard.
// The dashboard uses STATIC sample data for now — backend API integration
// will follow once the UI layer is validated.

// ---------------------------------------------------------------------------
// Trade decision types
// ---------------------------------------------------------------------------

/** Pipeline status — replaces BUY/SELL with decision states. */
export type TradeStatus = "WAIT" | "READY" | "INVALIDATED";

/** Final trade decision. */
export type TradeDecision = "EXECUTE_TRADE" | "NO_TRADE";

/** Signal directional bias — informational, NOT actionable. */
export type SignalBias = "BULLISH" | "BEARISH" | "NEUTRAL";

/** Risk level for invalidation probability. */
export type InvalidationRisk = "LOW" | "MEDIUM" | "HIGH";

// ---------------------------------------------------------------------------
// Multi-timeframe alignment
// ---------------------------------------------------------------------------

/** Status of a single timeframe layer. */
export type TimeframeStatus = "ALIGNED" | "NOT_ALIGNED" | "PENDING";

export interface TimeframeEntry {
  label: string;
  description: string;
  status: TimeframeStatus;
}

// ---------------------------------------------------------------------------
// Readiness breakdown
// ---------------------------------------------------------------------------

export interface ReadinessComponent {
  label: string;
  score: number; // 0–100
  weight: number; // percentage weight (0–100, all sum to 100)
}

// ---------------------------------------------------------------------------
// Signal lifecycle
// ---------------------------------------------------------------------------

export type LifecycleStatus = "ACTIVE" | "WAITING" | "CONFIRMED" | "INVALIDATED";

export interface SignalLifecycle {
  status: LifecycleStatus;
  createdAt: string; // ISO timestamp
  expiresAt: string | null; // ISO timestamp or null if no expiry
  invalidationWarning: string | null;
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface PricePanelProps {
  price: number | null;
  currency: string;
  lastUpdated: string | null;
}

export interface SentimentPanelProps {
  sentiment: "Bullish" | "Bearish" | "Neutral";
  openInterest: number;
  netPosition: number;
  reportDate: string;
  categories: Array<{
    label: string;
    long: number;
    short: number;
    net: number;
  }>;
}

export interface TradingSignalCardProps {
  signalBias: SignalBias;
  signalScore: number; // -100 to +100
  confidence: number; // 0–100
  readinessScore: number; // 0–100
  status: TradeStatus;
  decision: TradeDecision;
  invalidationRisk: InvalidationRisk;
}

export interface MTFPanelProps {
  timeframes: TimeframeEntry[];
  isAligned: boolean;
}

export interface ReadinessBreakdownProps {
  components: ReadinessComponent[];
  totalScore: number; // 0–100
}

export interface LifecyclePanelProps {
  lifecycle: SignalLifecycle;
}

export interface AnalysisPanelProps {
  reasoning: string[];
  highlightMessage: string;
}
