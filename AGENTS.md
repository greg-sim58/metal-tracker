<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MetalTracker — Agent Guidelines

## Stack

| Layer        | Technology                        |
|------------- |---------------------------------- |
| Framework    | Next.js 16.2.3 (App Router)      |
| Runtime      | React 19, TypeScript 5 (strict)  |
| Styling      | Tailwind CSS v4 (`@tailwindcss/postcss`) |
| Database    | Supabase (Postgres + Realtime)     |
| State       | TanStack React Query v5          |
| Linting     | ESLint 9 (flat config)           |

## Build / Lint / Test Commands

```bash
# Development
npm run dev              # Start dev server (Turbopack)

# Production build
npm run build            # Full production build (TypeScript check + compile)

# Lint
npm run lint             # ESLint across the project

# Type-check only
npx tsc --noEmit
```

## Project Structure

```
/app
  /actions/refresh-data.ts    # Server action for data ingestion (bypasses HTTP auth)
  /api
    /ingest/route.ts         # Ingestion endpoint (for cron/external calls)
  /dashboard/page.tsx       # Dashboard page (renders DashboardClient)
  /providers.tsx          # React Query provider
  layout.tsx               # Root layout
  globals.css              # Tailwind v4 + CSS variables
/components              # React components
  DashboardClient.tsx       # Main client component (uses hooks)
  PricePanel.tsx          # Gold price display
  SentimentPanel.tsx       # COT sentiment display
  TradingSignalCard.tsx    # Signal + readiness
  MTFPanel.tsx            # Multi-timeframe
  ReadinessBreakdown.tsx   # Readiness scores
  LifecyclePanel.tsx      # Signal lifecycle
  AnalysisPanel.tsx       # Reasoning
/hooks                   # React Query hooks
  useGoldPrice.ts         # Gold price (polling 15min + Realtime)
  useCotReport.ts        # COT report (polling 15min + Realtime)
  useCotHistory.ts      # COT history (polling 15min + Realtime)
  useSignal.ts         # Derived signal (composes above)
  useSupabaseRealtime.ts # Postgres change subscriptions
/lib                    # Business logic
  supabase/client.ts    # Browser singleton client
  supabase/server.ts    # Server client
  supabase/types.ts    # Database types
  gold.ts              # fetchGoldPrice()
  cot.ts               # fetchCotReport()
  cotHistory.ts        # fetchCotHistory(), analysis
  signals.ts           # generateSignal()
  execution.ts        # classifyExecution()
/supabase
  schema.sql          # Database schema (run in Supabase SQL Editor)
```

## Data Flow

```
External APIs → refresh-data.ts (server action) → Supabase
                                    ↓
Supabase Realtime → useSupabaseRealtime → invalidateQueries
                                    ↓
useGoldPrice/useCotReport/useCotHistory (React Query)
                                    ↓
useSignal (derived) → DashboardClient → UI
```

## Supabase Keys

- `NEXT_PUBLIC_SUPABASE_URL` — Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Anonymous key (client-readable)
- `SUPABASE_SERVICE_ROLE_KEY` — Service role (server-only, bypasses RLS)
- `INGEST_API_KEY` — For `/api/ingest` endpoint (Bearer auth)

## Key Patterns

### Server Action (preferred for internal data ops)
```typescript
// app/actions/refresh-data.ts
"use server";
import { createClient } from "@supabase/supabase-js";

export async function refreshDashboardData() {
  const supabase = createClient<Database>(url, serviceKey);
  // fetch external data, write to Supabase
}
```

### React Query hook
```typescript
// hooks/useGoldPrice.ts
export const GOLD_PRICE_KEY = ["gold-price"] as const;
const POLL_INTERVAL_MS = 15 * 60 * 1000;

export function useGoldPrice() {
  return useQuery({
    queryKey: GOLD_PRICE_KEY,
    queryFn: fetchGoldPriceFromSupabase,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
```

### Realtime subscription
```typescript
// hooks/useSupabaseRealtime.ts
channel = supabase.channel("dashboard-realtime")
  .on("postgres_changes", { event: "*", schema: "public", table: "gold_prices" }, () => {
    queryClient.invalidateQueries({ queryKey: GOLD_PRICE_KEY });
  })
  .subscribe();
```

## Code Style

- **Strict mode ON** — never use `as any`, `@ts-ignore`
- Use `interface` for object shapes, `type` for unions
- Use `@/` alias for cross-directory imports
- Client components: `"use client";` as first line
- One component per file, default export

## Common Tasks

### Adding a new data source
1. Add table to `supabase/schema.sql`
2. Add types to `lib/supabase/types.ts`
3. Create React Query hook in `/hooks`
4. Add to `useSignal.ts` sources
5. Use in DashboardClient

### Debugging Realtime
- Check browser console for `[Realtime] Subscription status: SUBSCRIBED`
- Tables must be in `supabase_realtime` publication
- RLS policies must allow read for anon role

### Testing data flow
```bash
# Call ingestion manually
curl -X POST http://localhost:3000/api/ingest \
  -H "Authorization: Bearer YOUR_INGEST_API_KEY"
```