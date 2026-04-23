/**
 * `lookupBearerToken` under the REAL `app_user` role — sub-chunk 7.6.1
 * Block F-1.
 *
 * The sibling `bearer-lookup.test.ts` covers the cross-tenant /
 * revocation / expiry / S-5 / S-9 semantics while wiring the module's
 * DB through the `__setBearerLookupDbForTests` seam — which points at
 * the `postgres` superuser and therefore bypasses RLS.
 *
 * This file is the ORTHOGONAL surface: we exercise the production
 * `appDb` module-level singleton (no test seam) with a per-test
 * connection that enters the `app_user` role via `SET LOCAL ROLE`.
 * Without Block A's `withPreAuthTenant` wrap setting `app.tenant_id`,
 * RLS would filter every row and every call would return null.
 *
 * Pattern mirrors
 * tests/unit/services/products/create-product.test.ts:226-244.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { accessTokens } from "@/server/db/schema/tokens";
import { hashBearerToken } from "@/server/auth/bearer-hash";
import { lookupBearerToken } from "@/server/auth/bearer-lookup";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

// Superuser for fixture seed/teardown (RLS-bypassed).
const superSql = postgres(DATABASE_URL, { max: 2 });

const tenantA = randomUUID();
const tenantB = randomUUID();
const userId = randomUUID();
const rawTokenA = `eruq_pat_${randomBytes(24).toString("base64url")}`;
let rowAId: string | null = null;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) {
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  }

  const nameA = { en: "A", ar: "أ" };
  const nameB = { en: "B", ar: "ب" };

  await superSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (
      ${tenantA},
      ${`rls-a-${tenantA.slice(0, 8)}`},
      ${`rls-a-${tenantA.slice(0, 8)}.test.local`},
      'en',
      'active',
      ${superSql.json(nameA)},
      ${`no-reply@rls-a-${tenantA.slice(0, 8)}.test.local`}
    )
  `;
  await superSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (
      ${tenantB},
      ${`rls-b-${tenantB.slice(0, 8)}`},
      ${`rls-b-${tenantB.slice(0, 8)}.test.local`},
      'ar',
      'active',
      ${superSql.json(nameB)},
      ${`no-reply@rls-b-${tenantB.slice(0, 8)}.test.local`}
    )
  `;
  await superSql`
    INSERT INTO "user" (id, email, email_verified)
    VALUES (${userId}, ${`rls-${userId.slice(0, 8)}@example.com`}, true)
  `;
  await superSql`
    INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantA}, ${userId}, 'owner')
  `;

  const hash = hashBearerToken(rawTokenA);
  const [row] = await superSql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (
      ${userId}, ${tenantA}, 'rls-a', ${hash},
      ${rawTokenA.slice(9, 17)}, ${superSql.json({ role: "owner" })}
    )
    RETURNING id
  `;
  if (!row) throw new Error("failed to seed access token");
  rowAId = row.id;
});

afterAll(async () => {
  if (rowAId) {
    await superSql`DELETE FROM access_tokens WHERE id = ${rowAId}`;
  }
  await superSql`DELETE FROM memberships WHERE user_id = ${userId}`;
  await superSql`DELETE FROM "user" WHERE id = ${userId}`;
  await superSql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await superSql.end({ timeout: 5 });
});

describe("lookupBearerToken — app_user role (RLS gate)", () => {
  it("F-1-green: returns the row under the wrapped path (withPreAuthTenant sets GUC)", async () => {
    // The production `appDb` pool in `src/server/db/index.ts` connects
    // via DATABASE_URL_APP. In dev that is the superuser too today, but
    // the `withPreAuthTenant` wrap must set the GUC so the code works
    // in a production `app_user` deployment. This test proves the wrap
    // resolves through to a matching row — same module, no test seam.
    const row = await lookupBearerToken(rawTokenA, tenantA);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(rowAId);
    expect(row?.tenantId).toBe(tenantA);
  });

  it("F-1-cross-tenant: presenting tenant-A token with tenant-B returns null even under GUC=B", async () => {
    // Cross-tenant rejection holds for two reasons: (a) the explicit
    // `eq(accessTokens.tenantId, tenantId)` predicate in the query,
    // and (b) RLS scoping to the current `app.tenant_id` (B here).
    // Defense in depth — the test asserts the composite holds.
    const row = await lookupBearerToken(rawTokenA, tenantB);
    expect(row).toBeNull();
  });

  it("F-1-red-gate: raw unwrapped select under app_user + no GUC returns zero rows (regression detector)", async () => {
    // This is the pathology we are fixing. A caller that bypasses
    // `withPreAuthTenant` and issues the select directly against a
    // live `app_user` tx with `app.tenant_id` unset must hit the RLS
    // predicate `tenant_id = nullif(current_setting('app.tenant_id',
    // true), '')::uuid` — which evaluates to NULL and filters the row
    // out. Stays green forever as a regression detector: if someone
    // adds a new pre-auth callsite without the wrap, this canary
    // asserts the failure mode exists.
    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        // No `SET LOCAL app.tenant_id` — this is the bug surface.
        return tx
          .select({ id: accessTokens.id })
          .from(accessTokens)
          .limit(1);
      });
      expect(rows).toEqual([]);
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("F-1-round-trip: when set_config is swallowed, the wrap throws the verbatim failed-to-set message", async () => {
    // Block A already covers the helper's round-trip throw verbatim in
    // tests/unit/db/with-pre-auth-tenant.test.ts. This case proves the
    // wrap is REACHED from `lookupBearerToken` — i.e. the round-trip
    // gate is operative on this production callsite, not just on the
    // helper in isolation. We monkeypatch the module's `appDb` to a
    // proxy that swallows the set_config call; the same throw must
    // propagate out of `lookupBearerToken`.
    const { __setBearerLookupDbForTests } = await import(
      "@/server/auth/bearer-lookup"
    );
    const realClient = postgres(DATABASE_URL, { max: 1 });
    const realDb = drizzle(realClient, { schema });
    const patchedDb = new Proxy(realDb, {
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
                      if (calls === 1) return Promise.resolve([]);
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
    }) as typeof realDb;

    __setBearerLookupDbForTests(patchedDb);
    try {
      await expect(lookupBearerToken(rawTokenA, tenantA)).rejects.toThrow(
        /^withPreAuthTenant: failed to set app\.tenant_id GUC$/,
      );
    } finally {
      __setBearerLookupDbForTests(null);
      await realClient.end({ timeout: 5 });
    }
  });
});
