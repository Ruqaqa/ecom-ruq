/**
 * Client-side providers: React Query + tRPC.
 *
 * Mounted from `src/app/[locale]/layout.tsx` inside
 * `NextIntlClientProvider`. `QueryClient` and the tRPC client are both
 * per-mount (constructed with `useState(() => ...)`) so a future RSC
 * re-use doesn't accidentally cross streams between requests.
 *
 * Defaults chosen:
 *   - staleTime 30s: admin data is stable enough within a short window
 *     that re-fetching on every navigation is noise.
 *   - refetchOnWindowFocus false: default on-focus refetches race with
 *     mutation result UI ("I just saved this, why did it flicker?").
 */
"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTRPCClient } from "@/lib/trpc/client";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => makeTRPCClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
