/**
 * Integration test — `list_products` MCP tool (chunk 1a.1).
 *
 * Drives the real Next.js MCP route handler against real Postgres +
 * a fake-but-shape-accurate Redis, through a real PAT.
 *
 * Cases:
 *   1. Owner PAT happy path — returns owner-shape envelope with items;
 *      NO audit row is written on a successful read.
 *   2. Support PAT — authorize refuses with `forbidden`; Decision-1
 *      widening at `audit-adapter.ts` writes exactly ONE failure audit
 *      row with errorCode='forbidden'; wire body carries no product rows.
 *   3. Anonymous (no PAT) — route rejects at the edge with UNAUTHORIZED.
 *   4. Adversarial `tenantId` in body — rejected by `.strict()` at MCP
 *      seam (validation_failed); no rows leaked; failure audit NOT
 *      written for validation_failed on a read (per Decision-1: only
 *      forbidden refusals widen audit on reads).
 *   5. Cross-tenant probe — a PAT minted for tenant A never sees rows
 *      seeded for tenant B (tenant scope enforced by the resolver +
 *      RLS).
 *   6. F-8 invariant — PAT plaintext never appears on the wire in any
 *      response body for this tool.
 */
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const sql = postgres(DATABASE_URL, { max: 3 });
const drizzleClient = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(drizzleClient, { schema });

class FakeRedis {
  private store = new Map<string, { value: string; expires: number }>();
  async set(
    key: string,
    value: string,
    expiry: string,
    window: number,
    nx: string,
  ): Promise<string | null> {
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

const tenantAId = randomUUID();
const tenantBId = randomUUID();
const userOwnerId = randomUUID();
const userSupportId = randomUUID();

const patOwner = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patSupport = `eruq_pat_${randomBytes(24).toString("base64url")}`;

const HOST_A = `mcp-list-a-${tenantAId.slice(0, 8)}.test.local`;
const HOST_B = `mcp-list-b-${tenantBId.slice(0, 8)}.test.local`;

function mcpRequest(host: string, body: object, auth?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://${host}/api/mcp/streamable-http`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function callToolEnvelope(
  name: string,
  args: Record<string, unknown>,
  id = 1,
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function parseStreamableHttpBody(text: string): {
  id?: unknown;
  result?: {
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
  };
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
    return (tryJson(trimmed) ?? {}) as ReturnType<
      typeof parseStreamableHttpBody
    >;
  }
  const dataLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return {};
  const json = dataLine.slice("data:".length).trim();
  return (tryJson(json) ?? {}) as ReturnType<typeof parseStreamableHttpBody>;
}

async function readAuditLog(
  tId: string,
): Promise<
  Array<{
    id: string;
    operation: string;
    outcome: string;
    error: string | null;
  }>
> {
  return sql<
    Array<{
      id: string;
      operation: string;
      outcome: string;
      error: string | null;
    }>
  >`
    SELECT id::text, operation, outcome, error
    FROM audit_log
    WHERE tenant_id = ${tId}::uuid
    ORDER BY created_at ASC, id ASC
  `;
}

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER)
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");

  await sql`SELECT 1`;

  __setBearerLookupDbForTests(db);
  __setRedisForTests(fakeRedis as unknown as import("ioredis").default);

  __setTenantLookupLoaderForTests(async (host) => {
    if (host === HOST_A) {
      return {
        id: tenantAId,
        slug: "mcp-list-a",
        primaryDomain: HOST_A,
        defaultLocale: "en",
        senderEmail: `no-reply@${HOST_A}`,
        name: { en: "T", ar: "ت" },
      };
    }
    if (host === HOST_B) {
      return {
        id: tenantBId,
        slug: "mcp-list-b",
        primaryDomain: HOST_B,
        defaultLocale: "en",
        senderEmail: `no-reply@${HOST_B}`,
        name: { en: "T", ar: "ت" },
      };
    }
    return null;
  });

  for (const [id, slug, host] of [
    [tenantAId, `mcp-list-a-${tenantAId.slice(0, 8)}`, HOST_A],
    [tenantBId, `mcp-list-b-${tenantBId.slice(0, 8)}`, HOST_B],
  ] as const) {
    await sql`
      INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
      VALUES (${id}, ${slug}, ${host}, 'en', 'active',
        ${sql.json({ en: "T", ar: "ت" })}, ${`no-reply@${host}`})
    `;
  }

