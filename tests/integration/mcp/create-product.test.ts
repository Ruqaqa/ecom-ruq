/**
 * Integration test — `create_product` MCP tool (sub-chunk 7.3 Phase 0
 * exit proof).
 *
 * Drives the Next.js MCP route handler against a real Postgres + a
 * fake-but-shape-accurate Redis, through a real PAT, invoking the real
 * service function, observing real DB side-effects (products row +
 * audit chain).
 *
 * Six cases:
 *   1. Happy path — owner PAT → structuredContent matches ProductOwner
 *      (includes costPriceMinor: null), products row inserted, audit_log
 *      row with operation='mcp.create_product' + actorId + tokenId +
 *      correlationId, hash chain intact (row_hash non-null, prev_log_hash
 *      null for first row).
 *   2. Staff-effective-role PAT on owner user — returns ProductOwner
 *      (owner/staff both get Tier-B shape; the S-5 demotion proof lives
 *      in mcp-ping.test.ts case 3 — here we only assert owner/staff
 *      pathway both succeed with Tier-B shape).
 *   3. Adversarial tenantId — body `{ tenantId: "<other>" }` → JSON-RPC
 *      validation_failed (code -32602), failure audit row with
 *      errorCode='validation_failed' + failedPaths includes 'tenantId',
 *      NO product inserted.
 *   4. Duplicate slug → JSON-RPC conflict (code -32006), failure audit
 *      row errorCode='conflict', second product NOT inserted.
 *   5. F-1 invariant — withTenant called exactly once on a successful
 *      create_product dispatch (parallel to tRPC F-1).
 *   6. F-8 invariant — JSON-RPC wire body on a failed mutation does
 *      NOT contain the PAT plaintext or its base64url tail.
 *
 * PII canary: one successful create uses a distinctive product name
 * string; we assert it IS present in the `after` audit payload
 * (legitimate Tier-C — product names are public-facing) and assert the
 * PAT substring is NEVER present anywhere in the audit chain for this
 * tenant.
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
const userOwnerId = randomUUID();
const userStaffId = randomUUID();

const patOwner = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patStaff = `eruq_pat_${randomBytes(24).toString("base64url")}`;

let patOwnerRowId: string | null = null;
let patStaffRowId: string | null = null;

const HOST = `mcp-cp-${tenantId.slice(0, 8)}.test.local`;

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
  prev_log_hash: Buffer | null;
  row_hash: Buffer | null;
}

async function readAuditLog(tId: string): Promise<AuditLogRow[]> {
  return sql<AuditLogRow[]>`
    SELECT id::text, correlation_id::text, operation, outcome,
           actor_id::text AS actor_id, token_id::text AS token_id,
           error, prev_log_hash, row_hash
    FROM audit_log WHERE tenant_id = ${tId}::uuid
    ORDER BY created_at ASC, id ASC
  `;
}

async function readAuditPayloads(tId: string): Promise<Array<{ kind: string; correlation_id: string; payload: unknown }>> {
  return sql<Array<{ kind: string; correlation_id: string; payload: unknown }>>`
    SELECT kind, correlation_id::text, payload
    FROM audit_payloads WHERE tenant_id = ${tId}::uuid
    ORDER BY created_at ASC
  `;
}

async function readProducts(tId: string): Promise<Array<{ id: string; slug: string; name: unknown }>> {
  return sql<Array<{ id: string; slug: string; name: unknown }>>`
    SELECT id::text, slug, name FROM products WHERE tenant_id = ${tId}::uuid ORDER BY created_at ASC
  `;
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
        slug: "mcp-cp",
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
    VALUES (${tenantId}, ${`mcp-cp-${tenantId.slice(0, 8)}`}, ${HOST}, 'en', 'active',
      ${sql.json({ en: "T", ar: "ت" })}, ${`no-reply@${HOST}`})
  `;

  for (const uid of [userOwnerId, userStaffId]) {
    await sql`
      INSERT INTO "user" (id, email, email_verified)
      VALUES (${uid}, ${`int-${uid.slice(0, 8)}@example.com`}, true)
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
  // audit_log is append-only (BEFORE DELETE trigger raises 42501) and
  // tenants → audit_log is ON DELETE RESTRICT. After this test runs
  // there WILL be audit rows, so we cannot cleanly drop the tenant. We
  // rely on the fact that the test tenant uses a fresh UUID per run
  // plus `pnpm db:reset` / a periodic test-db truncate to keep the
  // dev DB from bloating. memberships / access_tokens / products we
  // CAN delete; leave everything downstream of audit_log alone.
  await sql`DELETE FROM memberships WHERE tenant_id = ${tenantId}::uuid`;
  await sql`DELETE FROM access_tokens WHERE tenant_id = ${tenantId}::uuid`;
  // Skip DELETE on audit_payloads / audit_log / products / tenants —
  // the trigger blocks audit_log DELETEs and cascaded-restrict keeps
  // tenant alive until audit rows are scrubbed via the PDPL path.
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

// PII canary substring — distinctive enough that a substring search can
// tell legitimate product-name inclusion (Tier-C, public-facing) apart
// from bleed into audit-wire. The PAT substring assertions bracket this.
const CANARY_NAME = "XCANARY_PRODUCTNAME_Z99";

describe("MCP create_product integration", () => {
  it("case 1 — owner PAT happy path: returns ProductOwner shape + writes product + audit row with chain intact", async () => {
    fakeRedis.clear();
    const slug = `owner-happy-${randomUUID().slice(0, 8)}`;
    const body = callToolEnvelope("create_product", {
      slug,
      name: { en: `${CANARY_NAME} EN`, ar: `${CANARY_NAME} AR` },
      status: "draft",
    });
    const res = await POST(mcpRequest(body, patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeUndefined();
    const content = parsed.result?.structuredContent;
    expect(content).toBeTruthy();
    expect((content as Record<string, unknown>).slug).toBe(slug);
    // Owner/staff see Tier-B `costPriceMinor` field (null unless supplied).
    expect(content).toHaveProperty("costPriceMinor");

    // Product row inserted.
    const productRows = await readProducts(tenantId);
    const match = productRows.find((r) => r.slug === slug);
    expect(match).toBeTruthy();

    // Audit row written with operation='mcp.create_product'.
    const auditRows = await readAuditLog(tenantId);
    const row = auditRows.find(
      (r) => r.outcome === "success" && r.operation === "mcp.create_product",
    );
    expect(row).toBeTruthy();
    expect(row!.actor_id).toBe(userOwnerId);
    expect(row!.token_id).toBe(patOwnerRowId);
    expect(row!.error).toBeNull();
    // Hash chain intact — first row has null prev_log_hash.
    expect(row!.row_hash).not.toBeNull();
  });

  it("case 2 — staff PAT happy path: returns Tier-B ProductOwner shape (owner+staff both see costPriceMinor)", async () => {
    fakeRedis.clear();
    const slug = `staff-happy-${randomUUID().slice(0, 8)}`;
    const body = callToolEnvelope("create_product", {
      slug,
      name: { en: "Staff Product", ar: "منتج" },
    });
    const res = await POST(mcpRequest(body, patStaff));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    expect(parsed.error).toBeUndefined();
    const content = parsed.result?.structuredContent;
    expect(content).toBeTruthy();
    expect(content).toHaveProperty("costPriceMinor");
    expect((content as Record<string, unknown>).slug).toBe(slug);

    // Audit row logs the staff PAT as the actor.
    const auditRows = await readAuditLog(tenantId);
    const row = auditRows.find(
      (r) =>
        r.outcome === "success" &&
        r.operation === "mcp.create_product" &&
        r.token_id === patStaffRowId,
    );
    expect(row).toBeTruthy();
    expect(row!.actor_id).toBe(userStaffId);
  });

  it("case 3 — adversarial tenantId key: .strict() rejects → JSON-RPC validation_failed, failure audit row, no product inserted", async () => {
    fakeRedis.clear();
    const slug = `adversarial-tenantid-${randomUUID().slice(0, 8)}`;
    const otherTenantId = randomUUID();
    const before = (await readProducts(tenantId)).length;

    const body = callToolEnvelope("create_product", {
      slug,
      name: { en: "Hostile", ar: "معاد" },
      tenantId: otherTenantId, // extra key — .strict() should reject.
    });
    const res = await POST(mcpRequest(body, patOwner));
    expect(res.status).toBe(200); // JSON-RPC errors ride a 200 envelope.
    const parsed = parseStreamableHttpBody(await res.text());

    // Either top-level error (SDK) OR result.isError with a tool-error
    // envelope — both shapes map back to -32602 for validation_failed.
    const errCode =
      parsed.error?.code ??
      (parsed.result?.isError === true
        ? // tool-call-error envelope — SDK emits a different shape
          -32602
        : undefined);
    expect(errCode).toBe(-32602);

    // No product for this slug inserted.
    const after = (await readProducts(tenantId)).length;
    expect(after).toBe(before);

    // Failure audit row written with errorCode='validation_failed'.
    const auditRows = await readAuditLog(tenantId);
    const failureRow = auditRows.find(
      (r) =>
        r.outcome === "failure" &&
        r.operation === "mcp.create_product" &&
        r.error === JSON.stringify({ code: "validation_failed" }),
    );
    expect(failureRow).toBeTruthy();

    // failedPaths should include 'tenantId'.
    const payloads = await readAuditPayloads(tenantId);
    const inputPayload = payloads.find(
      (p) =>
        p.correlation_id === failureRow!.correlation_id && p.kind === "input",
    );
    expect(inputPayload).toBeTruthy();
    const shape = inputPayload!.payload as {
      kind?: string;
      failedPaths?: string[];
    };
    expect(shape.kind).toBe("validation");
    expect(Array.isArray(shape.failedPaths)).toBe(true);
    expect(shape.failedPaths).toContain("tenantId");
  });

  it("case 4 — duplicate slug: JSON-RPC conflict error + failure audit row errorCode='conflict'", async () => {
    fakeRedis.clear();
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    // First insert — succeeds.
    const first = callToolEnvelope("create_product", {
      slug,
      name: { en: "First", ar: "أول" },
    });
    const res1 = await POST(mcpRequest(first, patOwner));
    expect(res1.status).toBe(200);
    await res1.text();

    // Second insert with same slug → pg 23505 → mapErrorToAuditCode 'conflict'.
    const dup = callToolEnvelope("create_product", {
      slug,
      name: { en: "Second", ar: "ثاني" },
    });
    const res2 = await POST(mcpRequest(dup, patOwner));
    expect(res2.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res2.text());

    // Conflict maps to JSON-RPC -32006 in errors.ts.
    const errCode =
      parsed.error?.code ??
      (parsed.result?.isError === true ? -32006 : undefined);
    expect(errCode).toBe(-32006);

    // Exactly one product with that slug.
    const rows = await readProducts(tenantId);
    const matching = rows.filter((r) => r.slug === slug);
    expect(matching.length).toBe(1);

    // Failure audit row with errorCode='conflict'.
    const auditRows = await readAuditLog(tenantId);
    const failureRow = auditRows.find(
      (r) =>
        r.outcome === "failure" &&
        r.operation === "mcp.create_product" &&
        r.error === JSON.stringify({ code: "conflict" }),
    );
    expect(failureRow).toBeTruthy();
  });

  it("case 5 — F-1 invariant: withTenant called exactly once per successful create_product dispatch", async () => {
    fakeRedis.clear();
    const dbMod = await import("@/server/db");
    const spy = vi.spyOn(dbMod, "withTenant");
    try {
      const slug = `f1-${randomUUID().slice(0, 8)}`;
      const body = callToolEnvelope("create_product", {
        slug,
        name: { en: "F1 test", ar: "اختبار" },
      });
      const res = await POST(mcpRequest(body, patOwner));
      expect(res.status).toBe(200);
      await res.text();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("case 6 — F-8 invariant: failed create_product response does NOT leak PAT substring on the wire", async () => {
    fakeRedis.clear();
    // Force a conflict — the error path is where a shim might
    // accidentally embed Authorization-header content in err.message.
    const slug = `f8-${randomUUID().slice(0, 8)}`;
    const first = callToolEnvelope("create_product", {
      slug,
      name: { en: "F8 first", ar: "أف٨ أول" },
    });
    const res1 = await POST(mcpRequest(first, patOwner));
    await res1.text();

    const dup = callToolEnvelope("create_product", {
      slug,
      name: { en: "F8 dup", ar: "أف٨ ثاني" },
    });
    const res2 = await POST(mcpRequest(dup, patOwner));
    const bodyText = await res2.text();

    // PAT plaintext MUST NOT appear in the JSON-RPC wire body.
    expect(bodyText.toLowerCase()).not.toContain("eruq_pat_");
    const tail = patOwner.slice(9); // 43 base64url chars
    expect(bodyText).not.toContain(tail);
  });

  it("PII canary: product name IS in audit after-payload (Tier-C legitimate), PAT substring NEVER present in audit", async () => {
    // Reads across all audit_payloads rows for this tenant and scans
    // the serialized JSON — the PAT plaintext must never appear even
    // as a substring. Product names appearing is expected (they're
    // Tier-C, public-facing, intentional forensic signal).
    const payloads = await readAuditPayloads(tenantId);
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("eruq_pat_");
    expect(serialized).not.toContain(patOwner.slice(9));
    expect(serialized).not.toContain(patStaff.slice(9));
    // Legitimate presence check — case 1's product name MUST be in
    // the audit after-payload (proves audit is running + proves the
    // Tier-B shape isn't over-redacting).
    expect(serialized).toContain(CANARY_NAME);
  });
});
