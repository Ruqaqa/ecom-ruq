/**
 * `audit-wrap` middleware tests — adapter-level audit, mutations only.
 *
 * Contract per block-2c brief:
 *   - success: one audit_log row with outcome='success', same tx as the
 *     service work. Rolls back together if anything downstream throws.
 *   - failure: service throws → outer tx rolls back (no success audit, no
 *     product). A SECOND best-effort tx writes an outcome='failure' row
 *     with `error = { code: <closed-set> }`. correlationId is shared.
 *   - error mapping: TRPCError → { validation_failed | not_found |
 *     forbidden | rate_limited }; pg 23505/23503 → conflict; 42501 →
 *     rls_denied; anything else → internal_error.
 *   - audit_write_failure: if even the failure tx throws, Sentry shim
 *     receives `audit_write_failure` with correlation_id / tenant_id /
 *     operation / actor_type / code tags. The caller's original error
 *     still surfaces; audit loss is swallowed.
 *   - adversarial: raw `err.message` embedding PII MUST NOT land in the
 *     `error` column — only the closed-set code serialized as JSON.
 *   - queries do NOT trigger audit writes.
 *
 * Tests run against a real Postgres (same pattern as write.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `audit-wrap-test-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

interface AuditRow extends Record<string, unknown> {
  outcome: string;
  operation: string;
  error: string | null;
  correlation_id: string;
}

async function readAuditRows(tenantId: string): Promise<AuditRow[]> {
  const rows = await db.execute<AuditRow>(
    sql`SELECT outcome, operation, error, correlation_id::text AS correlation_id
        FROM audit_log WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as AuditRow[];
  const unwrapped = (rows as { rows?: AuditRow[] }).rows;
  return unwrapped ?? [];
}

function firstRow(rows: AuditRow[]): AuditRow {
  const r = rows[0];
  if (!r) throw new Error("expected at least one audit row");
  return r;
}

function lastRow(rows: AuditRow[]): AuditRow {
  const r = rows.at(-1);
  if (!r) throw new Error("expected at least one audit row");
  return r;
}

interface BuildCtxOpts {
  tenantId: string;
  identityType: "anonymous" | "session" | "bearer";
  userId?: string;
  tokenId?: string;
  membershipRole?: "owner" | "staff" | "support";
}

async function buildCtx(opts: BuildCtxOpts) {
  const { resolveTenant, __setTenantLookupLoaderForTests, clearTenantCacheForTests } = await import(
    "@/server/tenant"
  );
  const host = `${opts.tenantId.slice(0, 8)}.local`;
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(async () => {
    // minimal Tenant shape
    return {
      id: opts.tenantId,
      slug: "t",
      primaryDomain: host,
      defaultLocale: "en",
      senderEmail: "no-reply@" + host,
      name: { en: "T", ar: "ت" },
    };
  });
  const tenant = await resolveTenant(host);
  if (!tenant) throw new Error("fixture: resolveTenant returned null");

  const identity =
    opts.identityType === "anonymous"
      ? { type: "anonymous" as const }
      : opts.identityType === "session"
        ? { type: "session" as const, userId: opts.userId!, sessionId: "s_" + opts.userId }
        : { type: "bearer" as const, userId: opts.userId!, tokenId: opts.tokenId! };

  const membership = opts.membershipRole
    ? {
        id: "m_test",
        role: opts.membershipRole,
        userId: opts.userId!,
        tenantId: opts.tenantId,
      }
    : null;

  return { tenant, identity, membership };
}

describe("audit-wrap middleware", () => {
  it("writes an outcome='success' audit row for a successful mutation", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      doThing: mutationProcedure
        .input(z.object({ x: z.number() }))
        .mutation(({ input }) => ({ ok: true, received: input.x })),
    });
    const caller = r.createCaller(ctx);
    const out = await caller.doThing({ x: 7 });
    expect(out).toEqual({ ok: true, received: 7 });

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.outcome).toBe("success");
    expect(row.operation).toBe("doThing");
    expect(row.error).toBeNull();
  });

  it("writes an outcome='failure' row and rolls back when the mutation throws a TRPCError(FORBIDDEN)", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      doThing: mutationProcedure.mutation(() => {
        throw new TRPCError({ code: "FORBIDDEN", message: "nope" });
      }),
    });
    const caller = r.createCaller(ctx);
    await expect(caller.doThing()).rejects.toThrow();

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.outcome).toBe("failure");
    expect(row.error).toBe(JSON.stringify({ code: "forbidden" }));
  });

  it("maps pg SQLSTATE 23505 unique-violation to conflict and 42501 RLS-denied to rls_denied", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const conflictR = router({
      doThing: mutationProcedure.mutation(() => {
        const err = new Error("duplicate key");
        (err as unknown as { code: string }).code = "23505";
        throw err;
      }),
    });
    await expect(conflictR.createCaller(ctx).doThing()).rejects.toThrow();
    let rows = await readAuditRows(tenantId);
    expect(lastRow(rows).error).toBe(JSON.stringify({ code: "conflict" }));

    const rlsR = router({
      doThing: mutationProcedure.mutation(() => {
        const err = new Error("permission denied for table foo");
        (err as unknown as { code: string }).code = "42501";
        throw err;
      }),
    });
    await expect(rlsR.createCaller(ctx).doThing()).rejects.toThrow();
    rows = await readAuditRows(tenantId);
    expect(lastRow(rows).error).toBe(JSON.stringify({ code: "rls_denied" }));
  });

  it("maps unknown errors to internal_error and NEVER leaks raw err.message into audit_log.error", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      doThing: mutationProcedure.mutation(() => {
        throw new Error("email victim@example.com failed processing row 42");
      }),
    });
    await expect(r.createCaller(ctx).doThing()).rejects.toThrow();

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    const cell = firstRow(rows).error ?? "";
    expect(cell).toBe(JSON.stringify({ code: "internal_error" }));
    expect(cell).not.toMatch(/victim/);
    expect(cell).not.toMatch(/row 42/);
  });

  it("Sentry shim receives audit_write_failure if the failure-tx itself throws", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const sentry = await import("@/server/obs/sentry");
    const writeMod = await import("@/server/audit/write");

    const captureSpy = vi.fn();
    sentry.__setSentryForTests({ captureMessage: captureSpy });
    // Force the best-effort failure-audit write to throw.
    const origWrite = writeMod.writeAuditInOwnTx;
    const spy = vi.spyOn(writeMod, "writeAuditInOwnTx").mockImplementation(async () => {
      throw new Error("db down");
    });

    try {
      const tenantId = await makeTenant();
      const ctx = await buildCtx({ tenantId, identityType: "anonymous" });
      const r = router({
        doThing: mutationProcedure.mutation(() => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "x" });
        }),
      });
      await expect(r.createCaller(ctx).doThing()).rejects.toThrow();

      expect(captureSpy).toHaveBeenCalled();
      const call = captureSpy.mock.calls.find((c) => c[0] === "audit_write_failure");
      expect(call, "expected audit_write_failure capture").toBeTruthy();
      expect(call![1]?.tags?.operation).toBe("doThing");
      expect(call![1]?.tags?.code).toBe("validation_failed");
    } finally {
      spy.mockRestore();
      sentry.__setSentryForTests(null);
      // restore (no-op, the spy wrapped export)
      void origWrite;
    }
  });

  it("queries do NOT write audit rows", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      getThing: publicProcedure.query(() => ({ value: 1 })),
    });
    const out = await r.createCaller(ctx).getThing();
    expect(out).toEqual({ value: 1 });

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(0);
  });

  it("validation failure writes field-paths only, never raw input values", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      createThing: mutationProcedure
        .input(z.object({ slug: z.object({ en: z.string().max(5) }) }))
        .mutation(() => ({ ok: true })),
    });

    // The raw input contains a distinctive string ("SECRET_VALUE_DO_NOT_LEAK")
    // that MUST NOT land in audit_log or audit_payloads via any path.
    await expect(
      r.createCaller(ctx).createThing({
        slug: { en: "SECRET_VALUE_DO_NOT_LEAK_longer_than_five" },
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.outcome).toBe("failure");
    expect(row.error).toBe(JSON.stringify({ code: "validation_failed" }));

    // audit_payloads.payload for kind='input' must contain { kind:"validation",
    // failedPaths: [...] }, never the raw value.
    const payloadRows = await db.execute<{ payload: unknown }>(
      sql`SELECT payload FROM audit_payloads WHERE tenant_id = ${tenantId}::uuid AND kind='input'`,
    );
    const payloadArr = Array.isArray(payloadRows)
      ? payloadRows
      : (payloadRows as { rows?: Array<{ payload: unknown }> }).rows ?? [];
    expect(payloadArr.length).toBe(1);
    const payload = payloadArr[0]?.payload as { kind?: string; failedPaths?: unknown };
    expect(payload?.kind).toBe("validation");
    expect(Array.isArray(payload?.failedPaths)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("SECRET_VALUE_DO_NOT_LEAK");
    expect(JSON.stringify(payload?.failedPaths)).toMatch(/slug\.en/);
  });

  it("unwraps pg errors nested 3 levels deep in .cause (42501 → rls_denied)", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      doThing: mutationProcedure.mutation(() => {
        // Wrapper (level 0) → DrizzleLike (level 1) → Postgres-like (level 2)
        const inner: Error & { code?: string } = Object.assign(
          new Error("row-level security violation"),
          { code: "42501" },
        );
        const middle: Error & { cause?: unknown } = Object.assign(
          new Error("drizzle failed query"),
          { cause: inner },
        );
        const outer: Error & { cause?: unknown } = Object.assign(
          new Error("outer wrap"),
          { cause: middle },
        );
        throw outer;
      }),
    });
    await expect(r.createCaller(ctx).doThing()).rejects.toThrow();
    const rows = await readAuditRows(tenantId);
    expect(lastRow(rows).error).toBe(JSON.stringify({ code: "rls_denied" }));
  });

  it("maps pg SQLSTATE 40001 (serialization failure) to serialization_failure", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      doThing: mutationProcedure.mutation(() => {
        const err = new Error("could not serialize");
        (err as unknown as { code: string }).code = "40001";
        throw err;
      }),
    });
    await expect(r.createCaller(ctx).doThing()).rejects.toThrow();
    const rows = await readAuditRows(tenantId);
    expect(lastRow(rows).error).toBe(JSON.stringify({ code: "serialization_failure" }));
  });

  it("oversize raw input (>64KB serialized) is replaced with an __oversized marker before hashing", async () => {
    const { router } = await import("@/server/trpc/init");
    const { mutationProcedure } = await import("@/server/trpc/middleware/audit-wrap");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    // Huge string — ~100KB. The procedure accepts z.string() but the audit
    // path must cap *before* hashing.
    const big = "a".repeat(100 * 1024);

    const r = router({
      doThing: mutationProcedure
        .input(z.object({ blob: z.string() }))
        .mutation(() => ({ ok: true })),
    });
    await r.createCaller(ctx).doThing({ blob: big });

    const payloadRows = await db.execute<{ payload: unknown }>(
      sql`SELECT payload FROM audit_payloads WHERE tenant_id = ${tenantId}::uuid AND kind='input'`,
    );
    const payloadArr = Array.isArray(payloadRows)
      ? payloadRows
      : (payloadRows as { rows?: Array<{ payload: unknown }> }).rows ?? [];
    expect(payloadArr.length).toBe(1);
    const payload = payloadArr[0]?.payload as { __oversized?: boolean; approx_bytes?: number };
    expect(payload?.__oversized).toBe(true);
    expect(typeof payload?.approx_bytes).toBe("number");
    expect(JSON.stringify(payload)).not.toContain("aaaaa"); // no raw body leakage
  });
});

describe("requireSession / requireMembership middlewares", () => {
  it("requireSession rejects anonymous with UNAUTHORIZED", async () => {
    const { router } = await import("@/server/trpc/init");
    const { sessionProcedure } = await import("@/server/trpc/middleware/require-session");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const r = router({
      whoami: sessionProcedure.query(() => ({ ok: true })),
    });
    await expect(r.createCaller(ctx).whoami()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("requireSession passes session identity through", async () => {
    const { router } = await import("@/server/trpc/init");
    const { sessionProcedure } = await import("@/server/trpc/middleware/require-session");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
    });

    const r = router({
      whoami: sessionProcedure.query(({ ctx }) => ({
        type: ctx.identity.type,
        userId: ctx.identity.userId,
      })),
    });
    const out = await r.createCaller(ctx).whoami();
    expect(out.type).toBe("session");
    expect(out.userId).toBe((ctx.identity as { userId: string }).userId);
  });

  it("requireMembership rejects a customer (session + null membership) with FORBIDDEN", async () => {
    const { router } = await import("@/server/trpc/init");
    const { requireMembership } = await import("@/server/trpc/middleware/require-membership");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
      // no membershipRole → null membership in ctx
    });

    const { publicProcedure } = await import("@/server/trpc/init");
    const adminOnly = publicProcedure.use(requireMembership(["owner", "staff"]));
    const r = router({ adminOp: adminOnly.query(() => ({ ok: true })) });
    await expect(r.createCaller(ctx).adminOp()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requireMembership(['owner','staff']) rejects a support-role membership", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireMembership } = await import("@/server/trpc/middleware/require-membership");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
      membershipRole: "support",
    });
    const adminOnly = publicProcedure.use(requireMembership(["owner", "staff"]));
    const r = router({ adminOp: adminOnly.query(() => ({ ok: true })) });
    await expect(r.createCaller(ctx).adminOp()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requireMembership(['owner','staff']) passes for an owner", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireMembership } = await import("@/server/trpc/middleware/require-membership");
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
      membershipRole: "owner",
    });
    const adminOnly = publicProcedure.use(requireMembership(["owner", "staff"]));
    const r = router({
      adminOp: adminOnly.query(({ ctx }) => ({ role: ctx.membership.role })),
    });
    const out = await r.createCaller(ctx).adminOp();
    expect(out.role).toBe("owner");
  });
});
