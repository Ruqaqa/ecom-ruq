/**
 * `requireRole(opts)` middleware — sub-chunk 7.6.2.
 *
 * Reads role exclusively through `deriveRole(ctx)` (closes the
 * `requireMembership` blind spot where a bearer caller's pre-demotion
 * `membership.role` was read instead of the post-min-merge
 * `identity.effectiveRole`). Optional `identity: 'session' | 'any'`
 * constraint enforces that certain mutations (`tokens.*`) require
 * a browser session and reject bearer callers.
 *
 * Failure messages are load-bearing RAW STRING LITERALS at the throw
 * sites in require-role.ts (not constants, not interpolated, not
 * translated). Forensic audit replay relies on byte-exact matching.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `req-role-test-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

interface BuildCtxOpts {
  tenantId: string;
  identityType: "anonymous" | "session" | "bearer";
  userId?: string;
  tokenId?: string;
  membershipRole?: "owner" | "staff" | "support";
  /** For bearer identities: the post-min-merge `effectiveRole` (S-5). */
  effectiveRole?: "owner" | "staff" | "support";
}

async function buildCtx(opts: BuildCtxOpts) {
  const {
    resolveTenant,
    __setTenantLookupLoaderForTests,
    clearTenantCacheForTests,
  } = await import("@/server/tenant");
  const host = `${opts.tenantId.slice(0, 8)}.local`;
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(async () => ({
    id: opts.tenantId,
    slug: "t",
    primaryDomain: host,
    defaultLocale: "en",
    senderEmail: "no-reply@" + host,
    name: { en: "T", ar: "ت" },
  }));
  const tenant = await resolveTenant(host);
  if (!tenant) throw new Error("fixture: resolveTenant returned null");

  const identity =
    opts.identityType === "anonymous"
      ? { type: "anonymous" as const }
      : opts.identityType === "session"
        ? {
            type: "session" as const,
            userId: opts.userId!,
            sessionId: "s_" + opts.userId,
          }
        : {
            type: "bearer" as const,
            userId: opts.userId!,
            tokenId: opts.tokenId!,
            effectiveRole:
              opts.effectiveRole ?? opts.membershipRole ?? ("owner" as const),
          };

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

describe("requireRole middleware", () => {
  it("case 1: anonymous caller → UNAUTHORIZED 'authentication required'", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({ tenantId, identityType: "anonymous" });

    const gated = publicProcedure.use(requireRole({ roles: ["owner"] }));
    const r = router({ op: gated.query(() => ({ ok: true })) });

    await expect(r.createCaller(ctx).op()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "authentication required",
    });
  });

  it("case 2: session + customer (no membership) + identity:any → FORBIDDEN 'insufficient role'", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
    });

    const gated = publicProcedure.use(
      requireRole({ roles: ["owner", "staff"] }),
    );
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const err = await r
      .createCaller(ctx)
      .op()
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("FORBIDDEN");
    expect((err as { message: string }).message).toBe("insufficient role");
  });

  it("case 3: session + customer (no membership) + identity:session → FORBIDDEN 'insufficient role'", async () => {
    // Not 'session required' — the caller IS session, they just have no
    // admin role. The identity constraint passes; the role gate fires.
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
    });

    const gated = publicProcedure.use(
      requireRole({ roles: ["owner"], identity: "session" }),
    );
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const err = await r
      .createCaller(ctx)
      .op()
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("FORBIDDEN");
    expect((err as { message: string }).message).toBe("insufficient role");
  });

  it("case 4: session + owner + roles:['owner'] → passes; ctx.membership narrowed non-null", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
      membershipRole: "owner",
    });

    const gated = publicProcedure.use(requireRole({ roles: ["owner"] }));
    const r = router({
      op: gated.query(({ ctx }) => ({
        // Access without null-check — this is the narrowing smoke: if
        // the pipe didn't narrow, TS would fail compile and runtime
        // would throw on `null.role` read.
        role: ctx.membership.role,
      })),
    });

    const out = await r.createCaller(ctx).op();
    expect(out.role).toBe("owner");
  });

  it("case 5: session + staff + roles:['owner'] → FORBIDDEN 'insufficient role' (byte-exact)", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId: randomUUID(),
      membershipRole: "staff",
    });

    const gated = publicProcedure.use(requireRole({ roles: ["owner"] }));
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const err = await r
      .createCaller(ctx)
      .op()
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("FORBIDDEN");
    // Byte-exact equality — forensic audit replay depends on the literal.
    expect((err as { message: string }).message).toBe("insufficient role");
  });

  it("case 6: bearer + effectiveRole:'owner' + identity:'any' → passes", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "bearer",
      userId: randomUUID(),
      tokenId: "t_" + randomUUID(),
      membershipRole: "owner",
      effectiveRole: "owner",
    });

    const gated = publicProcedure.use(
      requireRole({ roles: ["owner"], identity: "any" }),
    );
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const out = await r.createCaller(ctx).op();
    expect(out).toEqual({ ok: true });
  });

  it("case 7: bearer + effectiveRole:'owner' + identity:'session' → FORBIDDEN 'session required for this action' (byte-exact)", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const ctx = await buildCtx({
      tenantId,
      identityType: "bearer",
      userId: randomUUID(),
      tokenId: "t_" + randomUUID(),
      membershipRole: "owner",
      effectiveRole: "owner",
    });

    const gated = publicProcedure.use(
      requireRole({ roles: ["owner"], identity: "session" }),
    );
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const err = await r
      .createCaller(ctx)
      .op()
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("FORBIDDEN");
    // Byte-exact — security grep-checks this literal at the throw site.
    expect((err as { message: string }).message).toBe(
      "session required for this action",
    );
  });

  it("case 8: S-5 regression — bearer demoted to staff via effectiveRole, pre-demotion membership.role='owner' → FORBIDDEN 'insufficient role'", async () => {
    // The bug `requireMembership` missed: a PAT minted as owner for a
    // user who has since been demoted to staff. `membership.role` is
    // the pre-demotion cached value ("owner"); `effectiveRole` is
    // post-min-merge ("staff"). deriveRole short-circuits on bearer and
    // returns "staff", so requireRole({ roles:["owner"] }) must FORBID.
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const userId = randomUUID();
    const ctx = await buildCtx({
      tenantId,
      identityType: "bearer",
      userId,
      tokenId: "t_" + userId,
      membershipRole: "owner", // DB row says owner (pre-demotion cache)
      effectiveRole: "staff", // post-min-merge truth
    });

    // Verbatim fixture-shape assertion — verifies the test fixture set up
    // the S-5 shape we actually mean to exercise. Security verbatim-greps
    // for the exact variable names `ownerMembership` and `effectiveRole`.
    const ownerMembership = ctx.membership!;
    const effectiveRole =
      ctx.identity.type === "bearer" ? ctx.identity.effectiveRole : null;
    expect(ownerMembership.role).toBe("owner");
    expect(effectiveRole).toBe("staff");

    const gated = publicProcedure.use(requireRole({ roles: ["owner"] }));
    const r = router({ op: gated.query(() => ({ ok: true })) });

    const err = await r
      .createCaller(ctx)
      .op()
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("FORBIDDEN");
    expect((err as { message: string }).message).toBe("insufficient role");
  });

  it("case 9: narrowing smoke — after requireRole with session caller, downstream sees non-null ctx.membership", async () => {
    const { router, publicProcedure } = await import("@/server/trpc/init");
    const { requireRole } = await import(
      "@/server/trpc/middleware/require-role"
    );
    const tenantId = await makeTenant();
    const userId = randomUUID();
    const ctx = await buildCtx({
      tenantId,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });

    const gated = publicProcedure.use(
      requireRole({ roles: ["owner", "staff"] }),
    );
    const r = router({
      op: gated.query(({ ctx }) => ({
        // No null-check — pipe-level narrowing makes this safe.
        role: ctx.membership.role,
        userId: ctx.membership.userId,
      })),
    });

    const out = await r.createCaller(ctx).op();
    expect(out.role).toBe("staff");
    expect(out.userId).toBe(userId);
  });
});
