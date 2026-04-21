/**
 * `revokeAccessToken` — sub-chunk 7.1.
 *
 * Contract:
 *   - Input: `{ tokenId: uuid, confirm: z.literal(true) }`. Missing/false
 *     `confirm` → validation_failed (destructive-op rule, CLAUDE.md §2).
 *   - Soft-revoke: UPDATE revoked_at = now() WHERE id AND revoked_at IS NULL
 *     RETURNING id. Empty returning → NOT_FOUND (row absent OR already revoked).
 *   - Owner-only. Non-owner → FORBIDDEN.
 *   - Cross-tenant: a token in tenant B presented as-if-it-were-ours (same id)
 *     is invisible under our tenant GUC → NOT_FOUND.
 *   - After revoke: lookupBearerToken for that token returns null (THE spec
 *     test from the session resume notes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import {
  lookupBearerToken,
  __setBearerLookupDbForTests,
} from "@/server/auth/bearer-lookup";
import { __setMembershipDbForTests } from "@/server/auth/membership";
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
  __setBearerLookupDbForTests(superDb);
  __setMembershipDbForTests(superDb);
});

afterAll(async () => {
  __setRedisForTests(null);
  __setBearerLookupDbForTests(null);
  __setMembershipDbForTests(null);
  await redis.quit();
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `pat-revoke-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function makeUserWithMembership(
  tenantId: string,
  role: "owner" | "staff" | "support",
): Promise<string> {
  const userId = randomUUID();
  await superDb.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  await superDb.execute(sql`
    INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, ${role}, now())
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

async function mintTokenFor(
  tenantId: string,
  userId: string,
): Promise<{ id: string; plaintext: string }> {
  const { createAccessToken } = await import("@/server/services/tokens/create-access-token");
  await flushIssuanceBucket(tenantId);
  const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
    createAccessToken(tx, { id: tenantId }, userId, "owner", {
      name: "seed",
      scopes: { role: "staff" },
    }),
  );
  return { id: out.id, plaintext: out.plaintext };
}

describe("revokeAccessToken — service", () => {
  it("happy path: revokes a live token; lookupBearerToken for it returns null afterwards", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUserWithMembership(tenantId, "owner");
    const { id, plaintext } = await mintTokenFor(tenantId, userId);

    // Sanity: lookup returns a row before revoke.
    const before = await lookupBearerToken(plaintext, tenantId);
    expect(before?.id).toBe(id);

    const out = await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      revokeAccessToken(tx, { id: tenantId }, userId, "owner", { tokenId: id, confirm: true }),
    );
    expect(out).toMatchObject({ id, revoked: true });

    const after = await lookupBearerToken(plaintext, tenantId);
    expect(after).toBeNull();
  });

  it("confirm: false → validation_failed (destructive-op invariant)", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUserWithMembership(tenantId, "owner");
    const { id } = await mintTokenFor(tenantId, userId);

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        revokeAccessToken(tx, { id: tenantId }, userId, "owner", {
          tokenId: id,
          confirm: false as unknown as true,
        }),
      ),
    ).rejects.toThrow();
  });

  it("double-revoke → NOT_FOUND on the second call (idempotent-by-reject)", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUserWithMembership(tenantId, "owner");
    const { id } = await mintTokenFor(tenantId, userId);

    await withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
      revokeAccessToken(tx, { id: tenantId }, userId, "owner", { tokenId: id, confirm: true }),
    );
    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        revokeAccessToken(tx, { id: tenantId }, userId, "owner", { tokenId: id, confirm: true }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("unknown tokenId → NOT_FOUND", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUserWithMembership(tenantId, "owner");

    await expect(
      withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
        revokeAccessToken(tx, { id: tenantId }, userId, "owner", {
          tokenId: randomUUID(),
          confirm: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cross-tenant: tenant A caller cannot revoke tenant B's token → NOT_FOUND under A's GUC", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantA = await makeTenant();
    const userA = await makeUserWithMembership(tenantA, "owner");
    const tenantB = await makeTenant();
    const userB = await makeUserWithMembership(tenantB, "owner");
    const { id: idB } = await mintTokenFor(tenantB, userB);

    // Caller is tenantA owner — GUC scopes UPDATE to tenantA, so idB is
    // invisible → empty RETURNING → NOT_FOUND.
    await expect(
      withTenant(superDb, ctxFor(tenantA, userA), async (tx) =>
        revokeAccessToken(tx, { id: tenantA }, userA, "owner", { tokenId: idB, confirm: true }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("role gate: non-owner (staff, support, customer) → FORBIDDEN", async () => {
    const { revokeAccessToken } = await import("@/server/services/tokens/revoke-access-token");
    const tenantId = await makeTenant();
    const userId = await makeUserWithMembership(tenantId, "owner");
    const { id } = await mintTokenFor(tenantId, userId);

    for (const badRole of ["staff", "support", "customer", "anonymous"] as const) {
      await expect(
        withTenant(superDb, ctxFor(tenantId, userId), async (tx) =>
          revokeAccessToken(tx, { id: tenantId }, userId, badRole, { tokenId: id, confirm: true }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("no tenantId/userId field on the input schema (wiring invariant)", async () => {
    const { RevokeAccessTokenInputSchema } = await import(
      "@/server/services/tokens/revoke-access-token"
    );
    const keys = Object.keys(RevokeAccessTokenInputSchema.shape);
    expect(keys).not.toContain("tenantId");
    expect(keys).not.toContain("userId");
  });
});
