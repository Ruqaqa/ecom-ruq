/**
 * `src/server/audit/write.ts` — the transport-agnostic audit writer extracted
 * from the TEMPORARY the auth-audit shim.
 *
 * Contract (block 2a):
 *   - `insertAuditInTx(tx, row)` — writes one audit_log row (and optional
 *     audit_payloads rows) inside the caller's transaction. Acquires the
 *     per-tenant advisory lock, reads the chain head, computes row_hash,
 *     inserts. Identical chain semantics to today's helper; just relocated.
 *   - `writeAuditInOwnTx(row)` — opens its own `withTenant` tx and delegates
 *     to `insertAuditInTx`. Best-effort: swallows thrown tx errors and logs
 *     via the Sentry shim. NO retry loop (security requirement).
 *   - `audit_log.error` is NEVER a raw error string. When `errorCode` is set,
 *     the column receives the string `JSON.stringify({ code })`. Zod/pg error
 *     messages (which can embed PII like emails) must never land in the
 *     append-only, PDPL-un-deletable chain column.
 *
 * These tests run against a real Postgres (the same pattern as
 * tests/unit/db/with-tenant.test.ts — superuser, RLS bypassed; this test is
 * about writer semantics, not RLS enforcement).
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
const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a throwaway tenant row and return its id. Audit writes require a
 * valid FK into `tenants`; nightly-cleanup is not this test's job, so we
 * create per-test tenants with unique slugs.
 */
async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `audit-write-test-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function countAuditRows(tenantId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM audit_log WHERE tenant_id = ${tenantId}::uuid`,
  );
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: Array<{ n: string }> }).rows ?? [];
  return Number(arr[0]?.n ?? "0");
}

async function readErrorColumn(tenantId: string): Promise<string | null> {
  const rows = await db.execute<{ error: string | null }>(
    sql`SELECT error FROM audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at DESC LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ error: string | null }> }).rows ?? [];
  return arr[0]?.error ?? null;
}

describe("audit/write", () => {
  it("insertAuditInTx writes an audit_log row with outcome=success inside the caller tx", async () => {
    const { insertAuditInTx } = await import("@/server/audit/write");
    const { withTenant } = await import("@/server/db");
    const { buildAuthedTenantContext } = await import("@/server/tenant/context");

    const tenantId = await makeTenant();
    const ctx = buildAuthedTenantContext(
      { id: tenantId },
      { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
    );

    await withTenant(db, ctx, async (tx) => {
      await insertAuditInTx(tx, {
        tenantId,
        operation: "test.op",
        actorType: "anonymous",
        actorId: null,
        tokenId: null,
        outcome: "success",
      });
    });

    expect(await countAuditRows(tenantId)).toBe(1);
    // error column is null when errorCode was not passed
    expect(await readErrorColumn(tenantId)).toBeNull();
  });

  it("writeAuditInOwnTx commits a row without a surrounding tx", async () => {
    const { writeAuditInOwnTx } = await import("@/server/audit/write");
    const tenantId = await makeTenant();

    await writeAuditInOwnTx({
      tenantId,
      operation: "test.op-own-tx",
      actorType: "user",
      actorId: "user_owntx",
      tokenId: null,
      outcome: "success",
    });

    expect(await countAuditRows(tenantId)).toBe(1);
  });

  it("writeAuditInOwnTx swallows thrown tx errors and logs via the Sentry shim (best-effort)", async () => {
    const { writeAuditInOwnTx } = await import("@/server/audit/write");
    const sentry = await import("@/server/obs/sentry");
    const captureSpy = vi.fn();
    sentry.__setSentryForTests({ captureMessage: captureSpy });

    try {
      // Invalid tenantId — not a uuid, will fail inside withTenant's set_config
      // or the FK constraint. Either way: writeAuditInOwnTx must swallow.
      await expect(
        writeAuditInOwnTx({
          tenantId: "not-a-uuid",
          operation: "test.op-fail",
          actorType: "anonymous",
          actorId: null,
          tokenId: null,
          outcome: "failure",
          errorCode: "internal_error",
        }),
      ).resolves.toBeUndefined();

      expect(captureSpy).toHaveBeenCalledOnce();
      const firstCall = captureSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [name, options] = firstCall as [string, { tags?: { operation?: string } } | undefined];
      expect(name).toBe("audit_write_failure");
      expect(options?.tags?.operation).toBe("test.op-fail");
    } finally {
      sentry.__setSentryForTests(null);
    }
  });

  it("error column receives ONLY JSON-serialized { code }, never raw error text", async () => {
    const { writeAuditInOwnTx } = await import("@/server/audit/write");
    const tenantId = await makeTenant();

    await writeAuditInOwnTx({
      tenantId,
      operation: "test.op-fail",
      actorType: "user",
      actorId: "user_err",
      tokenId: null,
      outcome: "failure",
      errorCode: "forbidden",
    });

    const errorCell = await readErrorColumn(tenantId);
    expect(errorCell).toBe(JSON.stringify({ code: "forbidden" }));
  });
});
