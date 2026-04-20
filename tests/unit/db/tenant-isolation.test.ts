/**
 * RLS canary. Proves:
 *   - A tx with `SET LOCAL app.tenant_id = '<A>'` sees only tenant A's rows.
 *   - A tx with `SET LOCAL app.tenant_id = '<B>'` sees only tenant B's rows.
 *   - A tx with NO `SET LOCAL` sees zero rows and insert fails.
 *   - Writing a row with the wrong tenant_id under an A-scoped tx is blocked
 *     by the WITH CHECK clause.
 *
 * Must run as `app_user` against a migrated DB (DATABASE_URL_APP_USER, which
 * for dev is the same server but with the app_user role active via SET ROLE).
 * We SET ROLE inside the test harness to target policies instead of bypassing
 * them as the superuser.
 *
 * TODO(chunk 8): this file will move/expand under the full Vitest integration
 * harness (separate project, per-test tx rollback, parallelism via tenant
 * suffixes). For chunk 4 it just needs to run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const tenantA = randomUUID();
const tenantB = randomUUID();
const nameA = { en: "Tenant A", ar: "المستأجر أ" };
const nameB = { en: "Tenant B", ar: "المستأجر ب" };

const sql = postgres(DATABASE_URL, { max: 3 });

beforeAll(async () => {
  await sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name)
    VALUES
      (${tenantA}, ${`rls-a-${tenantA.slice(0, 8)}`}, ${`a-${tenantA.slice(0, 8)}.test.local`}, 'en', 'active', ${sql.json(nameA)}),
      (${tenantB}, ${`rls-b-${tenantB.slice(0, 8)}`}, ${`b-${tenantB.slice(0, 8)}.test.local`}, 'ar', 'active', ${sql.json(nameB)})
  `;
  await sql`
    INSERT INTO products (tenant_id, slug, name, status)
    VALUES
      (${tenantA}, ${sql.json({ en: "prod-a", ar: "prod-a" })}, ${sql.json({ en: "A Product", ar: "منتج أ" })}, 'draft'),
      (${tenantB}, ${sql.json({ en: "prod-b", ar: "prod-b" })}, ${sql.json({ en: "B Product", ar: "منتج ب" })}, 'draft')
  `;
});

afterAll(async () => {
  // Cleanup. audit_log is append-only via triggers even for the superuser;
  // disable triggers locally for this teardown only. This does NOT change
  // production behavior — only `postgres` (the test harness) has the
  // privilege to disable triggers.
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE audit_log DISABLE TRIGGER ALL`;
    try {
      await tx`DELETE FROM audit_log WHERE tenant_id IN (${tenantA}, ${tenantB})`;
      await tx`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
    } finally {
      await tx`ALTER TABLE audit_log ENABLE TRIGGER ALL`;
    }
  });
  await sql.end({ timeout: 5 });
});

async function asAppUser<T>(fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    return fn(tx);
  });
  return result as T;
}

describe("RLS tenant isolation", () => {
  it("tenant A sees only its own products", async () => {
    const rows = await asAppUser(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx<Array<{ tenant_id: string }>>`SELECT tenant_id FROM products`;
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).toBe(tenantA);
  });

  it("tenant B sees only its own products", async () => {
    const rows = await asAppUser(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx<Array<{ tenant_id: string }>>`SELECT tenant_id FROM products`;
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).toBe(tenantB);
  });

  it("a session without SET LOCAL sees zero rows and cannot insert", async () => {
    const rows = await asAppUser(async (tx) => {
      return tx<Array<{ tenant_id: string }>>`SELECT tenant_id FROM products`;
    });
    expect(rows.length).toBe(0);

    await expect(
      asAppUser(async (tx) => {
        await tx`
          INSERT INTO products (tenant_id, slug, name, status)
          VALUES (${tenantA}, ${sql.json({ en: "x", ar: "x" })}, ${sql.json({ en: "X", ar: "X" })}, 'draft')
        `;
      }),
    ).rejects.toThrow();
  });

  it("tenant A cannot insert a row tagged for tenant B (WITH CHECK)", async () => {
    await expect(
      asAppUser(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`
          INSERT INTO products (tenant_id, slug, name, status)
          VALUES (${tenantB}, ${sql.json({ en: "leak", ar: "leak" })}, ${sql.json({ en: "Leak", ar: "Leak" })}, 'draft')
        `;
      }),
    ).rejects.toThrow();
  });

  it("tenant A cannot UPDATE or DELETE audit_log rows (append-only)", async () => {
    const seedHash = Buffer.alloc(32, 0xaa);
    await asAppUser(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      // prev_log_hash left NULL — first audit row for this tenant in this test run.
      // (Other tests in this file may have written earlier rows, causing this to
      // fail with a chain-mismatch. That's acceptable — the chain verifier is
      // doing its job. The test-order isolation belongs to a later harness.)
      await tx`
        INSERT INTO audit_log (tenant_id, correlation_id, operation, outcome, actor_type, prev_log_hash, row_hash)
        VALUES (${tenantA}, ${randomUUID()}, 'test.write', 'success', 'system', NULL, ${seedHash})
      `.catch(() => {
        /* best-effort seed — test order may have written prior rows */
      });
    });

    await expect(
      asAppUser(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`UPDATE audit_log SET operation = 'tampered' WHERE tenant_id = ${tenantA}`;
      }),
    ).rejects.toThrow(/append-only|permission denied|42501/);

    await expect(
      asAppUser(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`DELETE FROM audit_log WHERE tenant_id = ${tenantA}`;
      }),
    ).rejects.toThrow(/append-only|permission denied|42501/);
  });

  it("audit_log trigger rejects mismatched prev_log_hash", async () => {
    // First, read the current chain head for tenant A (may be null if no prior
    // rows exist from earlier tests, or some hash if there are).
    const headRow = await sql<Array<{ row_hash: Buffer | null }>>`
      SELECT row_hash FROM audit_log WHERE tenant_id = ${tenantA}
      ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    const currentHead: Buffer | null = headRow[0]?.row_hash ?? null;

    // Correct insert: pass the actual current head as prev_log_hash, 32-byte row_hash.
    const goodHash = Buffer.alloc(32, 0x11);
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await tx`
        INSERT INTO audit_log (tenant_id, correlation_id, operation, outcome, actor_type, prev_log_hash, row_hash)
        VALUES (${tenantA}, ${randomUUID()}, 'chain.ok', 'success', 'system', ${currentHead}, ${goodHash})
      `;
    });

    // Wrong insert: pass a prev_log_hash that does NOT match the current head
    // (we just wrote goodHash as the head; passing NULL disagrees).
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE app_user`;
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`
          INSERT INTO audit_log (tenant_id, correlation_id, operation, outcome, actor_type, prev_log_hash, row_hash)
          VALUES (${tenantA}, ${randomUUID()}, 'chain.mismatch', 'failure', 'system', NULL, ${Buffer.alloc(32, 0x22)})
        `;
      }),
    ).rejects.toThrow(/chain race/);

    // Trigger also rejects wrong-length row_hash.
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE app_user`;
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`
          INSERT INTO audit_log (tenant_id, correlation_id, operation, outcome, actor_type, prev_log_hash, row_hash)
          VALUES (${tenantA}, ${randomUUID()}, 'chain.badlen', 'failure', 'system', ${goodHash}, ${Buffer.from("short")})
        `;
      }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it("pdpl_scrub_audit_payloads is a stub that raises not-yet-implemented", async () => {
    await expect(
      asAppUser(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`SELECT pdpl_scrub_audit_payloads(ARRAY[${randomUUID()}]::uuid[], ${randomUUID()})`;
      }),
    ).rejects.toThrow(/not yet implemented/);
  });

  it("app_user cannot DELETE from audit_payloads directly", async () => {
    await expect(
      asAppUser(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`DELETE FROM audit_payloads WHERE tenant_id = ${tenantA}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
