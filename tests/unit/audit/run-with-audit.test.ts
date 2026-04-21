/**
 * `src/server/audit/run-with-audit.ts` — the transport-agnostic shared
 * audit orchestration core extracted during sub-chunk 7.3.
 *
 * Contract:
 *   - Opens `withTenant(db, authedCtx, fn)` EXACTLY ONCE per call.
 *   - Runs the caller's `work(tx)` thunk inside that tx.
 *   - On success: writes an outcome='success' audit row in the same tx
 *     via `insertAuditInTx` (rolled back atomically if the outer tx
 *     later throws).
 *   - On throw inside `work`: opens a second best-effort own-tx via
 *     `writeAuditInOwnTx` to record an outcome='failure' row with a
 *     closed-set `errorCode` from `onFailure(err)`. Re-throws the
 *     original error.
 *   - If the failure-audit write itself throws, fire Sentry
 *     `audit_write_failure` — Decision 1 (A): unified across
 *     transports (previously only tRPC had this belt-and-braces hook;
 *     MCP did not, so MCP gains equivalent observability).
 *   - Sentry capture fires ONLY on audit-write failure — never on the
 *     success path, never on a caller's normal throw.
 *   - `withTenant` is invoked exactly once per successful call (F-1
 *     regression invariant, preserved and now asserted here).
 *   - No double-write: a single outcome='success' row or a single
 *     outcome='failure' row per call, never both.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `run-with-audit-test-${id.slice(0, 8)}`;
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

async function buildAuthedCtx(tenantId: string) {
  const { buildAuthedTenantContext } = await import("@/server/tenant/context");
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("runWithAudit — shared transport-neutral audit orchestration", () => {
  it("writes exactly one outcome='success' row on the happy path", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const { appDb } = await import("@/server/db");
    const tenantId = await makeTenant();
    const authedCtx = await buildAuthedCtx(tenantId);
    const correlationId = randomUUID();

    const result = await runWithAudit({
      db: appDb!,
      authedCtx,
      tenantId,
      operation: "test.op",
      actor: { actorType: "anonymous", actorId: null, tokenId: null },
      correlationId,
      successInput: { x: 7 },
      onFailure: () => ({ errorCode: "internal_error", failureInput: undefined }),
      work: async () => ({ result: { ok: true }, after: { ok: true } }),
    });

    expect(result).toEqual({ ok: true });
    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("success");
    expect(rows[0]!.operation).toBe("test.op");
    expect(rows[0]!.correlation_id).toBe(correlationId);
    expect(rows[0]!.error).toBeNull();
  });

  it("writes exactly one outcome='failure' row and re-throws when work throws", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const { appDb } = await import("@/server/db");
    const tenantId = await makeTenant();
    const authedCtx = await buildAuthedCtx(tenantId);
    const correlationId = randomUUID();

    await expect(
      runWithAudit({
        db: appDb!,
        authedCtx,
        tenantId,
        operation: "test.op",
        actor: { actorType: "anonymous", actorId: null, tokenId: null },
        correlationId,
        successInput: { x: 7 },
        onFailure: () => ({
          errorCode: "validation_failed",
          failureInput: { kind: "validation", failedPaths: ["x"] },
        }),
        work: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[0]!.operation).toBe("test.op");
    expect(rows[0]!.correlation_id).toBe(correlationId);
    expect(rows[0]!.error).toBe(JSON.stringify({ code: "validation_failed" }));
  });

  it("invariant: withTenant is called exactly once per success call (F-1)", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const dbMod = await import("@/server/db");
    const tenantId = await makeTenant();
    const authedCtx = await buildAuthedCtx(tenantId);
    const correlationId = randomUUID();

    const spy = vi.spyOn(dbMod, "withTenant");
    try {
      await runWithAudit({
        db: dbMod.appDb!,
        authedCtx,
        tenantId,
        operation: "test.op",
        actor: { actorType: "anonymous", actorId: null, tokenId: null },
        correlationId,
        successInput: {},
        onFailure: () => ({ errorCode: "internal_error", failureInput: undefined }),
        work: async () => ({ result: "r", after: "a" }),
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("no-double-write: never emits both a success AND a failure row for one call", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const { appDb } = await import("@/server/db");
    const tenantId = await makeTenant();
    const authedCtx = await buildAuthedCtx(tenantId);

    // Fail inside the work thunk; verify only a single failure row exists.
    await expect(
      runWithAudit({
        db: appDb!,
        authedCtx,
        tenantId,
        operation: "test.op",
        actor: { actorType: "anonymous", actorId: null, tokenId: null },
        correlationId: randomUUID(),
        successInput: undefined,
        onFailure: () => ({ errorCode: "internal_error", failureInput: undefined }),
        work: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(tenantId);
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.outcome === "failure")).toBe(true);
  });

  it("fires Sentry audit_write_failure ONLY when the failure-audit write itself throws", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const { appDb } = await import("@/server/db");
    const sentry = await import("@/server/obs/sentry");
    const writeMod = await import("@/server/audit/write");

    const captureSpy = vi.fn();
    sentry.__setSentryForTests({ captureMessage: captureSpy });
    const spy = vi.spyOn(writeMod, "writeAuditInOwnTx").mockImplementation(async () => {
      throw new Error("db down");
    });

    try {
      const tenantId = await makeTenant();
      const authedCtx = await buildAuthedCtx(tenantId);

      await expect(
        runWithAudit({
          db: appDb!,
          authedCtx,
          tenantId,
          operation: "test.op",
          actor: { actorType: "anonymous", actorId: null, tokenId: null },
          correlationId: randomUUID(),
          successInput: undefined,
          onFailure: () => ({
            errorCode: "validation_failed",
            failureInput: undefined,
          }),
          work: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow();

      expect(captureSpy).toHaveBeenCalled();
      const call = captureSpy.mock.calls.find((c) => c[0] === "audit_write_failure");
      expect(call, "expected audit_write_failure capture").toBeTruthy();
      expect(call![1]?.tags?.operation).toBe("test.op");
      expect(call![1]?.tags?.code).toBe("validation_failed");
    } finally {
      spy.mockRestore();
      sentry.__setSentryForTests(null);
    }
  });

  it("does NOT fire Sentry audit_write_failure on the success path", async () => {
    const { runWithAudit } = await import("@/server/audit/run-with-audit");
    const { appDb } = await import("@/server/db");
    const sentry = await import("@/server/obs/sentry");

    const captureSpy = vi.fn();
    sentry.__setSentryForTests({ captureMessage: captureSpy });

    try {
      const tenantId = await makeTenant();
      const authedCtx = await buildAuthedCtx(tenantId);

      await runWithAudit({
        db: appDb!,
        authedCtx,
        tenantId,
        operation: "test.op",
        actor: { actorType: "anonymous", actorId: null, tokenId: null },
        correlationId: randomUUID(),
        successInput: undefined,
        onFailure: () => ({ errorCode: "internal_error", failureInput: undefined }),
        work: async () => ({ result: 1, after: 1 }),
      });

      expect(
        captureSpy.mock.calls.some((c) => c[0] === "audit_write_failure"),
      ).toBe(false);
    } finally {
      sentry.__setSentryForTests(null);
    }
  });
});
