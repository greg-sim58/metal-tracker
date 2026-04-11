// Telegram alert dispatcher
//
// Sends trading signal alerts to a Telegram chat when actionable conditions
// are met. Includes spam prevention to avoid flooding the chat on every
// API poll cycle (dashboard refreshes every 20 minutes).
//
// Trigger conditions (any one fires an alert):
//   1. Execution stage changed (SETUP → TRIGGER → CONFIRMATION)
//   2. Score crosses ±40 threshold (strong BUY/SELL territory)
//   3. Extreme managed money delta (≥ 20,000 contracts/week)
//
// Spam prevention:
//   - Stores last sent alert state in module-level memory
//   - Only sends if stage changed or score moved by > 10 points
//   - NOTE: In-memory state resets on cold start / redeployment.
//     For multi-instance or serverless production, replace with
//     Redis, KV store, or a database flag.

import type { ExecutionSignal } from "@/lib/execution";
import type { OpenInterestTrend } from "@/lib/signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertContext {
  execution: ExecutionSignal;
  score: number;
  managedMoneyDelta: number;
  oiTrend: OpenInterestTrend;
}

// ---------------------------------------------------------------------------
// Spam prevention — in-memory last-sent state
// ---------------------------------------------------------------------------

interface LastAlertState {
  stage: string;
  score: number;
  sentAt: number;
}

let lastAlert: LastAlertState | null = null;

/** Minimum score change to warrant a new alert for the same stage. */
const SCORE_CHANGE_THRESHOLD = 10;

/** Score threshold for strong signal alerts (±40 = BUY/SELL territory). */
const STRONG_SIGNAL_THRESHOLD = 40;

/** Extreme delta threshold (contracts/week). */
const EXTREME_DELTA_THRESHOLD = 20_000;

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/**
 * Determine whether the current signal state warrants a Telegram alert.
 *
 * Returns true when any of these conditions are met:
 *   1. Execution stage changed since last alert
 *   2. Score crossed the ±40 strong signal threshold
 *   3. Extreme managed money delta detected (≥ 20k contracts/week)
 *   4. Score changed by more than 10 points since last alert (same stage)
 *
 * Returns false if the state is effectively unchanged (spam prevention).
 */
export function shouldSendAlert(ctx: AlertContext): boolean {
  // No previous alert — always send the first one
  if (!lastAlert) return true;

  // Stage changed — always notify
  if (ctx.execution.stage !== lastAlert.stage) return true;

  // Score crossed strong threshold since last alert
  const prevCrossed = Math.abs(lastAlert.score) >= STRONG_SIGNAL_THRESHOLD;
  const nowCrossed = Math.abs(ctx.score) >= STRONG_SIGNAL_THRESHOLD;
  if (!prevCrossed && nowCrossed) return true;

  // Extreme delta — always noteworthy
  if (Math.abs(ctx.managedMoneyDelta) >= EXTREME_DELTA_THRESHOLD) {
    // But only if score also moved meaningfully
    if (Math.abs(ctx.score - lastAlert.score) >= SCORE_CHANGE_THRESHOLD) {
      return true;
    }
  }

  // Same stage — only send if score changed significantly
  if (Math.abs(ctx.score - lastAlert.score) >= SCORE_CHANGE_THRESHOLD) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format a Telegram alert message using Markdown.
 *
 * Produces a compact, scannable message with stage, bias, score,
 * key market signals, and suggested actions.
 */
export function formatAlertMessage(ctx: AlertContext): string {
  const { execution, score, managedMoneyDelta, oiTrend } = ctx;

  const scoreSign = score > 0 ? "+" : "";
  const deltaSign = managedMoneyDelta > 0 ? "+" : "";
  const deltaFormatted = `${deltaSign}${managedMoneyDelta.toLocaleString("en-US")}`;
  const oiFormatted = `${oiTrend.trend.toUpperCase()} (${oiTrend.current.toLocaleString("en-US")})`;

  const stageEmoji =
    execution.stage === "CONFIRMATION" ? "\uD83D\uDEA8" :
    execution.stage === "TRIGGER" ? "\u26A0\uFE0F" :
    "\uD83D\uDCA1";

  const biasEmoji =
    execution.bias === "BULLISH" ? "\uD83D\uDFE2" :
    execution.bias === "BEARISH" ? "\uD83D\uDD34" :
    "\u26AA";

  const actions = execution.actions
    .map((a) => `\u2022 ${a}`)
    .join("\n");

  return [
    `${stageEmoji} *Gold Signal Alert*`,
    "",
    `*Stage:* ${execution.stage}`,
    `*Bias:* ${biasEmoji} ${execution.bias}`,
    `*Score:* ${scoreSign}${score} / 100`,
    "",
    "*Key Signals:*",
    `\u2022 Funds Delta: ${deltaFormatted} contracts/wk`,
    `\u2022 OI Trend: ${oiFormatted}`,
    "",
    "*Action:*",
    actions,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

/**
 * Send a Markdown-formatted message to the configured Telegram chat.
 *
 * Silently fails if credentials are not configured (dev environment)
 * or if the Telegram API returns an error. Alert failures should never
 * break the signal generation pipeline.
 *
 * Common "chat not found" causes:
 *   - Bot has never been messaged — send /start to the bot first
 *   - Chat ID is wrong — use /api/telegram-debug to verify
 *   - For groups: bot must be added to the group as a member
 */
export async function sendTelegramAlert(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId || token === "your_bot_token") {
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Parse chat_id as number when possible — Telegram prefers numeric IDs.
  // Group chat IDs are negative (e.g. -1001234567890).
  const parsedChatId = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: parsedChatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        "Telegram alert failed:",
        response.status,
        body,
      );
      if (body.includes("chat not found")) {
        console.error(
          "Hint: Send /start to your bot first, or verify TELEGRAM_CHAT_ID.",
          "Use GET /api/telegram-debug to check your bot's recent messages.",
        );
      }
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram alert error:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate alert conditions and dispatch a Telegram message if warranted.
 *
 * This is fire-and-forget — it never throws and never blocks the caller.
 * Call from the signals API route after computing the execution result.
 */
export async function dispatchAlertIfNeeded(ctx: AlertContext): Promise<void> {
  if (!shouldSendAlert(ctx)) return;

  const message = formatAlertMessage(ctx);
  const sent = await sendTelegramAlert(message);

  if (sent) {
    // Update last-sent state for spam prevention
    lastAlert = {
      stage: ctx.execution.stage,
      score: ctx.score,
      sentAt: Date.now(),
    };
  }
}
