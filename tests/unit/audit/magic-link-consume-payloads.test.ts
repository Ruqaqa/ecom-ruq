/**
 * Regression test for the magic-link audit-payload collision.
 *
 * `sessionCreateAfter` in src/server/auth/audit-hooks.ts writes TWO
 * audit rows on a magic-link verify — `auth.session.create` and
 * `auth.magic-link.consume` — that deliberately share a correlationId
 * so operators can join the two. Each row carries an `after` payload.
 *
 * With `audit_payloads` keyed on `(correlation_id, kind)` today, the
 * second `after` row collides with the first and the detail is lost
 * (`writeAuditInOwnTx` swallows the throw and logs audit_write_failure).
 * This test drives the same shape — two writes, same correlationId,
 * both with `after` payloads — and asserts that BOTH detail rows
 * persist. It is red until chunk 11's fix lands.
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
const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `ml-consume-audit-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function countPayloadRows(
  tenantId: string,
  correlationId: string,
  kind: "input" | "before" | "after",
): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM audit_payloads
        WHERE tenant_id = ${tenantId}::uuid
          AND correlation_id = ${correlationId}::uuid
          AND kind = ${kind}`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: Array<{ n: string }> }).rows ?? []);
  return Number(arr[0]?.n ?? "0");
}

async function countLogRows(tenantId: string, correlationId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid
          AND correlation_id = ${correlationId}::uuid`,
  );
  const arr = Array.isArray(rows) ? rows : ((rows as { rows?: Array<{ n: string }> }).rows ?? []);
  return Number(arr[0]?.n ?? "0");
}

describe("magic-link consume shared-correlationId audit detail rows", () => {
  it("both auth.session.create and auth.magic-link.consume after-payloads persist when sharing a correlationId", async () => {
    const { writeAuditInOwnTx } = await import("@/server/audit/write");
    const tenantId = await makeTenant();
    const correlationId = randomUUID();
    const userId = randomUUID();
    const sessionId = randomUUID();

    await writeAuditInOwnTx({
      tenantId,
      operation: "auth.session.create",
      actorType: "user",
      actorId: userId,
      tokenId: null,
      outcome: "success",
      correlationId,
      after: { userId, sessionId },
    });

    await writeAuditInOwnTx({
      tenantId,
      operation: "auth.magic-link.consume",
      actorType: "user",
      actorId: userId,
      tokenId: null,
      outcome: "success",
      correlationId,
      after: { userId, sessionId },
    });

    expect(await countLogRows(tenantId, correlationId)).toBe(2);
    expect(await countPayloadRows(tenantId, correlationId, "after")).toBe(2);
  });
});
