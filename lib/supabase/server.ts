// Server-side Supabase client (per-request)
//
// Uses @supabase/ssr's createServerClient with Next.js cookies().
// A new instance is created per request to isolate cookie state.
//
// Use in: Server Components, Route Handlers, Server Actions.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/supabase/types";

/**
 * Create a Supabase server client bound to the current request's cookies.
 *
 * Must be called inside a Server Component, Route Handler, or Server Action
 * where `cookies()` is available.
 */
export async function getSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables",
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // setAll is called from Server Components where cookies are
            // read-only. The cookie will be set by the middleware instead.
          }
        }
      },
    },
  });
}
