/**
 * Playwright global setup: seed dev tenant + clear Mailpit.
 *
 * Runs once before the whole test run. Ensures:
 *   - a real tenant row exists for `localhost:5001` (so the DB-backed
 *     resolver returns it; no dependence on ALLOW_TENANT_FALLBACK);
 *   - Mailpit is empty so email-assertion tests do not trip over stale
 *     messages from a previous run.
 *
 * We intentionally do NOT truncate auth tables. Between-run isolation is
 * handled by per-test random emails; chunk 8 adds the full test-data
 * harness with per-worker tenant suffixes.
 */
import { request as playwrightRequest } from "@playwright/test";
import { seedDevTenant } from "../../scripts/seed-dev-tenant";

export default async function globalSetup(): Promise<void> {
  await seedDevTenant();

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
}
