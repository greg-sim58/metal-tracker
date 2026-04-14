// Browser-side Supabase client (singleton)
//
// Uses @supabase/ssr's createBrowserClient for cookie-based auth.
// The singleton pattern ensures only one GoTrueClient / Realtime connection
// per browser tab, avoiding duplicate WebSocket connections.

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/types";

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

/**
 * Return the singleton Supabase browser client.
 *
 * Safe to call from any client component or hook.
 * Throws at runtime if the required env vars are missing.
 */
export function getSupabaseBrowserClient() {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables",
    );
  }

  client = createBrowserClient<Database>(url, key);
  return client;
}
