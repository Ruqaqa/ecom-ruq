/**
 * `lookupBearerToken(rawToken, tenantId)` must:
 *   - return the access_tokens row matched on HMAC hash AND tenant_id
 *   - return null when the token is valid but issued for another tenant
 *     (cross-tenant rejection)
 *   - return null when the hash has no matching row (unknown token)
 *   - return null when the row is revoked or past expires_at
 *
 * This is the security boundary for PAT verification before chunk 7 builds
 * the full MCP surface. The cross-tenant test is the load-bearing assertion.
 *
 * We use TWO postgres clients deliberately:
 *   - `setupSql` is a raw postgres.js client used for seed/teardown. We do
 *     NOT wrap it in drizzle because drizzle-for-postgres-js mutates the
 *     client's tagged-template type dispatcher in ways that break
 *     direct-use patterns (JSON binding via `sql.json(...)` fails). Seeding
 *     uses the raw pattern that matches tenant-isolation.test.ts.
 *   - `lookupDb` is a SEPARATE postgres connection wrapped in drizzle and
 *     handed to `__setBearerLookupDbForTests` so the code under test
 *     exercises the real drizzle path.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/server/db/schema";
import { hashBearerToken } from "@/server/auth/bearer-hash";
import { lookupBearerToken, __setBearerLookupDbForTests } from "@/server/auth/bearer-lookup";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const setupSql = postgres(DATABASE_URL, { max: 2 });
const lookupClient = postgres(DATABASE_URL, { max: 2 });
const lookupDb = drizzle(lookupClient, { schema });

const tenantA = randomUUID();
const tenantB = randomUUID();
const userId = randomUUID();
const tokenA = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const tokenB = `eruq_pat_${randomBytes(24).toString("base64url")}`;

let tokenARowId: string | null = null;
let tokenBRowId: string | null = null;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) {
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  }

  const nameA = { en: "A", ar: "أ" };
  const nameB = { en: "B", ar: "ب" };

  await setupSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (${tenantA}, ${`blk-a-${tenantA.slice(0, 8)}`}, ${`blk-a-${tenantA.slice(0, 8)}.test.local`}, 'en', 'active', ${setupSql.json(nameA)}, ${`no-reply@blk-a-${tenantA.slice(0, 8)}.test.local`})
  `;
  await setupSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (${tenantB}, ${`blk-b-${tenantB.slice(0, 8)}`}, ${`blk-b-${tenantB.slice(0, 8)}.test.local`}, 'ar', 'active', ${setupSql.json(nameB)}, ${`no-reply@blk-b-${tenantB.slice(0, 8)}.test.local`})
  `;
  await setupSql`
    INSERT INTO "user" (id, email, email_verified)
    VALUES (${userId}, ${`bearer-${userId.slice(0, 8)}@example.com`}, true)
  `;

  const hashA = hashBearerToken(tokenA);
  const hashB = hashBearerToken(tokenB);

  const [a] = await setupSql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userId}, ${tenantA}, 'test-a', ${hashA}, ${tokenA.slice(9, 17)}, ${setupSql.json({ role: "owner" })})
    RETURNING id
  `;
  const [b] = await setupSql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userId}, ${tenantB}, 'test-b', ${hashB}, ${tokenB.slice(9, 17)}, ${setupSql.json({ role: "staff" })})
    RETURNING id
  `;
  if (!a || !b) throw new Error("failed to seed test access tokens");
  tokenARowId = a.id;
  tokenBRowId = b.id;

  __setBearerLookupDbForTests(lookupDb);
});

afterAll(async () => {
  __setBearerLookupDbForTests(null);
  if (tokenARowId && tokenBRowId) {
    await setupSql`DELETE FROM access_tokens WHERE id IN (${tokenARowId}, ${tokenBRowId})`;
  }
  await setupSql`DELETE FROM "user" WHERE id = ${userId}`;
  await setupSql`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await setupSql.end({ timeout: 5 });
  await lookupClient.end({ timeout: 5 });
});

afterEach(async () => {
  if (tokenARowId && tokenBRowId) {
    await setupSql`UPDATE access_tokens SET revoked_at = NULL, expires_at = NULL WHERE id IN (${tokenARowId}, ${tokenBRowId})`;
  }
});

describe("lookupBearerToken", () => {
  it("returns the matching row for a valid (token, tenant) pair", async () => {
    const row = await lookupBearerToken(tokenA, tenantA);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(tokenARowId);
    expect(row?.tenantId).toBe(tenantA);
    expect(row?.userId).toBe(userId);
  });

  it("returns null for an unknown token", async () => {
    const row = await lookupBearerToken("eruq_pat_doesnotexist_0000000000000000", tenantA);
    expect(row).toBeNull();
  });

  it("cross-tenant: token for tenant A presented with tenant B returns null", async () => {
    const row = await lookupBearerToken(tokenA, tenantB);
    expect(row).toBeNull();
  });

  it("returns null when the token is revoked", async () => {
    await setupSql`UPDATE access_tokens SET revoked_at = now() WHERE id = ${tokenARowId}`;
    const row = await lookupBearerToken(tokenA, tenantA);
    expect(row).toBeNull();
  });

  it("returns null when expires_at is in the past", async () => {
    await setupSql`UPDATE access_tokens SET expires_at = now() - interval '1 minute' WHERE id = ${tokenARowId}`;
    const row = await lookupBearerToken(tokenA, tenantA);
    expect(row).toBeNull();
  });
});
