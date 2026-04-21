/**
 * Playwright global setup: seed dev tenant + clear Mailpit + clear
 * auth rate-limit buckets.
 *
 * Runs once before the whole test run. Ensures:
 *   - a real tenant row exists for `localhost:5001` (so the DB-backed
 *     resolver returns it; no dependence on ALLOW_TENANT_FALLBACK);
 *   - Mailpit is empty so email-assertion tests do not trip over stale
 *     messages from a previous run;
 *   - rate-limit Redis keys for the auth bucket prefix are dropped so
 *     Playwright's parallel auth tests don't accumulate hits against the
 *     per-IP limit (dev has no proxy so every caller resolves to
 *     `unknown-ip` and shares one bucket per endpoint).
 *
 * We intentionally do NOT truncate auth tables. Between-run isolation is
 * handled by per-test random emails; chunk 8 adds the full test-data
 * harness with per-worker tenant suffixes.
 */
import { request as playwrightRequest } from "@playwright/test";
import Redis from "ioredis";
import { seedDevTenant } from "../../scripts/seed-dev-tenant";
import { seedAdminUser } from "../../scripts/seed-admin-user";

export default async function globalSetup(): Promise<void> {
  await seedDevTenant();
  await seedAdminUser();

  const mailpitBase = process.env.MAILPIT_URL ?? "http://localhost:58025";
  const ctx = await playwrightRequest.newContext({ baseURL: mailpitBase });
  try {
    await ctx.delete("/api/v1/messages").catch(() => {
      // If Mailpit isn't reachable, the email-flow tests will surface the
      // problem explicitly. Don't fail setup for an uncritical clear.
    });
  } finally {
    await ctx.dispose();
  }

  // Clear rate-limit buckets. Best-effort — if Redis is down, the auth
  // tests will throw SERVICE_UNAVAILABLE which surfaces the real issue.
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:56379";
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    // SCAN + DEL all ratelimit:auth:* keys. We scope to the auth prefix
    // so ad-hoc non-auth rate limiters (if any) don't get flushed.
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ratelimit:auth:*", "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    // Swallow — Redis unavailable means auth tests will fail loudly.
  } finally {
    await redis.quit().catch(() => undefined);
  }
}
