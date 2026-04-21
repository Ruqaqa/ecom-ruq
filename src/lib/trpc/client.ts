/**
 * tRPC React client for the web UI.
 *
 * `trpc` exports the client-side proxy typed against the server's
 * `AppRouter` — so call sites like
 *   `trpc.products.create.useMutation()`
 * are fully typed end-to-end from the React component down to the
 * service function's Zod input schema.
 *
 * Notes on the link config:
 *   - `superjson` transformer matches the server's init.ts so Date /
 *     Map / BigInt round-trip cleanly across the wire.
 *   - `httpBatchLink` folds concurrent procedure calls into one HTTP
 *     request — a free win over HTTP overhead, no server changes needed.
 *   - `credentials: 'include'` makes the Better Auth session cookie
 *     flow on same-origin fetches. Cookies are host-only (chunk 5
 *     ADR: no Domain attribute), so same-origin is the only scope they
 *     can reach anyway — this is a correctness flag, not a CORS knob.
 */
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/root";

export const trpc = createTRPCReact<AppRouter>();

export function makeTRPCClient(): ReturnType<typeof trpc.createClient> {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        fetch(url, options) {
          // Narrow override — avoid spreading `{ signal: undefined }` into
          // RequestInit under `exactOptionalPropertyTypes`.
          const init: RequestInit = { credentials: "include" };
          if (options?.body !== undefined) init.body = options.body;
          if (options?.method !== undefined) init.method = options.method;
          if (options?.headers !== undefined) init.headers = options.headers;
          if (options?.signal) init.signal = options.signal;
          return fetch(url, init);
        },
      }),
    ],
  });
}
