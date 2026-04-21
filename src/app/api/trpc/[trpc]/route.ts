/**
 * tRPC catch-all HTTP handler.
 *
 * One handler serves both GET (queries) and POST (mutations). No locale
 * prefix: tRPC is tenant-scoped via the request's Host header, mirroring
 * the Better Auth catch-all at /api/auth/[...all]/route.ts.
 *
 * Body-size cap is enforced HERE, BEFORE `fetchRequestHandler` runs Zod.
 * Security reasoning (checkpoint-2 amendment): Zod's 16KB `.refine` on
 * LocalizedText doesn't fire until the top-level shape parses. A hostile
 * actor with a multi-MB malformed body would otherwise trigger the
 * failure path at parse time, stretch the per-tenant advisory-lock
 * window around the audit chain, and starve other writers for that
 * tenant. The adapter cap cuts the attack off before parsing.
 *
 * The writer-level `capForHash` inside `insertAuditInTx` stays as
 * defense-in-depth for callers that bypass this adapter (e.g., a cron
 * job or internal import). Both layers use the SAME 64KB ceiling so
 * they never disagree.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/trpc/root";
import { createTRPCContext } from "@/server/trpc/context";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function tooLarge(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: -32600, message } }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "POST") {
    // Content-Length is advisory (some clients omit it, some lie). Use it
    // as a cheap early-reject signal, then read-and-measure as the
    // authoritative check before reconstructing a fresh Request for tRPC.
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      return tooLarge("Request body too large");
    }
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return tooLarge("Request body too large");
    }
    req = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: text,
    });
  } else if (req.method === "GET") {
    // GET query inputs arrive in the URL. Cap the whole URL length by the
    // same ceiling — realistic tRPC GET URLs are tiny.
    if (req.url.length > MAX_REQUEST_BODY_BYTES) {
      return tooLarge("Request URL too large");
    }
  }

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ req }),
  });
};

export { handler as GET, handler as POST };
