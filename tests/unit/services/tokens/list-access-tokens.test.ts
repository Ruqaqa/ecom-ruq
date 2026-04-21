/**
 * `listAccessTokens` — sub-chunk 7.1.
 *
 * Contract:
 *   - No input.
 *   - Only non-revoked rows under the current tenant.
 *   - Hard LIMIT 200.
 *   - Owner + staff allowed. support / customer / anonymous → FORBIDDEN.
 *   - Output schema OMITS `plaintext` and `tokenHash` (Tier-B gate via
 *     `.parse`, same pattern as `ProductPublicSchema`).
 *   - Cross-tenant rows excluded by GUC + explicit predicate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { __setRedisForTests } from "@/server/auth/rate-limit";
import Redis from "ioredis";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

const superClient = postgres(DATABASE_URL, { max: 3 });
const superDb = drizzle(superClient, { schema });

let redis: Redis;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  __setRedisForTests(redis);
});

afterAll(async () => {
  __setRedisForTests(null);
  await redis.quit();
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `pat-list-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function makeUser(): Promise<string> {
  const userId = randomUUID();
  await superDb.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  return userId;
}

function ctxFor(tenantId: string, userId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId, actorType: "user", tokenId: null, role: "owner" },
  );
}

async function flushIssuanceBucket(tenantId: string) {
  const keys = await redis.keys(`ratelimit:pat:issuance:${tenantId}`);
  if (keys.length > 0) await redis.del(...keys);
}

async function mintTokenFor(tenantId: string, userId: string): Promise<string> {
  const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
  await flushIssuanceBucket(tenantId);
  const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
    createAccessToken(tx, { id: tenantId }, userId, "owner", {
      name: "seed-" + Math.random().toString(36).slice(2, 6),
      scopes: { role: "staff" },
    }),
  );
  return out.id;
}

beforeEach(async () => {
  // Each test uses a fresh tenant.
});

describe("listAccessTokens — service", () => {
  it("owner role: returns the tenant's non-revoked tokens with redacted shape (no plaintext/tokenHash)", async () => {
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    const a = await mintTokenFor(tenantId, userId);
    const b = await mintTokenFor(tenantId, userId);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      listAccessTokens(tx, { id: tenantId }, "owner"),
    );

    const ids = out.map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    for (const row of out) {
      expect(row).toHaveProperty("tokenPrefix");
      expect(row).toHaveProperty("name");
      expect(row).toHaveProperty("expiresAt");
      // Tier-B gate — must never leak.
      expect(row).not.toHaveProperty("plaintext");
      expect(row).not.toHaveProperty("tokenHash");
    }
    expect(JSON.stringify(out)).not.toContain("eruq_pat_");
  });

  it("staff role: allowed (visibility is needed for staff-facing admin UI)", async () => {
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await mintTokenFor(tenantId, userId);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      listAccessTokens(tx, { id: tenantId }, "staff"),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("role gate: support / customer / anonymous → FORBIDDEN", async () => {
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await mintTokenFor(tenantId, userId);

    for (const badRole of ["support", "customer", "anonymous"] as const) {
      await expect(
        withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
          listAccessTokens(tx, { id: tenantId }, badRole),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("excludes revoked rows", async () => {
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    const a = await mintTokenFor(tenantId, userId);
    const b = await mintTokenFor(tenantId, userId);

    await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      revokeAccessToken(tx, { id: tenantId }, userId, "owner", { tokenId: a, confirm: true }),
    );

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      listAccessTokens(tx, { id: tenantId }, "owner"),
    );
    const ids = out.map((r) => r.id);
    expect(ids).not.toContain(a);
    expect(ids).toContain(b);
  });

  it("tenant isolation: only current tenant's rows appear", async () => {
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const tenantA = await makeTenant();
    const userA = await makeUser();
    const tenantB = await makeTenant();
    const userB = await makeUser();
    const aId = await mintTokenFor(tenantA, userA);
    const bId = await mintTokenFor(tenantB, userB);

    const out = await withTenant(superDb, ctxFor(tenantA, userA), async (tx) =>
      listAccessTokens(tx, { id: tenantA }, "owner"),
    );
    const ids = out.map((r) => r.id);
    expect(ids).toContain(aId);
    expect(ids).not.toContain(bId);
  });

  it("hard LIMIT 200: seeded with 201 rows, returns at most 200", async () => {
    // Seed 201 tokens by direct INSERT (bypasses the per-tenant issuance
    // rate limit which is 20/hour — rate-limit is on the *issuance path*,
    // not on arbitrary preexisting rows).
    const { listAccessTokens } = await import("@/server/services/tokens/list-access-tokens");
    const { accessTokens } = await import("@/server/db/schema/tokens");
    const tenantId = await makeTenant();
    const userId = await makeUser();

    const rows = Array.from({ length: 201 }, (_, i) => ({
      tenantId,
      userId,
      name: `bulk-${i}`,
      tokenHash: randomBytes(32),
      tokenPrefix: randomBytes(4).toString("hex").slice(0, 8),
      scopes: { role: "staff" as const },
    }));
    await superDb.insert(accessTokens).values(rows);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      listAccessTokens(tx, { id: tenantId }, "owner"),
    );
    expect(out.length).toBe(200);
  });
});
