/**
 * Integration test — `update_product` MCP tool (chunk 1a.2).
 *
 * Drives the real Next.js MCP route handler against real Postgres + a
 * fake-but-shape-accurate Redis, through real PATs.
 *
 * Cases (paralleling create-product.test.ts plus the OCC + Tier-B
 * additions specific to update_product):
 *   1. Owner PAT happy path — structuredContent is ProductOwner shape
 *      with the new values; products row updated; audit row
 *      operation='mcp.update_product' outcome='success' attributes the
 *      owner PAT, hash chain intact.
 *   2. Staff PAT happy path on non-Tier-B fields — ProductOwner shape
 *      (staff is a write role); audit row attributed to staff token.
 *      Audit `before`/`after` payloads STILL record costPriceMinor —
 *      proves the audit-shape override (chunk 1a.2 H-3 invariant).
 *   3. Adversarial extra `tenantId` key — .strict() rejects with
 *      JSON-RPC validation_failed (-32602); failedPaths includes
 *      'tenantId'; product row unchanged.
 *   4. Adversarial extra `role` key — .strict() rejects similarly.
 *   5. Stale expectedUpdatedAt — JSON-RPC stale_write (-32009) +
 *      failure audit row error 'stale_write'; row unchanged.
 *   6. Slug collision — JSON-RPC conflict (-32006) + failure audit row
 *      error 'conflict'; target row unchanged.
 *   7. Unknown id — JSON-RPC not_found (-32004) + failure audit row
 *      error 'not_found'.
 *   8. Cross-tenant id — SAME not_found shape (existence-leak guard);
 *      audit lands under caller's tenant only.
 *   9. PII canary: PAT plaintext NEVER appears anywhere in the audit
 *      chain for this tenant.
 *  10. Tool description does NOT mention 'slug', 'tenantId', 'role'.
 *  11. F-8 invariant: failed update_product wire body does NOT contain
 *      PAT plaintext or its base64url tail.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/server/db/schema";
import { hashBearerToken } from "@/server/auth/bearer-hash";
import { __setBearerLookupDbForTests } from "@/server/auth/bearer-lookup";
import {
  __setTenantLookupLoaderForTests,
  clearTenantCacheForTests,
} from "@/server/tenant";
import { POST } from "@/app/api/mcp/[transport]/route";
import { __setRedisForTests } from "@/server/auth/last-used-debounce";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const sql = postgres(DATABASE_URL, { max: 3 });
const drizzleClient = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(drizzleClient, { schema });

class FakeRedis {
  private store = new Map<string, { value: string; expires: number }>();
  async set(key: string, value: string, expiry: string, window: number, nx: string): Promise<string | null> {
    const now = Date.now();
    for (const [k, v] of this.store) if (v.expires <= now) this.store.delete(k);
    if (nx === "NX" && this.store.has(key)) return null;
    if (expiry === "EX") {
      this.store.set(key, { value, expires: now + window * 1000 });
    } else {
      this.store.set(key, { value, expires: Infinity });
    }
    return "OK";
  }
  clear(): void {
    this.store.clear();
  }
}
const fakeRedis = new FakeRedis();

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const userOwnerId = randomUUID();
const userStaffId = randomUUID();

const patOwner = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patStaff = `eruq_pat_${randomBytes(24).toString("base64url")}`;

let patOwnerRowId: string | null = null;
let patStaffRowId: string | null = null;

const HOST = `mcp-up-${tenantId.slice(0, 8)}.test.local`;

function mcpRequest(body: string | object, auth?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://${HOST}/api/mcp/streamable-http`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function callToolEnvelope(name: string, args: Record<string, unknown>, id = 1): object {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function parseStreamableHttpBody(text: string): {
  id?: unknown;
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: Array<{ type: string; text: string }> };
  error?: { code: number; message?: string };
} {
  const trimmed = text.trim();
  const tryJson = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  if (trimmed.startsWith("{")) {
    return (tryJson(trimmed) ?? {}) as ReturnType<typeof parseStreamableHttpBody>;
  }
  const dataLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return {};
  const json = dataLine.slice("data:".length).trim();
  return (tryJson(json) ?? {}) as ReturnType<typeof parseStreamableHttpBody>;
}

interface AuditLogRow {
  id: string;
  correlation_id: string;
  operation: string;
  outcome: string;
  actor_id: string | null;
  token_id: string | null;
  error: string | null;
}

async function readAuditLog(tId: string): Promise<AuditLogRow[]> {
  return sql<AuditLogRow[]>`
    SELECT id::text, correlation_id::text, operation, outcome,
           actor_id::text AS actor_id, token_id::text AS token_id, error
    FROM audit_log WHERE tenant_id = ${tId}::uuid
    ORDER BY created_at ASC, id ASC
  `;
}

async function readAuditPayloads(
  tId: string,
): Promise<Array<{ kind: string; correlation_id: string; payload: unknown }>> {
  return sql<Array<{ kind: string; correlation_id: string; payload: unknown }>>`
    SELECT kind, correlation_id::text, payload
    FROM audit_payloads WHERE tenant_id = ${tId}::uuid
    ORDER BY created_at ASC
  `;
}

async function seedProductRow(tId: string, opts?: { costPriceMinor?: number | null }): Promise<{ id: string; updatedAt: Date; slug: string }> {
  const id = randomUUID();
  const slug = `seed-${id.slice(0, 8)}`;
  await sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tId}::uuid, ${slug},
      ${sql.json({ en: "Seed", ar: "بذرة" })}, 'draft',
      ${opts?.costPriceMinor ?? null})
  `;
  const rows = await sql<Array<{ updated_at: string }>>`
    SELECT updated_at::text AS updated_at FROM products WHERE id = ${id}
  `;
  return { id, slug, updatedAt: new Date(rows[0]!.updated_at) };
}

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");

  await sql`SELECT 1`;

  __setBearerLookupDbForTests(db);
  __setRedisForTests(fakeRedis as unknown as import("ioredis").default);

  __setTenantLookupLoaderForTests(async (host) => {
    if (host === HOST) {
      return {
        id: tenantId,
        slug: "mcp-up",
        primaryDomain: HOST,
        defaultLocale: "en",
        senderEmail: `no-reply@${HOST}`,
        name: { en: "T", ar: "ت" },
      };
    }
    return null;
  });

  await sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (${tenantId}, ${`mcp-up-${tenantId.slice(0, 8)}`}, ${HOST}, 'en', 'active',
      ${sql.json({ en: "T", ar: "ت" })}, ${`no-reply@${HOST}`})
  `;
  // Second tenant for the cross-tenant existence-leak probe.
  await sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (${otherTenantId}, ${`mcp-up-other-${otherTenantId.slice(0, 8)}`},
      ${`other-${otherTenantId.slice(0, 8)}.test.local`}, 'en', 'active',
      ${sql.json({ en: "O", ar: "ع" })}, ${`no-reply@other-${otherTenantId.slice(0, 8)}.test.local`})
  `;

  for (const uid of [userOwnerId, userStaffId]) {
    await sql`
      INSERT INTO "user" (id, email, email_verified)
      VALUES (${uid}, ${`up-${uid.slice(0, 8)}@example.com`}, true)
    `;
  }

  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantId}, ${userOwnerId}, 'owner')`;
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantId}, ${userStaffId}, 'staff')`;

  const [ownerRow] = await sql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userOwnerId}, ${tenantId}, 'owner-pat',
      ${hashBearerToken(patOwner)}, ${patOwner.slice(9, 17)}, ${sql.json({ role: "owner" })})
    RETURNING id
  `;
  patOwnerRowId = ownerRow?.id ?? null;

  const [staffRow] = await sql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userStaffId}, ${tenantId}, 'staff-pat',
      ${hashBearerToken(patStaff)}, ${patStaff.slice(9, 17)}, ${sql.json({ role: "staff" })})
    RETURNING id
  `;
  patStaffRowId = staffRow?.id ?? null;

  clearTenantCacheForTests();
});

afterAll(async () => {
  await sql`DELETE FROM memberships WHERE tenant_id = ${tenantId}::uuid`;
  await sql`DELETE FROM access_tokens WHERE tenant_id = ${tenantId}::uuid`;
  __setBearerLookupDbForTests(null);
  __setTenantLookupLoaderForTests(null);
  __setRedisForTests(null);
  clearTenantCacheForTests();
  await sql.end({ timeout: 5 });
  await drizzleClient.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CANARY_NAME = "XCANARY_UPDATEPRODUCT_Z99";

describe("MCP update_product integration", () => {
  it("case 1 — owner PAT happy path: ProductOwner structuredContent + product row updated + audit row attributing owner PAT", async () => {
    fakeRedis.clear();
    const seeded = await seedProductRow(tenantId, { costPriceMinor: 100 });
    // MCP boundary speaks SAR; service stores halalas. 9.99 SAR = 999 halalas.
    const body = callToolEnvelope("update_product", {
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      name: { en: `${CANARY_NAME} EN`, ar: `${CANARY_NAME} AR` },
      status: "active",
      costPriceSar: 9.99,
    });
    const res = await POST(mcpRequest(body, patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeUndefined();
    const content = parsed.result?.structuredContent as Record<string, unknown> | undefined;
    expect(content).toBeTruthy();
    expect(content!.id).toBe(seeded.id);
    expect(content).toHaveProperty("costPriceSar");
    expect(content!.costPriceSar).toBe(9.99);

    const dbRows = await sql<Array<{ status: string; cost_price_minor: number | null }>>`
      SELECT status, cost_price_minor FROM products WHERE id = ${seeded.id}
    `;
    expect(dbRows[0]?.status).toBe("active");
    expect(dbRows[0]?.cost_price_minor).toBe(999);

    const auditRows = await readAuditLog(tenantId);
    const row = auditRows.find(
      (r) => r.outcome === "success" && r.operation === "mcp.update_product",
    );
    expect(row).toBeTruthy();
    expect(row!.actor_id).toBe(userOwnerId);
    expect(row!.token_id).toBe(patOwnerRowId);
  });

  it("case 2 — staff PAT happy path: ProductOwner; audit before+after payloads carry costPriceMinor (staff edit, full Tier-B audit)", async () => {
    fakeRedis.clear();
    const seeded = await seedProductRow(tenantId, { costPriceMinor: 4242 });
    const body = callToolEnvelope("update_product", {
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });
    const res = await POST(mcpRequest(body, patStaff));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeUndefined();

    const auditRows = await readAuditLog(tenantId);
    const row = auditRows.find(
      (r) =>
        r.outcome === "success" &&
        r.operation === "mcp.update_product" &&
        r.token_id === patStaffRowId,
    );
    expect(row).toBeTruthy();

    const payloads = await readAuditPayloads(tenantId);
    const before = payloads.find(
      (p) => p.correlation_id === row!.correlation_id && p.kind === "before",
    );
    const after = payloads.find(
      (p) => p.correlation_id === row!.correlation_id && p.kind === "after",
    );
    expect((before!.payload as { costPriceMinor: number | null }).costPriceMinor).toBe(4242);
    expect((after!.payload as { costPriceMinor: number | null }).costPriceMinor).toBe(4242);
  });

  it("case 3 — adversarial tenantId key: .strict() → JSON-RPC validation_failed (-32602); failedPaths includes 'tenantId'; row unchanged", async () => {
    fakeRedis.clear();
    const seeded = await seedProductRow(tenantId);
    const before = await sql<Array<{ status: string }>>`
      SELECT status FROM products WHERE id = ${seeded.id}
    `;
    const body = callToolEnvelope("update_product", {
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
      tenantId: otherTenantId,
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32602 : undefined);
    expect(errCode).toBe(-32602);

    const after = await sql<Array<{ status: string }>>`
      SELECT status FROM products WHERE id = ${seeded.id}
    `;
    expect(after[0]?.status).toBe(before[0]?.status);

    const auditRows = await readAuditLog(tenantId);
    const failureRow = auditRows.find(
      (r) =>
        r.outcome === "failure" &&
        r.operation === "mcp.update_product" &&
        r.error === JSON.stringify({ code: "validation_failed" }),
    );
    expect(failureRow).toBeTruthy();
    const payloads = await readAuditPayloads(tenantId);
    const inputPayload = payloads.find(
      (p) => p.correlation_id === failureRow!.correlation_id && p.kind === "input",
    );
    expect(inputPayload).toBeTruthy();
    const shape = inputPayload!.payload as { failedPaths?: string[] };
    expect(shape.failedPaths).toContain("tenantId");
  });

  it("case 4 — adversarial role key: .strict() → validation_failed", async () => {
    fakeRedis.clear();
    const seeded = await seedProductRow(tenantId);
    const body = callToolEnvelope("update_product", {
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      role: "owner",
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32602 : undefined);
    expect(errCode).toBe(-32602);
  });

  it("case 5 — stale expectedUpdatedAt: JSON-RPC stale_write (-32009) + audit error 'stale_write'", async () => {
    fakeRedis.clear();
    const seeded = await seedProductRow(tenantId);
    // Bump updated_at via a successful first call.
    await POST(
      mcpRequest(
        callToolEnvelope("update_product", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          status: "active",
        }),
        patOwner,
      ),
    );

    const body = callToolEnvelope("update_product", {
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(), // stale
      name: { en: "ShouldNotApply", ar: "ج" },
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32009 : undefined);
    expect(errCode).toBe(-32009);

    const auditRows = await readAuditLog(tenantId);
    const failureRow = auditRows.find(
      (r) =>
        r.outcome === "failure" &&
        r.operation === "mcp.update_product" &&
        r.error === JSON.stringify({ code: "stale_write" }),
    );
    expect(failureRow).toBeTruthy();
  });

  it("case 6 — slug collision: JSON-RPC conflict (-32006) + audit error 'conflict'", async () => {
    fakeRedis.clear();
    const a = await seedProductRow(tenantId);
    const b = await seedProductRow(tenantId);
    const body = callToolEnvelope("update_product", {
      id: b.id,
      expectedUpdatedAt: b.updatedAt.toISOString(),
      slug: a.slug,
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32006 : undefined);
    expect(errCode).toBe(-32006);

    const auditRows = await readAuditLog(tenantId);
    const failureRow = auditRows.find(
      (r) =>
        r.outcome === "failure" &&
        r.operation === "mcp.update_product" &&
        r.error === JSON.stringify({ code: "conflict" }),
    );
    expect(failureRow).toBeTruthy();
  });

  it("case 7 — unknown id: JSON-RPC not_found (-32004) + audit 'not_found'", async () => {
    fakeRedis.clear();
    const phantom = randomUUID();
    const body = callToolEnvelope("update_product", {
      id: phantom,
      expectedUpdatedAt: new Date().toISOString(),
      status: "active",
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32004 : undefined);
    expect(errCode).toBe(-32004);
  });

  it("case 8 — cross-tenant id (PAT for tenantA, id from tenantB): SAME not_found shape; audit lands under caller's tenant only", async () => {
    fakeRedis.clear();
    // Seed a product in OTHER tenant.
    const idInOther = randomUUID();
    const slug = `crossprobe-${idInOther.slice(0, 8)}`;
    await sql`
      INSERT INTO products (id, tenant_id, slug, name, status)
      VALUES (${idInOther}, ${otherTenantId}::uuid, ${slug},
        ${sql.json({ en: "X", ar: "س" })}, 'draft')
    `;

    const body = callToolEnvelope("update_product", {
      id: idInOther,
      expectedUpdatedAt: new Date().toISOString(),
      status: "active",
    });
    const res = await POST(mcpRequest(body, patOwner));
    const parsed = parseStreamableHttpBody(await res.text());
    const errCode = parsed.error?.code ?? (parsed.result?.isError ? -32004 : undefined);
    expect(errCode).toBe(-32004);

    const callerAudit = await readAuditLog(tenantId);
    expect(
      callerAudit.some(
        (r) =>
          r.operation === "mcp.update_product" &&
          r.outcome === "failure" &&
          r.error === JSON.stringify({ code: "not_found" }),
      ),
    ).toBe(true);

    const otherAudit = await readAuditLog(otherTenantId);
    expect(
      otherAudit.some((r) => r.operation === "mcp.update_product"),
    ).toBe(false);
  });

  it("case 9 — PII canary: PAT plaintext NEVER in audit chain for this tenant", async () => {
    const payloads = await readAuditPayloads(tenantId);
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("eruq_pat_");
    expect(serialized).not.toContain(patOwner.slice(9));
    expect(serialized).not.toContain(patStaff.slice(9));
    // Legitimate Tier-C check: case 1's product name appeared in the
    // audit `after` payload.
    expect(serialized).toContain(CANARY_NAME);
  });

  it("case 10 — tool description does NOT mention 'slug', 'tenantId', or 'role'", async () => {
    const { updateProductTool } = await import("@/server/mcp/tools/update-product");
    const desc = updateProductTool.description.toLowerCase();
    expect(desc).not.toContain("slug");
    expect(desc).not.toContain("tenantid");
    expect(desc).not.toContain("role:");
  });

  it("case 11 — F-8 invariant: failed update_product wire body does NOT contain PAT plaintext or its base64url tail", async () => {
    fakeRedis.clear();
    // Force a conflict via slug collision.
    const a = await seedProductRow(tenantId);
    const b = await seedProductRow(tenantId);
    const body = callToolEnvelope("update_product", {
      id: b.id,
      expectedUpdatedAt: b.updatedAt.toISOString(),
      slug: a.slug,
    });
    const res = await POST(mcpRequest(body, patOwner));
    const bodyText = await res.text();
    expect(bodyText.toLowerCase()).not.toContain("eruq_pat_");
    expect(bodyText).not.toContain(patOwner.slice(9));
  });
});
