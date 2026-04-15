"use client";

// QueryClient + Supabase providers
//
// Wraps the app with TanStack React Query's QueryClientProvider.
// The QueryClient is created once via useState to survive re-renders
// without creating a new client on every render cycle.

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Keep data fresh for 15 minutes (matches polling interval)
            staleTime: 15 * 60 * 1000,
            // Cache unused data for 30 minutes before garbage collection
            gcTime: 30 * 60 * 1000,
            // Retry failed requests twice with exponential backoff
            retry: 2,
            // Don't refetch on window focus for trading data
            // (Realtime handles freshness instead)
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
