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
| Linting      | ESLint 9 (flat config, core-web-vitals + typescript) |
| Fonts        | Geist / Geist Mono via `next/font/google` |

## Build / Lint / Test Commands

```bash
# Development
npm run dev              # Start dev server (Turbopack)

# Production build
npm run build            # Full production build (TypeScript check + compile)

# Lint
npm run lint             # ESLint across the project (eslint flat config)
npx eslint app/          # Lint a specific directory
npx eslint app/page.tsx  # Lint a single file

# Type-check only (no emit)
npx tsc --noEmit

# Start production server (after build)
npm run start
```

### Testing

No test framework is currently configured. When adding tests:
- Prefer Vitest for unit/integration tests
- Prefer Playwright for E2E tests
- Place test files adjacent to source: `foo.test.ts` next to `foo.ts`

## Project Structure

```
/app                     # Next.js App Router pages and API routes
  /api
    /gold-price/route.ts   # GET — gold price data
    /open-interest/route.ts# GET — open interest data
    /cot/route.ts          # GET — Commitment of Traders data
    /signals/route.ts      # GET — trading signals
  /dashboard/page.tsx      # Dashboard page
  layout.tsx               # Root layout (Geist fonts, globals.css)
  page.tsx                 # Landing page
  globals.css              # Tailwind v4 import + CSS custom properties
/lib                     # Data fetching & business logic (server-side)
  gold.ts                  # Gold price fetching
  cot.ts                   # COT report fetching
  signals.ts               # Signal generation
/components              # React components (client-side)
  PriceChart.tsx
  SentimentPanel.tsx
  SignalIndicator.tsx
/public                  # Static assets
```

## Path Aliases

```
@/* → ./*    (tsconfig paths)
```

Use `@/lib/gold` instead of `../../lib/gold`. Always prefer the `@/` alias for cross-directory imports.

## Code Style

### TypeScript

- **Strict mode is ON** — never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Use `interface` for object shapes; use `type` for unions, intersections, and utility types
- Export interfaces/types alongside the functions that consume them
- Prefer explicit return types on exported functions

```typescript
// Good
export interface GoldPrice {
  price: number;
  currency: string;
  timestamp: string;
}

export async function fetchGoldPrice(): Promise<GoldPrice | null> { ... }
```

### Imports

Order imports in this sequence, separated by blank lines:

1. External packages (`next/*`, `react`, third-party)
2. Internal aliases (`@/lib/*`, `@/components/*`)
3. Relative imports (`./`, `../`)
4. Type-only imports (`import type { ... }`)

```typescript
import { NextResponse } from "next/server";
import type { Metadata } from "next";

import { fetchGoldPrice } from "@/lib/gold";

import type { GoldPrice } from "@/lib/gold";
```

### Naming Conventions

| Element           | Convention       | Example                 |
|------------------ |----------------- |------------------------ |
| Components        | PascalCase file + default export | `PriceChart.tsx` → `export default function PriceChart()` |
| Pages             | `page.tsx`       | `app/dashboard/page.tsx` |
| API routes        | `route.ts`       | `app/api/gold-price/route.ts` |
| Lib modules       | camelCase file   | `gold.ts`, `signals.ts` |
| Interfaces        | PascalCase       | `GoldPrice`, `CotReport` |
| Variables/funcs   | camelCase        | `fetchGoldPrice`, `netPosition` |
| CSS variables     | kebab-case       | `--color-background`   |

### Components

- Client components: add `"use client";` as the first line
- Server components: no directive needed (default in App Router)
- Use default exports for components
- One component per file

```tsx
"use client";

export default function PriceChart() {
  return <div>...</div>;
}
```

### API Routes

- Use named exports matching HTTP methods: `GET`, `POST`, `PUT`, `DELETE`
- Return `NextResponse.json()` for all responses
- Keep route handlers thin — delegate logic to `/lib` modules

```typescript
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ data: null });
}
```

### Styling

- Tailwind CSS v4 utility classes (no `tailwind.config.js` — uses CSS-first config)
- CSS custom properties defined in `app/globals.css` under `:root` and `@theme inline`
- Dark mode: `prefers-color-scheme: dark` media query + `dark:` Tailwind variants
- Use semantic color variables: `--color-background`, `--color-foreground`

### Error Handling

- Never use empty `catch` blocks
- API routes: return appropriate HTTP status codes with error messages
- Lib functions: return `null` or throw typed errors — avoid swallowing exceptions

```typescript
// API route error handling
export async function GET() {
  try {
    const data = await fetchGoldPrice();
    if (!data) {
      return NextResponse.json({ error: "Data unavailable" }, { status: 503 });
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

## ESLint Configuration

Uses flat config (`eslint.config.mjs`) with:
- `eslint-config-next/core-web-vitals` — performance and accessibility rules
- `eslint-config-next/typescript` — TypeScript-specific rules

No Prettier is configured. Formatting is not enforced via tooling — maintain consistency manually:
- **Quotes**: double quotes for strings
- **Semicolons**: yes
- **Indentation**: 2 spaces
- **Trailing commas**: ES5-compatible positions

## Key Reminders for Agents

1. **Next.js 16**: Check `node_modules/next/dist/docs/` for API changes before using Next.js features
2. **React 19**: Server Components are the default — only add `"use client"` when hooks or browser APIs are needed
3. **No `pages/` directory**: This project uses App Router exclusively (`/app`)
4. **Tailwind v4**: No `tailwind.config.js` — configuration is CSS-first via `@theme inline` in `globals.css`
5. **Run `npm run build`** after significant changes to verify TypeScript and compilation
6. **Run `npm run lint`** before considering work complete
