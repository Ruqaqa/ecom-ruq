/**
 * `tokensRouter` — sub-chunk 7.1 tRPC router integration tests.
 *
 * Composition under test:
 *   create  = mutationProcedure .use(requireMembership(['owner'])) .input(...) .mutation(...)
 *   revoke  = mutationProcedure .use(requireMembership(['owner'])) .input(...) .mutation(...)
 *   list    = publicProcedure    .use(requireMembership(['owner','staff'])) .query(...)  [NOT audited]
 *
 * Contract:
 *   - Owner create: success audit row; after-payload redacts plaintext
 *     (belt-and-braces matcher on 'plaintext').
 *   - Owner revoke: success audit row with forbidden structural shape.
 *   - Staff/anonymous create: FORBIDDEN/UNAUTHORIZED + failure audit
 *     errorCode='forbidden'.
 *   - Zod validation fail: validation_failed audit, input payload is
 *     field-paths only (not the raw name/slug).
 *   - Cross-tenant revoke: NOT_FOUND audit.
 *   - `list` writes NO audit rows (queries do not audit).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { __setRedisForTests } from "@/server/auth/rate-limit";
import Redis from "ioredis";

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
});

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const client = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(client, { schema });

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  __setRedisForTests(redis);
});

afterAll(async () => {
  __setRedisForTests(null);
  await redis.quit();
  await client.end({ timeout: 5 });
});

interface TenantFixture {
  tenantId: string;
  host: string;
}

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  const slug = `pat-router-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return { tenantId: id, host };
}

async function makeUserAndMembership(
  tenantId: string,
  role: "owner" | "staff" | "support",
): Promise<{ userId: string }> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, ${role}, now())
  `);
  return { userId };
}

interface BuildCtxOpts {
  fixture: TenantFixture;
  identityType: "anonymous" | "session";
  userId?: string;
  membershipRole?: "owner" | "staff" | "support";
}

async function buildCtx(opts: BuildCtxOpts) {
  const { resolveTenant, __setTenantLookupLoaderForTests, clearTenantCacheForTests } = await import(
    "@/server/tenant"
  );
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(async () => ({
    id: opts.fixture.tenantId,
    slug: "t",
    primaryDomain: opts.fixture.host,
    defaultLocale: "en",
    senderEmail: "no-reply@" + opts.fixture.host,
    name: { en: "T", ar: "ت" },
  }));
  const tenant = await resolveTenant(opts.fixture.host);
  if (!tenant) throw new Error("fixture: resolveTenant returned null");

  const identity =
    opts.identityType === "anonymous"
      ? { type: "anonymous" as const }
      : { type: "session" as const, userId: opts.userId!, sessionId: "s_" + opts.userId };

  const membership = opts.membershipRole
    ? {
        id: "m_test",
        role: opts.membershipRole,
        userId: opts.userId!,
        tenantId: opts.fixture.tenantId,
      }
    : null;

  return { tenant, identity, membership };
}

async function readAuditRows(tenantId: string): Promise<
  Array<{ outcome: string; operation: string; error: string | null }>
> {
  const rows = await db.execute<{
    outcome: string;
    operation: string;
    error: string | null;
  }>(
    sql`SELECT outcome, operation, error FROM audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: typeof rows }).rows;
  return (unwrapped as unknown as Array<{ outcome: string; operation: string; error: string | null }>) ?? [];
}

async function readAllAuditPayloads(
  tenantId: string,
): Promise<Array<{ kind: string; payload: unknown }>> {
  const rows = await db.execute<{ kind: string; payload: unknown }>(
    sql`SELECT kind, payload FROM audit_payloads WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at ASC`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ kind: string; payload: unknown }> }).rows ?? [];
  return arr as unknown as Array<{ kind: string; payload: unknown }>;
}

async function flushIssuanceBucket(tenantId: string) {
  const keys = await redis.keys(`ratelimit:pat:issuance:${tenantId}`);
  if (keys.length > 0) await redis.del(...keys);
}

function goodCreateInput(overrides?: Record<string, unknown>) {
  return {
    name: "My admin PAT",
    scopes: { role: "staff" as const },
    ...overrides,
  };
}

describe("tokensRouter.create", () => {
  it("owner caller: returns plaintext once, writes success audit row that does NOT contain the plaintext (PII canary)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const out = await appRouter.createCaller(ctx).tokens.create(goodCreateInput());
    expect(out.plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);
    expect(out.tokenPrefix).toBe(out.plaintext.slice(9, 17));
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/i);

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      operation: "tokens.create",
      error: null,
    });

    // PII canary: no payload anywhere contains the plaintext.
    const payloads = await readAllAuditPayloads(fx.tenantId);
    expect(payloads.length).toBeGreaterThan(0);
    const joined = JSON.stringify(payloads);
    expect(joined).not.toContain(out.plaintext);
    // The `eruq_pat_` prefix alone could leak even if plaintext is
    // partially redacted — the exact-key matcher should strip the
    // whole `plaintext` field, not just the secret bytes.
    expect(joined).not.toContain("eruq_pat_");
  });

  it("staff caller: FORBIDDEN (owner-only) + failure audit errorCode='forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "staff" });

    await expect(
      appRouter.createCaller(ctx).tokens.create(goodCreateInput()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      operation: "tokens.create",
      error: JSON.stringify({ code: "forbidden" }),
    });
  });

  it("anonymous caller: UNAUTHORIZED + failure audit errorCode='forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(
      appRouter.createCaller(ctx).tokens.create(goodCreateInput()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.error).toBe(JSON.stringify({ code: "forbidden" }));
  });

  it("owner + invalid input (121-char name): validation_failed + input payload is field-paths only, never raw canary", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const canary = "canary-do-not-leak-";
    const badName = canary + "a".repeat(121 - canary.length);
    expect(badName.length).toBe(121);

    await expect(
      appRouter.createCaller(ctx).tokens.create({
        name: badName,
        scopes: { role: "staff" },
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.error).toBe(JSON.stringify({ code: "validation_failed" }));

    const payloads = await readAllAuditPayloads(fx.tenantId);
    const joined = JSON.stringify(payloads);
    expect(joined).not.toContain(canary);
    expect(joined).toMatch(/kind.*validation/);
    expect(joined).toMatch(/name/);
  });
});

describe("tokensRouter.revoke", () => {
  it("owner caller revokes their own token → success audit; double-revoke → NOT_FOUND audit", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const minted = await appRouter.createCaller(ctx).tokens.create(goodCreateInput());

    const out = await appRouter
      .createCaller(ctx)
      .tokens.revoke({ tokenId: minted.id, confirm: true });
    expect(out).toMatchObject({ id: minted.id, revoked: true });

    // Double-revoke → NOT_FOUND.
    await expect(
      appRouter.createCaller(ctx).tokens.revoke({ tokenId: minted.id, confirm: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const rows = await readAuditRows(fx.tenantId);
    // 1 create success + 1 revoke success + 1 revoke failure.
    expect(rows.length).toBe(3);
    expect(rows[1]).toMatchObject({ outcome: "success", operation: "tokens.revoke" });
    expect(rows[2]).toMatchObject({
      outcome: "failure",
      operation: "tokens.revoke",
      error: JSON.stringify({ code: "not_found" }),
    });
  });

  it("cross-tenant revoke → NOT_FOUND (no row leaks)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fxA = await makeTenant();
    const fxB = await makeTenant();
    const { userId: uA } = await makeUserAndMembership(fxA.tenantId, "owner");
    const { userId: uB } = await makeUserAndMembership(fxB.tenantId, "owner");
    await flushIssuanceBucket(fxA.tenantId);
    await flushIssuanceBucket(fxB.tenantId);
    const ctxA = await buildCtx({
      fixture: fxA,
      identityType: "session",
      userId: uA,
      membershipRole: "owner",
    });
    const ctxB = await buildCtx({
      fixture: fxB,
      identityType: "session",
      userId: uB,
      membershipRole: "owner",
    });

    const mintedB = await appRouter.createCaller(ctxB).tokens.create(goodCreateInput());

    await expect(
      appRouter.createCaller(ctxA).tokens.revoke({ tokenId: mintedB.id, confirm: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("tokensRouter.list", () => {
  it("owner caller: returns non-revoked tokens; writes NO audit rows (queries are not audited)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const minted = await appRouter.createCaller(ctx).tokens.create(goodCreateInput());
    const rowsBefore = await readAuditRows(fx.tenantId);
    const countBefore = rowsBefore.length;

    const listed = await appRouter.createCaller(ctx).tokens.list();
    expect(listed.map((t) => t.id)).toContain(minted.id);
    // No plaintext / tokenHash in the output.
    expect(JSON.stringify(listed)).not.toContain("eruq_pat_");

    const rowsAfter = await readAuditRows(fx.tenantId);
    expect(rowsAfter.length).toBe(countBefore); // no query audit.
  });

  it("staff caller: allowed", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    await flushIssuanceBucket(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "staff" });

    const listed = await appRouter.createCaller(ctx).tokens.list();
    expect(Array.isArray(listed)).toBe(true);
  });

  it("support caller: FORBIDDEN", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "support");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "support" });

    await expect(appRouter.createCaller(ctx).tokens.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("anonymous caller: UNAUTHORIZED", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(appRouter.createCaller(ctx).tokens.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
