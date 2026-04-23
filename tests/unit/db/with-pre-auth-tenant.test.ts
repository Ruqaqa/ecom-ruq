/**
 * withPreAuthTenant plumbing tests — sub-chunk 7.6.1 Block A.
 *
 * Sibling of `withTenant` for the three pre-auth callsites
 * (`lookupBearerToken`, `resolveMembership`, `bumpLastUsedAt` — see the
 * helper docstring). Constructing an AuthedTenantContext is impossible
 * before the bearer token is verified, so a raw-string tenantId helper
 * is required. UUID validation + the Block E R-4 AST-walk invariant
 * contain the foot-gun blast radius.
 *
 * Runs as superuser here because we are covering helper plumbing, not
 * RLS policy enforcement. The F-1/F-2/F-3 test files cover the
 * role-gated semantics under `SET LOCAL ROLE app_user`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant, withPreAuthTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

describe("withPreAuthTenant", () => {
  it("sets app.tenant_id GUC inside the transaction", async () => {
    const tenantId = randomUUID();
    const seen = await withPreAuthTenant(db, tenantId, async (tx) => {
      const rows = await tx.execute<{ tenant: string }>(
        sql`SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      const arr = Array.isArray(rows)
        ? rows
        : (rows as { rows?: Array<{ tenant: string }> }).rows;
      return arr?.[0]?.tenant;
    });
    expect(seen).toBe(tenantId);
  });

  it("throws the verbatim invalid-tenantId message when tenantId is not a UUID", async () => {
    await expect(
      withPreAuthTenant(db, "not-a-uuid", async () => null),
    ).rejects.toThrow(/^withPreAuthTenant: invalid tenantId$/);
  });

  it("throws the verbatim nesting-guard message when called inside a withTenant scope", async () => {
    const outerTenant = randomUUID();
    const ctx = buildAuthedTenantContext(
      { id: outerTenant },
      { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
    );
    await expect(
      withTenant(db, ctx, async () => {
        return withPreAuthTenant(db, randomUUID(), async () => null);
      }),
    ).rejects.toThrow(
      /^withPreAuthTenant: already inside a tenant-scoped transaction; pre-auth helper cannot nest\.$/,
    );
  });

  it("throws the verbatim round-trip-mismatch message when set_config is swallowed", async () => {
    // Monkeypatch the drizzle wrapper so `tx.execute(sql`SELECT set_config(...)`)`
    // becomes a no-op. `current_setting('app.tenant_id', true)` with no
    // prior `set_config` returns the empty string, so the helper's
    // read-back row.tenant !== tenantId check must fire the verbatim
    // "failed to set app.tenant_id GUC" error. We intercept the first
    // `execute` of each tx (the set_config call) and let the second
    // (current_setting read-back) go through unmodified.
    const patchedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (cb: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (innerTx) => {
              const originalExecute = innerTx.execute.bind(innerTx);
              let calls = 0;
              const patchedTx = new Proxy(innerTx, {
                get(t, p) {
                  if (p === "execute") {
                    return (q: unknown) => {
                      calls += 1;
                      if (calls === 1) {
                        // Swallow the set_config call.
                        return Promise.resolve([]);
                      }
                      return originalExecute(q as never);
                    };
                  }
                  return Reflect.get(t, p);
                },
              });
              return cb(patchedTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(
      withPreAuthTenant(patchedDb, randomUUID(), async () => null),
    ).rejects.toThrow(
      /^withPreAuthTenant: failed to set app\.tenant_id GUC$/,
    );
  });
});
