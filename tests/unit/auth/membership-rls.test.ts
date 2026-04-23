/**
 * `resolveMembership` under the REAL `app_user` role — sub-chunk 7.6.1
 * Block F-2.
 *
 * Mirrors `tests/unit/auth/bearer-lookup-rls.test.ts` for the session-
 * cookie pre-auth path: `resolveMembership(userId, tenantId)` must
 * enter a `withPreAuthTenant` scope so RLS returns rows under
 * `app_user`. The existing `membership.ts` docstring claim that "we
 * intentionally do NOT read app.tenant_id" was true for the input side
 * but did not address RLS evaluation at query time — Block C rewrites
 * it, these tests assert the new behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { memberships } from "@/server/db/schema/memberships";
import {
  resolveMembership,
  __setMembershipDbForTests,
} from "@/server/auth/membership";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

const superSql = postgres(DATABASE_URL, { max: 2 });

const tenantA = randomUUID();
const tenantB = randomUUID();
const userU = randomUUID();

beforeAll(async () => {
  const nameA = { en: "A", ar: "أ" };
  const nameB = { en: "B", ar: "ب" };
  await superSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (
      ${tenantA},
      ${`mem-a-${tenantA.slice(0, 8)}`},
      ${`mem-a-${tenantA.slice(0, 8)}.test.local`},
      'en', 'active', ${superSql.json(nameA)},
      ${`no-reply@mem-a-${tenantA.slice(0, 8)}.test.local`}
    )
  `;
  await superSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (
      ${tenantB},
      ${`mem-b-${tenantB.slice(0, 8)}`},
      ${`mem-b-${tenantB.slice(0, 8)}.test.local`},
      'ar', 'active', ${superSql.json(nameB)},
      ${`no-reply@mem-b-${tenantB.slice(0, 8)}.test.local`}
    )
  `;
  await superSql`
    INSERT INTO "user" (id, email, email_verified)
    VALUES (${userU}, ${`mem-${userU.slice(0, 8)}@example.com`}, true)
  `;
  await superSql`
    INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantA}, ${userU}, 'owner')
  `;
});

afterAll(async () => {
  await superSql`DELETE FROM memberships WHERE user_id = ${userU}`;
  await superSql`DELETE FROM "user" WHERE id = ${userU}`;
  await superSql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await superSql.end({ timeout: 5 });
});

describe("resolveMembership — app_user role (RLS gate)", () => {
  it("F-2-green: returns the membership row under the wrapped path", async () => {
    const m = await resolveMembership(userU, tenantA);
    expect(m).not.toBeNull();
    expect(m?.tenantId).toBe(tenantA);
    expect(m?.userId).toBe(userU);
    expect(m?.role).toBe("owner");
  });

  it("F-2-cross-tenant: (userU, tenantA) membership is not returned when resolving for tenantB", async () => {
    const m = await resolveMembership(userU, tenantB);
    expect(m).toBeNull();
  });

  it("F-2-red-gate: raw unwrapped select under app_user + no GUC returns zero rows", async () => {
    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        return tx.select({ id: memberships.id }).from(memberships).limit(1);
      });
      expect(rows).toEqual([]);
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("F-2-round-trip: when set_config is swallowed, the wrap throws the verbatim failed-to-set message", async () => {
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

    __setMembershipDbForTests(patchedDb);
    try {
      await expect(resolveMembership(userU, tenantA)).rejects.toThrow(
        /^withPreAuthTenant: failed to set app\.tenant_id GUC$/,
      );
    } finally {
      __setMembershipDbForTests(null);
      await realClient.end({ timeout: 5 });
    }
  });
});
