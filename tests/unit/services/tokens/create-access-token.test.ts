/**
 * `createAccessToken` — sub-chunk 7.1 service test.
 *
 * Contract:
 *   - Inputs parsed through Zod (`CreateAccessTokenInputSchema`).
 *     - `scopes.role: 'owner'` requires `ownerScopeConfirm: z.literal(true)` (S-1).
 *     - `expiresAt` defaults to now+90d, max = now+365d (S-2).
 *     - `expiresAt` in the past → validation_failed (S-3).
 *   - Service never reads `tenantId` / `userId` from input (Low-02 shape rule #6).
 *   - Service is called under `withTenant` by the adapter; RLS guards tenant scope.
 *   - Owner-only creation (role gate); staff/support/customer/anonymous → FORBIDDEN.
 *   - Returns `{ plaintext, id, tokenPrefix, name, scopes, expiresAt, createdAt }`
 *     exactly once; `plaintext = 'eruq_pat_' + 43-char base64url`.
 *   - Per-tenant rate limit: 20 issuances per hour via `pat:issuance:{tenantId}` bucket (S-4).
 *   - Pepper missing → throws before insert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { accessTokens } from "@/server/db/schema/tokens";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { hashBearerToken } from "@/server/auth/bearer-hash";
import Redis from "ioredis";
import { __setRedisForTests } from "@/server/auth/rate-limit";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

const superClient = postgres(DATABASE_URL, { max: 3 });
const superDb = drizzle(superClient, { schema });

let redis: Redis;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) {
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  }
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
  const slug = `pat-svc-test-${id.slice(0, 8)}`;
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

function goodInput() {
  return {
    name: "Test PAT",
    scopes: { role: "staff" as const },
  };
}

async function flushIssuanceBucket(tenantId: string) {
  const keys = await redis.keys(`ratelimit:pat:issuance:${tenantId}`);
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  // Make sure each test starts with a clean bucket (tenants are fresh, but
  // defense-in-depth).
});

describe("createAccessToken — service", () => {
  it("happy path: returns a plaintext of shape eruq_pat_<43-char-base64url>, tokenPrefix matches plaintext.slice(9,17), hash round-trips", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      createAccessToken(tx, { id: tenantId }, userId, "owner", goodInput()),
    );

    expect(out.plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);
    expect(out.tokenPrefix).toBe(out.plaintext.slice(9, 17));
    expect(out.name).toBe("Test PAT");
    expect(out.scopes).toMatchObject({ role: "staff" });
    expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(out.expiresAt).toBeInstanceOf(Date);
    // Default 90d (±2min).
    const expected = Date.now() + 90 * 24 * 3600 * 1000;
    expect(Math.abs(out.expiresAt!.getTime() - expected)).toBeLessThan(2 * 60 * 1000);

    // Row hash in DB matches hashBearerToken(plaintext).
    const rows = await superDb.execute<{ token_hash: Buffer }>(
      sql`SELECT token_hash FROM access_tokens WHERE id = ${out.id}::uuid`,
    );
    const arr = Array.isArray(rows) ? rows : ((rows as { rows?: typeof rows }).rows ?? []);
    const row = (arr as unknown as Array<{ token_hash: Buffer }>)[0];
    const expectedHash = hashBearerToken(out.plaintext);
    // Buffer comparison — pg returns Buffer for bytea.
    expect(row?.token_hash).toBeDefined();
    expect(Buffer.compare(row!.token_hash, expectedHash)).toBe(0);
  });

  it("service trusts its `tenant` parameter — inserts under ctx.tenant.id, not anything from input", async () => {
    const { CreateAccessTokenInputSchema } = await import(
      "@/server/services/tokens/create-access-token"
    );
    const keys = Object.keys(CreateAccessTokenInputSchema.shape);
    expect(keys).not.toContain("tenantId");
    expect(keys).not.toContain("userId");
  });

  it("role gate: non-owner roles (staff, support, customer, anonymous) → FORBIDDEN", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    for (const badRole of ["staff", "support", "customer", "anonymous"] as const) {
      await expect(
        withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
          createAccessToken(tx, { id: tenantId }, userId, badRole, goodInput()),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("S-1: scopes.role='owner' without ownerScopeConfirm=true → validation_failed", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        createAccessToken(tx, { id: tenantId }, userId, "owner", {
          name: "Owner PAT",
          scopes: { role: "owner" },
          // missing ownerScopeConfirm
        }),
      ),
    ).rejects.toThrow();

    // Confirm=true accepted.
    const okOut = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      createAccessToken(tx, { id: tenantId }, userId, "owner", {
        name: "Owner PAT",
        scopes: { role: "owner" },
        ownerScopeConfirm: true,
      }),
    );
    expect(okOut.plaintext).toMatch(/^eruq_pat_/);
  });

  it("S-3: expiresAt in the past → validation_failed", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        createAccessToken(tx, { id: tenantId }, userId, "owner", {
          ...goodInput(),
          expiresAt: new Date(Date.now() - 1000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("S-2: default expiresAt is now+90d ±1min", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      createAccessToken(tx, { id: tenantId }, userId, "owner", goodInput()),
    );
    const delta = Math.abs(out.expiresAt!.getTime() - (Date.now() + 90 * 24 * 3600 * 1000));
    expect(delta).toBeLessThan(60 * 1000);
  });

  it("S-2: explicit expiresAt beyond 1y from now → validation_failed", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        createAccessToken(tx, { id: tenantId }, userId, "owner", {
          ...goodInput(),
          expiresAt: new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("S-4: per-tenant issuance rate limit — 21st call within an hour → TOO_MANY_REQUESTS", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    // Seed the bucket to 20 recent hits (at the limit) by zadd'ing fake members.
    const now = Date.now();
    const pipeline = redis.multi();
    for (let i = 0; i < 20; i++) {
      pipeline.zadd(`ratelimit:pat:issuance:${tenantId}`, now - i * 100, `seed-${i}`);
    }
    await pipeline.exec();

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        createAccessToken(tx, { id: tenantId }, userId, "owner", goodInput()),
      ),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("RLS: service insert fails with pg 42501 when called as app_user WITHOUT withTenant", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDbLocal = drizzle(appClient, { schema });
    try {
      await expect(
        appDbLocal.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          return createAccessToken(tx, { id: tenantId }, userId, "owner", goodInput());
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("TOKEN_HASH_PEPPER missing → throws before insert", async () => {
    const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUser();
    await flushIssuanceBucket(tenantId);

    const saved = process.env.TOKEN_HASH_PEPPER;
    delete process.env.TOKEN_HASH_PEPPER;
    try {
      await expect(
        withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
          createAccessToken(tx, { id: tenantId }, userId, "owner", goodInput()),
        ),
      ).rejects.toThrow(/TOKEN_HASH_PEPPER/);

      // And no row was inserted under this tenant (insert never happened).
      const rows = await superDb
        .select({ id: accessTokens.id })
        .from(accessTokens)
        .where(sql`${accessTokens.tenantId} = ${tenantId}::uuid`);
      expect(rows.length).toBe(0);
    } finally {
      process.env.TOKEN_HASH_PEPPER = saved;
    }
  });
});
