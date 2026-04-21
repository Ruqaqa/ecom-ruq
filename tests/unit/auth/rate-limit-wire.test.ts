/**
 * Block 5b — BA rate-limit wire-up hook.
 *
 * The `enforceAuthRateLimit` helper is what BA's `hooks.before` calls for
 * every auth endpoint. It owns:
 *   - per-endpoint policy lookup (AUTH_LIMITS)
 *   - per-tenant bucket key construction
 *   - two-tier per-IP + per-identity check
 *   - fail-closed on Redis outage (SERVICE_UNAVAILABLE, NEVER allow)
 *   - audit row on reject (`auth.rate-limit-exceeded`, errorCode: 'rate_limited')
 *
 * Tests run against real Redis (same pattern as rate-limit.test.ts) and
 * real Postgres (same pattern as audit-wrap.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import Redis from "ioredis";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { __setRedisForTests } from "@/server/auth/rate-limit";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
});

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client, { schema });

beforeAll(() => {
  __setRedisForTests(redis);
});

afterAll(async () => {
  __setRedisForTests(null);
  await redis.quit();
  await client.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTenant(): Promise<{ id: string; host: string }> {
  const id = randomUUID();
  const slug = `rl-wire-test-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return { id, host };
}

function headersWithIp(ip: string | undefined, extras: Record<string, string> = {}): Headers {
  const h = new Headers(extras);
  // Post-High-02: extractIp reads ONLY `x-real-ip`. The reverse proxy
  // (Traefik under Coolify) sets this; XFF is ignored entirely because
  // its first entry is attacker-controlled under Traefik's append-mode.
  if (ip) h.set("x-real-ip", ip);
  return h;
}

async function readLastAuditOp(tenantId: string): Promise<{ operation: string; error: string | null } | null> {
  const rows = await db.execute<{ operation: string; error: string | null }>(
    sql`SELECT operation, error FROM audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at DESC LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ operation: string; error: string | null }> }).rows ?? [];
  return arr[0] ?? null;
}

describe("enforceAuthRateLimit", () => {
  it("per-tenant isolation: tenant A hitting the IP limit does NOT affect tenant B on the same IP+path", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const tA = await makeTenant();
    const tB = await makeTenant();
    const ip = "9.9.9.9";
    // Use /reset-password — ip-only policy (no email tier), limit 5/min
    // post-Low-06 tightening. Saturating this keeps the test focused on
    // per-IP isolation.
    const body = {};

    for (let i = 0; i < 5; i++) {
      const r = await enforceAuthRateLimit({
        path: "/reset-password",
        tenantId: tA.id,
        headers: headersWithIp(ip),
        body,
      });
      expect(r.allowed).toBe(true);
    }
    const aBlocked = await enforceAuthRateLimit({
      path: "/reset-password",
      tenantId: tA.id,
      headers: headersWithIp(ip),
      body,
    });
    expect(aBlocked.allowed).toBe(false);
    expect(aBlocked.reason).toBe("ip");

    // Tenant B should NOT be affected — bucket key is scoped by tenantId.
    const bAllowed = await enforceAuthRateLimit({
      path: "/reset-password",
      tenantId: tB.id,
      headers: headersWithIp(ip),
      body,
    });
    expect(bAllowed.allowed).toBe(true);
  });

  it("IP+identity: either tier triggers rejection independently", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();
    const body = { email: "spray@example.test" };

    // Rotate IPs so per-IP bucket stays under its 20/min limit, but same
    // email exhausts the per-email 5/min bucket for /sign-in/email.
    for (let i = 0; i < 5; i++) {
      const r = await enforceAuthRateLimit({
        path: "/sign-in/email",
        tenantId: t.id,
        headers: headersWithIp(`10.0.0.${i + 1}`),
        body,
      });
      expect(r.allowed).toBe(true);
    }
    const idBlocked = await enforceAuthRateLimit({
      path: "/sign-in/email",
      tenantId: t.id,
      headers: headersWithIp("10.0.0.99"),
      body,
    });
    expect(idBlocked.allowed).toBe(false);
    expect(idBlocked.reason).toBe("email");
  });

  it("fail-closed: Redis outage → throws SERVICE_UNAVAILABLE-shaped error, NEVER silently allows", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const rlMod = await import("@/server/auth/rate-limit");
    const t = await makeTenant();

    // Force checkRateLimit to throw (simulate Redis pipeline null).
    const spy = vi
      .spyOn(rlMod, "checkRateLimit")
      .mockImplementation(async () => {
        throw new Error("rate limit pipeline returned null");
      });

    await expect(
      enforceAuthRateLimit({
        path: "/sign-in/email",
        tenantId: t.id,
        headers: headersWithIp("1.1.1.1"),
        body: { email: "x@x.test" },
      }),
    ).rejects.toMatchObject({ statusCode: 503, body: { code: "RATE_LIMITER_UNAVAILABLE" } });

    spy.mockRestore();
  });

  it("audits rate-limit rejections as `auth.rate-limit-exceeded` with errorCode 'rate_limited'", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();
    const ip = "8.8.8.8";
    const body = { email: "audit-check@example.test" };

    // Saturate the /forget-password bucket (ipLimit 10/5min, idLimit 3/hour).
    // Reach the id limit first (3) — per-email forget-password is tight by design.
    for (let i = 0; i < 3; i++) {
      await enforceAuthRateLimit({
        path: "/forget-password",
        tenantId: t.id,
        headers: headersWithIp(ip),
        body,
      });
    }
    const rejected = await enforceAuthRateLimit({
      path: "/forget-password",
      tenantId: t.id,
      headers: headersWithIp(ip),
      body,
    });
    expect(rejected.allowed).toBe(false);

    // Audit assertions: last audit row for this tenant is auth.rate-limit-exceeded
    // with the closed-set rate_limited code.
    // Allow for the async audit-write to settle.
    await new Promise((res) => setTimeout(res, 50));
    const row = await readLastAuditOp(t.id);
    expect(row?.operation).toBe("auth.rate-limit-exceeded");
    expect(row?.error).toBe(JSON.stringify({ code: "rate_limited" }));
  });

  it("dev fallback: `unknown-ip` in NODE_ENV!=='production' skips the per-IP tier (prevents pnpm-dev collapse)", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();

    // No x-real-ip → extractIp returns 'unknown-ip'. /reset-password is
    // ip-only (no identity tier). Under prod rules we'd block on the
    // 6th hit (post-Low-06 5/min cap). Under dev-bypass we allow all 20.
    const headers = new Headers();
    const body = {};
    for (let i = 0; i < 20; i++) {
      const r = await enforceAuthRateLimit({
        path: "/reset-password",
        tenantId: t.id,
        headers,
        body,
      });
      expect(r.allowed).toBe(true);
    }
  });

  it("dev fallback: the per-identity tier STILL applies under unknown-ip so credential-stuffing tests remain useful", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();

    // No xff → unknown-ip. /forget-password has identity tier 3/hour.
    // The per-IP tier is skipped under dev, but per-email still triggers.
    const headers = new Headers();
    const body = { email: "dev-bypass-identity@example.test" };
    for (let i = 0; i < 3; i++) {
      const r = await enforceAuthRateLimit({
        path: "/forget-password",
        tenantId: t.id,
        headers,
        body,
      });
      expect(r.allowed).toBe(true);
    }
    const rejected = await enforceAuthRateLimit({
      path: "/forget-password",
      tenantId: t.id,
      headers,
      body,
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe("email");
  });

  it("E2E bypass honors x-dev-only-enforce-rate-limit opt-out header (only when APP_ENV=e2e)", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();

    const prevApp = process.env.APP_ENV;
    const prevFlag = process.env.E2E_AUTH_RATE_LIMIT_DISABLED;
    process.env.APP_ENV = "e2e";
    process.env.E2E_AUTH_RATE_LIMIT_DISABLED = "1";
    try {
      // Without the opt-out header: bypass ON, every call passes.
      const bypassed = await enforceAuthRateLimit({
        path: "/forget-password",
        tenantId: t.id,
        headers: headersWithIp("5.5.5.5"),
        body: { email: "bypass@example.test" },
      });
      expect(bypassed.allowed).toBe(true);

      // With the opt-out header: bypass OFF. /forget-password idLimit
      // is 3/hour — trigger and confirm the 4th call rejects.
      const hdrs = headersWithIp("5.5.5.5");
      hdrs.set("x-dev-only-enforce-rate-limit", "1");
      const body = { email: "opt-out-canary@example.test" };
      for (let i = 0; i < 3; i++) {
        const r = await enforceAuthRateLimit({
          path: "/forget-password",
          tenantId: t.id,
          headers: hdrs,
          body,
        });
        expect(r.allowed).toBe(true);
      }
      const rejected = await enforceAuthRateLimit({
        path: "/forget-password",
        tenantId: t.id,
        headers: hdrs,
        body,
      });
      expect(rejected.allowed).toBe(false);
    } finally {
      if (prevApp === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = prevApp;
      if (prevFlag === undefined) delete process.env.E2E_AUTH_RATE_LIMIT_DISABLED;
      else process.env.E2E_AUTH_RATE_LIMIT_DISABLED = prevFlag;
    }
  });

  it("extractIp reads x-real-ip, returns 'unknown-ip' when absent", async () => {
    const { extractIp } = await import("@/server/auth/rate-limit-auth-hook");
    expect(extractIp(new Headers({ "x-real-ip": "10.0.0.5" }))).toBe("10.0.0.5");
    expect(extractIp(new Headers())).toBe("unknown-ip");
    // Whitespace-only value treated as absent.
    expect(extractIp(new Headers({ "x-real-ip": "  " }))).toBe("unknown-ip");
  });

  it("High-02 adversarial: x-forwarded-for alone is IGNORED (attacker cannot inject client IP)", async () => {
    const { extractIp } = await import("@/server/auth/rate-limit-auth-hook");
    // An attacker submits XFF directly. Traefik's default is append-mode,
    // so the first entry is the attacker-chosen value. Reading XFF would
    // let the attacker rotate IPs and bypass the per-IP tier.
    const h = new Headers({
      "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12",
    });
    expect(extractIp(h)).toBe("unknown-ip");
  });

  it("High-02 adversarial: when x-real-ip AND x-forwarded-for are both present, x-forwarded-for is ignored", async () => {
    const { extractIp } = await import("@/server/auth/rate-limit-auth-hook");
    const h = new Headers({
      "x-real-ip": "10.0.0.5",
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });
    expect(extractIp(h)).toBe("10.0.0.5");
  });
});

describe("normalizeEmailForBucket — Medium-02 anti-hop invariant", () => {
  it("collapses plus-aliases to a single canonical local-part", async () => {
    const { normalizeEmailForBucket } = await import("@/server/auth/rate-limit-auth-hook");
    expect(normalizeEmailForBucket("alice+1@gmail.com")).toBe("alice@gmail.com");
    expect(normalizeEmailForBucket("alice+2@gmail.com")).toBe("alice@gmail.com");
    expect(normalizeEmailForBucket("alice@gmail.com")).toBe("alice@gmail.com");
  });

  it("lower-cases the entire email (ASCII and Unicode domains)", async () => {
    const { normalizeEmailForBucket } = await import("@/server/auth/rate-limit-auth-hook");
    expect(normalizeEmailForBucket("ALICE@Example.COM")).toBe("alice@example.com");
  });

  it("NFKC-normalizes Unicode — preserves semantic distinction between Latin 'i' and dotless 'ı'", async () => {
    const { normalizeEmailForBucket } = await import("@/server/auth/rate-limit-auth-hook");
    // 'alice' (Latin i) vs 'alıce' (Turkish dotless i) — NFKC doesn't map
    // these together, so they end up in distinct buckets. Locking the
    // boundary: plus-alias merges; Unicode-homoglyphs stay separate.
    const latin = normalizeEmailForBucket("alice@example.com");
    const dotless = normalizeEmailForBucket("al\u0131ce@example.com");
    expect(latin).toBe("alice@example.com");
    expect(dotless).not.toBe(latin);
  });

  it("returns null on malformed input so the caller skips the per-email tier cleanly", async () => {
    const { normalizeEmailForBucket } = await import("@/server/auth/rate-limit-auth-hook");
    expect(normalizeEmailForBucket("not-an-email")).toBeNull();
    expect(normalizeEmailForBucket("")).toBeNull();
    expect(normalizeEmailForBucket("a@b")).toBeNull(); // no TLD dot
  });

  it("integration: plus-aliases SHARE the per-email bucket end-to-end", async () => {
    const { enforceAuthRateLimit } = await import("@/server/auth/rate-limit-auth-hook");
    const t = await makeTenant();
    // /forget-password is identity=email, idLimit 3/hour. Three distinct
    // plus-aliases all collapse to `alice@gmail.com`; the 4th call from
    // any alias should reject with reason='email'.
    const base = "alice@gmail.com";
    for (const suffix of ["", "+1", "+2"]) {
      const local = base.split("@")[0];
      const r = await enforceAuthRateLimit({
        path: "/forget-password",
        tenantId: t.id,
        headers: headersWithIp(`10.1.0.${suffix ? suffix.slice(1) : "0"}`),
        body: { email: `${local}${suffix}@gmail.com` },
      });
      expect(r.allowed).toBe(true);
    }
    const rejected = await enforceAuthRateLimit({
      path: "/forget-password",
      tenantId: t.id,
      headers: headersWithIp("10.1.0.99"),
      body: { email: "alice+99@gmail.com" },
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe("email");
  });
});
