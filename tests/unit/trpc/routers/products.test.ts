/**
 * Block 4 — `productsRouter.create` tRPC procedure.
 *
 * Composition under test:
 *   mutationProcedure                              (audit-wrap: tx + withTenant)
 *     .use(requireMembership(['owner','staff']))   (authn + role gate)
 *     .input(CreateProductInputSchema)             (Zod input validation)
 *     .mutation(...)                               (delegates to createProduct service)
 *
 * Contract:
 *   - owner role: success audit row; ProductOwner shape returned (includes costPriceMinor).
 *   - anonymous: UNAUTHORIZED from requireSession; failure audit with errorCode='forbidden'.
 *   - session + no membership (customer): FORBIDDEN; failure audit errorCode='forbidden'.
 *   - owner + invalid input (121-char slug.en): validation_failed; `input` column in the
 *     failure audit row is `{ kind: 'validation', failedPaths: [...] }`, NEVER the raw
 *     body (High-01 regression on the real mutation path).
 *   - tenantId on the inserted row comes from ctx.tenant.id. There is no input field
 *     to spoof — CreateProductInputSchema.shape has no tenantId key — this invariant
 *     lives in block 3; the block-4 test confirms the wiring preserves it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
});

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

interface TenantFixture {
  tenantId: string;
  host: string;
}

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  const slug = `prod-router-test-${id.slice(0, 8)}`;
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

async function readInputPayload(tenantId: string): Promise<unknown> {
  const rows = await db.execute<{ payload: unknown }>(
    sql`SELECT payload FROM audit_payloads WHERE tenant_id = ${tenantId}::uuid AND kind='input' ORDER BY created_at DESC LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ payload: unknown }> }).rows ?? [];
  return arr[0]?.payload;
}

function goodInput() {
  return {
    slug: "sony-a7iv-" + Math.random().toString(36).slice(2, 8),
    name: { en: "Sony A7 IV", ar: "سوني" },
  };
}

describe("productsRouter.create", () => {
  it("owner role: runs createProduct end-to-end, writes a success audit row, returns ProductOwner shape", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const out = await appRouter.createCaller(ctx).products.create(goodInput());
    expect(out).toMatchObject({ status: "draft" });
    expect("costPriceMinor" in out).toBe(true);
    expect((out as { costPriceMinor: number | null }).costPriceMinor).toBeNull();

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      operation: "products.create",
      error: null,
    });
  });

  it("anonymous caller: UNAUTHORIZED + failure audit row with forbidden code", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(
      appRouter.createCaller(ctx).products.create(goodInput()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      operation: "products.create",
      error: JSON.stringify({ code: "forbidden" }),
    });
  });

  it("session + no membership (customer): FORBIDDEN + failure audit row with forbidden code", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId });

    await expect(
      appRouter.createCaller(ctx).products.create(goodInput()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      error: JSON.stringify({ code: "forbidden" }),
    });
  });

  it("owner + invalid input (121-char slug): validation_failed + input payload is field-paths only, never raw body", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    // Distinctive Latin-only string so the regex accepts the shape and
    // the max(120) check is what fires — verifies field-paths-only
    // audit on the size branch rather than on regex rejection. The
    // string uses `"SECRET_SLUG_DO_NOT_LEAK"` as a unique prefix + 97
    // lowercase 'a' chars = 120 chars exactly? No — "SECRET_SLUG_DO_NOT_LEAK" is 23
    // uppercase chars which would fail the regex. Use Latin-lowercase
    // canary and verify absence via a different sentinel pattern.
    const sentinel = "secret-do-not-leak-canary";
    const slug = sentinel + "-" + "a".repeat(121 - sentinel.length - 1);
    expect(slug.length).toBe(121);
    await expect(
      appRouter.createCaller(ctx).products.create({
        slug,
        name: { en: "ok", ar: "ok" },
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.error).toBe(JSON.stringify({ code: "validation_failed" }));

    const payload = await readInputPayload(fx.tenantId);
    expect(payload).toMatchObject({ kind: "validation" });
    expect(JSON.stringify(payload)).not.toContain(sentinel);
    expect(JSON.stringify((payload as { failedPaths: string[] }).failedPaths)).toMatch(/slug/);
  });

  it("products row carries ctx.tenant.id, not anything input-derived (wiring-preserves-invariant check)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });

    const out = await appRouter.createCaller(ctx).products.create(goodInput());
    const id = (out as { id: string }).id;

    const rows = await db.execute<{ tenant_id: string }>(
      sql`SELECT tenant_id::text AS tenant_id FROM products WHERE id = ${id}`,
    );
    const arr = Array.isArray(rows)
      ? rows
      : (rows as { rows?: Array<{ tenant_id: string }> }).rows ?? [];
    expect(arr[0]?.tenant_id).toBe(fx.tenantId);
  });
});
