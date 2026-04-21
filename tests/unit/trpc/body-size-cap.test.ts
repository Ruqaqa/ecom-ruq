/**
 * Adapter-level request-body size cap.
 *
 * Enforced in `src/app/api/trpc/[trpc]/route.ts` BEFORE the body reaches
 * `fetchRequestHandler` (and therefore before Zod parses). Rationale
 * (architect amendment 1): Zod's 16KB `.refine` on LocalizedText doesn't
 * fire until top-level shape passes; a multi-MB malformed body triggers
 * the failure path and stretches the per-tenant advisory-lock window.
 * The adapter cap cuts the attack off before parsing.
 *
 * The writer-level `capForHash` in `src/server/audit/write.ts` stays as
 * defense-in-depth for callers that bypass the tRPC adapter (e.g., a
 * cron job or an internal import). Both layers use the same 64KB
 * ceiling.
 *
 * These tests exercise the exported route handler directly — no HTTP
 * server — so they run in pure vitest.
 */
import { describe, it, expect } from "vitest";

const BIG_STRING_128KB = "a".repeat(128 * 1024);
const SAFE_STRING_60KB = "b".repeat(60 * 1024);

describe("tRPC adapter body-size cap", () => {
  it("returns 413 when POST content-length exceeds 64KB, before fetchRequestHandler is reached", async () => {
    const { POST } = await import("@/app/api/trpc/[trpc]/route");
    const req = new Request("http://shop.local/api/trpc/foo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Advisory length header indicates oversize — must reject before
        // reading the body or touching the router.
        "content-length": String(128 * 1024),
      },
      body: BIG_STRING_128KB,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toMatch(/too large/i);
  });

  it("returns 413 when POST body exceeds 64KB even without a content-length header", async () => {
    const { POST } = await import("@/app/api/trpc/[trpc]/route");
    // Construct via a ReadableStream so the runtime omits content-length.
    // Fallback: use a new Request where content-length is not forced.
    const req = new Request("http://shop.local/api/trpc/foo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BIG_STRING_128KB,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("passes through for POST bodies under 64KB (reaches the tRPC router and gets a procedure-not-found)", async () => {
    const { POST } = await import("@/app/api/trpc/[trpc]/route");
    // 60KB payload — well under the cap. Route does not exist, so the
    // response will be tRPC's NOT_FOUND procedure error — a valid JSON-RPC
    // envelope, NOT a 413.
    const req = new Request("http://shop.local/api/trpc/foo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: SAFE_STRING_60KB }),
    });
    const res = await POST(req);
    expect(res.status).not.toBe(413);
    // Could be 404 (unknown tenant host via resolveTenant) or 500-shaped
    // tRPC error; the concrete assertion is just "not rejected for size".
  });

  it("returns 413 when GET URL exceeds 64KB", async () => {
    const { GET } = await import("@/app/api/trpc/[trpc]/route");
    const huge = "q=" + "c".repeat(70 * 1024);
    const req = new Request(`http://shop.local/api/trpc/foo?${huge}`, {
      method: "GET",
    });
    const res = await GET(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toMatch(/too large/i);
  });
});
