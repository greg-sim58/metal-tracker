import { NextResponse } from "next/server";

import { sendTelegramAlert } from "@/lib/alerts";

/**
 * GET /api/test-telegram
 *
 * Diagnostic endpoint for Telegram bot setup.
 *
 * 1. Validates that env vars are configured
 * 2. Calls getUpdates to find your correct chat ID
 * 3. Attempts to send a test message
 *
 * Usage:
 *   1. Send /start to your bot in Telegram
 *   2. Hit this endpoint
 *   3. Check the response for your chat ID
 *   4. Set TELEGRAM_CHAT_ID in .env to the correct value
 */
export async function GET(): Promise<NextResponse> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Step 1: Check env vars
  if (!token || token === "your_bot_token") {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN not configured" },
      { status: 400 },
    );
  }

  if (!chatId || chatId === "your_chat_id") {
    return NextResponse.json(
      { error: "TELEGRAM_CHAT_ID not configured" },
      { status: 400 },
    );
  }

  // Step 2: Call getUpdates to find recent chats the bot has received
  // This reveals the correct chat ID — the most common fix for "chat not found".
  let recentChats: Array<{ chatId: number; type: string; name: string }> = [];
  try {
    const updatesUrl = `https://api.telegram.org/bot${token}/getUpdates`;
    const updatesRes = await fetch(updatesUrl);
    const updatesBody = await updatesRes.json() as {
      ok: boolean;
      result?: Array<{
        message?: {
          chat: { id: number; type: string; first_name?: string; title?: string };
        };
      }>;
    };

    if (updatesBody.ok && updatesBody.result) {
      const seen = new Set<number>();
      for (const update of updatesBody.result) {
        const chat = update.message?.chat;
        if (chat && !seen.has(chat.id)) {
          seen.add(chat.id);
          recentChats.push({
            chatId: chat.id,
            type: chat.type,
            name: chat.first_name ?? chat.title ?? "unknown",
          });
        }
      }
    }
  } catch {
    // Non-fatal — we'll still try to send
    recentChats = [];
  }

  // Step 3: Attempt test message
  const sent = await sendTelegramAlert("\uD83D\uDE80 Test alert from your Gold Dashboard");

  return NextResponse.json({
    configured: {
      token: `${token.slice(0, 6)}...${token.slice(-4)}`,
      chatId,
    },
    testMessageSent: sent,
    recentChats,
    hint: sent
      ? "Working! Alerts will be delivered to this chat."
      : recentChats.length > 0
        ? `Message failed. Your TELEGRAM_CHAT_ID is "${chatId}" but the bot has received messages from: ${recentChats.map((c) => `${c.name} (${c.chatId})`).join(", ")}. Update TELEGRAM_CHAT_ID to one of these values.`
        : `Message failed and no recent bot messages found. Send /start to your bot in Telegram first, then retry this endpoint.`,
  });
}
