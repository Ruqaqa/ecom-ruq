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
import postgres from "postgres";
import { seedDevTenant } from "../../scripts/seed-dev-tenant";
import { seedAdminUser } from "../../scripts/seed-admin-user";
import { TEST_TOKEN_PREFIX } from "./helpers/test-token-name";

export default async function globalSetup(): Promise<void> {
  const { id: devTenantId } = await seedDevTenant();
  await seedAdminUser();

  // Sweep access_tokens named with the shared test-prefix in the dev
  // tenant. Prior runs crash-exit, are Ctrl-C'd, or simply do not clean
  // up after themselves — the rows accumulate and pollute
  // /{locale}/admin/tokens for the human operator. Manually-minted
  // tokens (e.g. the one powering Claude Desktop) deliberately do NOT
  // use this prefix and survive the sweep. See
  // tests/e2e/helpers/test-token-name.ts for the prefix contract.
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      DELETE FROM access_tokens
      WHERE tenant_id = ${devTenantId}
        AND name LIKE ${TEST_TOKEN_PREFIX + "%"}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

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
    // Also flush the PAT issuance bucket. Sub-chunk 7.5 Playwright
    // tests mint many PATs in parallel against the single dev tenant;
    // the 20/hour rate limit is plenty for a human operator but not
    // for a suite that spins up 4+ workers × multiple mint flows.
    let ptCursor = "0";
    do {
      const [next, keys] = await redis.scan(
        ptCursor,
        "MATCH",
        "ratelimit:pat:issuance:*",
        "COUNT",
        500,
      );
      ptCursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (ptCursor !== "0");
  } catch {
    // Swallow — Redis unavailable means auth tests will fail loudly.
  } finally {
    await redis.quit().catch(() => undefined);
  }
}
