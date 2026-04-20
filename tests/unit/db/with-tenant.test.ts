/**
 * withTenant plumbing test. The RLS canary in tenant-isolation.test.ts
 * covers policy semantics at the SQL layer (SET LOCAL ROLE app_user +
 * raw set_config). This file covers the Drizzle helper path used at
 * runtime: AuthedTenantContext factory → withTenant → GUC set → fn(tx).
 *
 * Runs the tx as the superuser `postgres`, which bypasses RLS. That is
 * intentional — this test is about helper plumbing, not about policy
 * enforcement (which lives in tenant-isolation.test.ts).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

describe("withTenant", () => {
  const tenantId = randomUUID();
  const ctx = buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, role: "anonymous" },
  );

  it("sets app.tenant_id GUC inside the transaction", async () => {
    const seen = await withTenant(db, ctx, async (tx) => {
      const rows = await tx.execute<{ tenant: string }>(
        sql`SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      const arr = Array.isArray(rows) ? rows : (rows as { rows?: Array<{ tenant: string }> }).rows;
      return arr?.[0]?.tenant;
    });
    expect(seen).toBe(tenantId);
  });

  it("rejects nested invocations (flat-only)", async () => {
    const inner = buildAuthedTenantContext(
      { id: tenantId },
      { userId: null, role: "anonymous" },
    );
    await expect(
      withTenant(db, ctx, async () => {
        // Simulate a service fn wrongly re-entering withTenant from inside
        // the outer scope. AsyncLocalStorage propagates through the awaited
        // callback, so the inner call sees the outer scope and throws.
        return withTenant(db, inner, async () => null);
      }),
    ).rejects.toThrow(/flat-only/);
  });
});