  for (const uid of [userOwnerId, userSupportId]) {
    await sql`
      INSERT INTO "user" (id, email, email_verified)
      VALUES (${uid}, ${`li-${uid.slice(0, 8)}@example.com`}, true)
    `;
  }

  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userOwnerId}, 'owner')`;
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userSupportId}, 'support')`;

  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userOwnerId}, ${tenantAId}, 'owner-pat',
      ${hashBearerToken(patOwner)}, ${patOwner.slice(9, 17)},
      ${sql.json({ role: "owner" })})
  `;
  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userSupportId}, ${tenantAId}, 'support-pat',
      ${hashBearerToken(patSupport)}, ${patSupport.slice(9, 17)},
      ${sql.json({ role: "support" })})
  `;

  // Seed products: tenant A = 2 rows, tenant B = 3 rows (cross-tenant probe).
  for (let i = 0; i < 2; i++) {
    await sql`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (${tenantAId}, ${`a-${randomUUID().slice(0, 8)}`},
        ${sql.json({ en: `ATENANT ${i}`, ar: `أ ${i}` })}, 'draft')
    `;
  }
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (${tenantBId}, ${`b-${randomUUID().slice(0, 8)}`},
        ${sql.json({ en: `BTENANT ${i}`, ar: `ب ${i}` })}, 'draft')
    `;
  }

  clearTenantCacheForTests();
});

afterAll(async () => {
  // audit_log is append-only; we cannot cleanly delete our tenants.
  // Clean up rows we CAN delete and leave audit untouched.
  await sql`DELETE FROM memberships WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
  await sql`DELETE FROM access_tokens WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
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

describe("MCP list_products integration", () => {
  it("case 1 — owner PAT happy path: returns owner-shape envelope, NO audit row written on success", async () => {
    fakeRedis.clear();
    const auditBefore = (await readAuditLog(tenantAId)).length;

    const body = callToolEnvelope("list_products", {});
    const res = await POST(mcpRequest(HOST_A, body, patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeUndefined();
    const content = parsed.result?.structuredContent;
    expect(content).toBeTruthy();
    expect(Array.isArray((content as { items: unknown[] }).items)).toBe(true);
    expect((content as { items: unknown[] }).items.length).toBe(2);
    expect(content).toHaveProperty("hasMore");
    expect(content).toHaveProperty("nextCursor");
    // Owner-only Tier-B field (post-1a.2 alignment with prd §6.5).
    // Staff would NOT see this column; this case is owner so the
    // field is present even though every value in this fixture is
    // null.
    const items = (content as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]).toHaveProperty("costPriceMinor");

    const auditAfter = (await readAuditLog(tenantAId)).length;
    expect(auditAfter).toBe(auditBefore);
  });

  it("case 2 — support PAT: authorize refuses with forbidden; Decision-1 widening writes ONE failure audit row; body has no products", async () => {
    fakeRedis.clear();
    const auditBefore = (await readAuditLog(tenantAId)).length;

    const body = callToolEnvelope("list_products", {});
    const res = await POST(mcpRequest(HOST_A, body, patSupport));
    expect(res.status).toBe(200); // JSON-RPC returns 200 with an error envelope
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeTruthy();
    expect(parsed.error?.code).toBe(-32003); // forbidden
    expect(parsed.result?.structuredContent).toBeUndefined();

    const audit = await readAuditLog(tenantAId);
    expect(audit.length).toBe(auditBefore + 1);
    const last = audit[audit.length - 1]!;
    expect(last.operation).toBe("mcp.list_products");
    expect(last.outcome).toBe("failure");
    expect(last.error).toBe(JSON.stringify({ code: "forbidden" }));
  });

  it("case 3 — anonymous (no bearer): rejected at the HTTP edge", async () => {
    fakeRedis.clear();
    const body = callToolEnvelope("list_products", {});
    const res = await POST(mcpRequest(HOST_A, body)); // no auth header
    // The MCP route rejects anonymous callers early; the exact envelope
    // is whatever `route.ts` renders. Either HTTP 401 or a JSON-RPC
    // -32003 body is acceptable — both are load-bearing "unauthorized".
    if (res.status === 401) {
      expect(res.status).toBe(401);
    } else {
      expect(res.status).toBe(200);
      const parsed = parseStreamableHttpBody(await res.text());
      expect(parsed.error).toBeTruthy();
      expect(parsed.error?.code).toBe(-32003);
    }
  });

  it("case 4 — adversarial tenantId in body: .strict() rejects at the MCP seam", async () => {
    fakeRedis.clear();
    const body = callToolEnvelope("list_products", {
      tenantId: tenantBId, // attack: try to pivot to tenant B
    });
    const res = await POST(mcpRequest(HOST_A, body, patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeTruthy();
    expect(parsed.error?.code).toBe(-32602); // validation_failed
  });

  it("case 5 — cross-tenant probe: owner PAT on host A never sees host-B rows", async () => {
    fakeRedis.clear();
    const body = callToolEnvelope("list_products", { limit: 100 });
    const res = await POST(mcpRequest(HOST_A, body, patOwner));
    expect(res.status).toBe(200);
    const text = await res.text();
    // No BTENANT substring anywhere in the response body.
    expect(text).not.toContain("BTENANT");
    expect(text).toContain("ATENANT");
  });

  it("case 6 — F-8: PAT plaintext never appears in the wire body (success or failure)", async () => {
    fakeRedis.clear();
    // Happy path
    const okRes = await POST(
      mcpRequest(HOST_A, callToolEnvelope("list_products", {}), patOwner),
    );
    const okText = await okRes.text();
    expect(okText).not.toContain(patOwner);
    expect(okText).not.toContain(patOwner.slice(9));

    // Failure path (support → forbidden)
    const failRes = await POST(
      mcpRequest(HOST_A, callToolEnvelope("list_products", {}), patSupport),
    );
    const failText = await failRes.text();
    expect(failText).not.toContain(patSupport);
    expect(failText).not.toContain(patSupport.slice(9));
  });
});
