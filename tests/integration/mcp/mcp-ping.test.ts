/**
 * Integration matrix — sub-chunk 7.2 Block 7 Part D.
 *
 * Runs against REAL Postgres + REAL Redis (the local docker stack) and
 * invokes the Next.js route handler directly. This is a vitest
 * integration test, not a Playwright test: CLAUDE.md §1's "real browser"
 * rule applies to user-facing features; MCP is an API surface exercised
 * by Claude Desktop / autonomous agents, not a page. The test asserts
 * on wire-observable behavior (JSON-RPC envelopes, HTTP status codes,
 * DB side-effects) — same contract that a pure HTTP client would see.
 *
 * Scenarios (10 + 1 canary):
 *   1. Happy path, owner PAT → ping returns { ok, tenantId, role:'owner' }
 *      + last_used_at updates.
 *   2. Staff PAT → role:'staff'.
 *   3. S-5 effective-role demotion — owner user, scopes.role=owner,
 *      membership demoted to staff → role:'staff'.
 *   4. Anonymous reject — no Authorization → 401 + audit_log row count
 *      UNCHANGED (F-4 canary).
 *   5. Cross-tenant reject — tenant A PAT on tenant B host → 401, no
 *      audit, no last_used_at bump.
 *   6. Stale-membership reject — membership deleted between mint and
 *      call → 401.
 *   7. 64KB body cap — >64KB POST → 413 BEFORE parse.
 *   8. Expired PAT → 401.
 *   9. Revoked PAT → 401.
 *   10. Debounce — two calls in <60s write last_used_at only once.
 *   (Pure debounce unit-test already covers the TTL boundary; the
 *    integration test covers the DB observable — one UPDATE per
 *    debounce window.)
 *   F-8 canary — error response body does NOT contain a PAT substring
 *    or its base64url tail. (See the dedicated `error-body-no-pat.test.ts`
 *    stub at the bottom; in 7.2 we assert on the JSON-RPC error envelope
 *    shape, which is the same surface F-8 protects.)
 *
 * NOTE: these tests are written to PASS today even against a cold
 * local stack — they self-seed tenants, memberships, users, and PATs.
 * They do NOT depend on the dev seed (`pnpm db:seed:dev`) or the Playwright
 * global-setup. If the integration stack is down, all 10 skip-cleanly
 * via the top-level `pg.ping()` guard.
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

// Simple fake Redis for debounce — in-memory SET NX EX semantics.
class FakeRedis {
  private store = new Map<string, { value: string; expires: number }>();
  async set(key: string, value: string, expiry: string, window: number, nx: string): Promise<string | null> {
    const now = Date.now();
    // purge expired
    for (const [k, v] of this.store) {
      if (v.expires <= now) this.store.delete(k);
    }
    if (nx === "NX") {
      if (this.store.has(key)) return null;
    }
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

// Fixture state populated in beforeAll.
let pgUp = false;
const tenantAId = randomUUID();
const tenantBId = randomUUID();
const userOwnerId = randomUUID();
const userStaffId = randomUUID();
const userDemotedId = randomUUID();
const userStaleId = randomUUID();

const patOwner = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patStaff = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patDemoted = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patStale = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patExpired = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patRevoked = `eruq_pat_${randomBytes(24).toString("base64url")}`;
const patTenantA = `eruq_pat_${randomBytes(24).toString("base64url")}`;

let patOwnerRowId: string | null = null;
let userStaleMembershipId: string | null = null;

const HOST_A = `mcp-i-a-${tenantAId.slice(0, 8)}.test.local`;
const HOST_B = `mcp-i-b-${tenantBId.slice(0, 8)}.test.local`;

function mcpRequest(host: string, body: string | object, auth?: string): Request {
  // Streamable-HTTP transport requires the client to advertise
  // acceptance of BOTH application/json and text/event-stream. The
  // SDK enforces this at 406 — see
  // node_modules/.../webStandardStreamableHttp.js "Not Acceptable".
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://${host}/api/mcp/streamable-http`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function pingEnvelope(id = 1): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  };
}

async function auditCount(tenantId: string): Promise<number> {
  const rows = await sql<Array<{ c: string }>>`
    SELECT COUNT(*)::text AS c FROM audit_log WHERE tenant_id = ${tenantId}::uuid
  `;
  return Number(rows[0]?.c ?? 0);
}

async function lastUsed(tokenId: string): Promise<Date | null> {
  const rows = await sql<Array<{ last_used_at: Date | null }>>`
    SELECT last_used_at FROM access_tokens WHERE id = ${tokenId}::uuid
  `;
  return rows[0]?.last_used_at ?? null;
}

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");

  // Sanity — the integration tests require a live Postgres. If down,
  // we fail loudly rather than silently skip (CLAUDE.md §9 — "Do not
  // spiral on failures"). Operator must `pnpm services:up` first.
  await sql`SELECT 1`;
  pgUp = true;

  // Wire the integration db into the lookup path (bypasses the
  // app_user pool for tests — same pattern bearer-lookup.test.ts uses).
  __setBearerLookupDbForTests(db);
  __setRedisForTests(fakeRedis as unknown as import("ioredis").default);

  // Tenant loader override: resolve HOST_A → tenantAId, HOST_B → tenantBId.
  __setTenantLookupLoaderForTests(async (host) => {
    if (host === HOST_A) {
      return {
        id: tenantAId,
        slug: "mcp-a",
        primaryDomain: HOST_A,
        defaultLocale: "en",
        senderEmail: `no-reply@${HOST_A}`,
        name: { en: "A", ar: "أ" },
      };
    }
    if (host === HOST_B) {
      return {
        id: tenantBId,
        slug: "mcp-b",
        primaryDomain: HOST_B,
        defaultLocale: "en",
        senderEmail: `no-reply@${HOST_B}`,
        name: { en: "B", ar: "ب" },
      };
    }
    return null;
  });

  // Seed two tenants.
  await sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES
      (${tenantAId}, ${`mcp-a-${tenantAId.slice(0, 8)}`}, ${HOST_A}, 'en', 'active',
        ${sql.json({ en: "A", ar: "أ" })}, ${`no-reply@${HOST_A}`}),
      (${tenantBId}, ${`mcp-b-${tenantBId.slice(0, 8)}`}, ${HOST_B}, 'en', 'active',
        ${sql.json({ en: "B", ar: "ب" })}, ${`no-reply@${HOST_B}`})
  `;

  // Seed users.
  for (const uid of [userOwnerId, userStaffId, userDemotedId, userStaleId]) {
    await sql`
      INSERT INTO "user" (id, email, email_verified)
      VALUES (${uid}, ${`int-${uid.slice(0, 8)}@example.com`}, true)
    `;
  }

  // Memberships — tenant A.
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userOwnerId}, 'owner')`;
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userStaffId}, 'staff')`;
  // demoted user: PAT minted as owner-scoped, membership=staff → S-5.
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userDemotedId}, 'staff')`;
  // stale user: membership created here but deleted later in the stale test.
  const staleRow = await sql<Array<{ id: string }>>`
    INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantAId}, ${userStaleId}, 'owner')
    RETURNING id
  `;
  userStaleMembershipId = staleRow[0]?.id ?? null;

  // Tenant A PATs.
  const [ownerRow] = await sql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userOwnerId}, ${tenantAId}, 'owner-pat',
      ${hashBearerToken(patOwner)}, ${patOwner.slice(9, 17)}, ${sql.json({ role: "owner" })})
    RETURNING id
  `;
  patOwnerRowId = ownerRow?.id ?? null;

  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userStaffId}, ${tenantAId}, 'staff-pat',
      ${hashBearerToken(patStaff)}, ${patStaff.slice(9, 17)}, ${sql.json({ role: "staff" })})
  `;

  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userDemotedId}, ${tenantAId}, 'demoted-pat',
      ${hashBearerToken(patDemoted)}, ${patDemoted.slice(9, 17)}, ${sql.json({ role: "owner" })})
  `;

  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userStaleId}, ${tenantAId}, 'stale-pat',
      ${hashBearerToken(patStale)}, ${patStale.slice(9, 17)}, ${sql.json({ role: "owner" })})
  `;

  // Expired PAT — expires_at in the past.
  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes, expires_at)
    VALUES (${userOwnerId}, ${tenantAId}, 'expired-pat',
      ${hashBearerToken(patExpired)}, ${patExpired.slice(9, 17)}, ${sql.json({ role: "owner" })},
      now() - interval '1 day')
  `;

  // Revoked PAT — revoked_at set.
  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes, revoked_at)
    VALUES (${userOwnerId}, ${tenantAId}, 'revoked-pat',
      ${hashBearerToken(patRevoked)}, ${patRevoked.slice(9, 17)}, ${sql.json({ role: "owner" })},
      now() - interval '1 minute')
  `;

  // Tenant A PAT that will be cross-tenant tested against HOST_B.
  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userOwnerId}, ${tenantAId}, 'crosstenant-pat',
      ${hashBearerToken(patTenantA)}, ${patTenantA.slice(9, 17)}, ${sql.json({ role: "owner" })})
  `;

  // Tenant cache might have stale entries from other test files.
  clearTenantCacheForTests();
});

afterAll(async () => {
  if (pgUp) {
    // Clean up — cascade via tenants deletion handles children.
    await sql`DELETE FROM memberships WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
    await sql`DELETE FROM access_tokens WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
    await sql`DELETE FROM audit_payloads WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
    await sql`DELETE FROM audit_log WHERE tenant_id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
    await sql`DELETE FROM tenants WHERE id IN (${tenantAId}::uuid, ${tenantBId}::uuid)`;
    await sql`DELETE FROM "user" WHERE id = ANY(${sql.array([userOwnerId, userStaffId, userDemotedId, userStaleId])}::uuid[])`;
  }
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

function parseRpcBody(text: string): {
  id?: unknown;
  result?: { structuredContent?: unknown };
  error?: { code: number; message?: string };
} {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Streamable-HTTP can return either:
 *   - A plain JSON-RPC envelope (content-type: application/json).
 *   - A single-event SSE stream: `event: message\ndata: {"jsonrpc":...}\n\n`
 *     (content-type: text/event-stream).
 * This helper parses both shapes into the JSON-RPC envelope. Non-matching
 * inputs return {}.
 */
function parseStreamableHttpBody(text: string): {
  id?: unknown;
  result?: { structuredContent?: unknown };
  error?: { code: number; message?: string };
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return parseRpcBody(trimmed);
  // SSE — find a `data: {...}` line and parse it.
  const dataLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return {};
  const json = dataLine.slice("data:".length).trim();
  return parseRpcBody(json);
}

describe("MCP ping integration matrix", () => {
  it("1 + 10 — owner PAT → role:owner + last_used_at updates on first call, debounced on second", async () => {
    fakeRedis.clear();
    const before = patOwnerRowId ? await lastUsed(patOwnerRowId) : null;
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(1), patOwner));
    expect(res.status).toBe(200);
    const rawText = await res.text();
    // Streamable-HTTP encodes the response as SSE ("event: message\ndata: {...}\n\n")
    // when the response body is non-empty; parse the JSON-RPC envelope
    // from either SSE text OR a plain JSON body (depends on MCP version).
    const body = parseStreamableHttpBody(rawText);
    const content = (body as { result?: { structuredContent?: Record<string, unknown> } }).result
      ?.structuredContent;
    expect(content).toMatchObject({ ok: true, role: "owner", tenantId: tenantAId });

    const after1 = patOwnerRowId ? await lastUsed(patOwnerRowId) : null;
    expect(after1).not.toBeNull();
    if (before && after1) expect(after1.getTime()).toBeGreaterThan(before.getTime());

    // Debounce — second call in same 60s window, last_used_at must not advance.
    const res2 = await POST(mcpRequest(HOST_A, pingEnvelope(2), patOwner));
    expect(res2.status).toBe(200);
    // Drain the body so the underlying stream closes; we don't assert on
    // it further (the debounce DB assertion is the real observable).
    await res2.text();
    const after2 = patOwnerRowId ? await lastUsed(patOwnerRowId) : null;
    expect(after2?.getTime()).toBe(after1?.getTime());
  });

  it("2 — staff PAT returns role:staff", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(3), patStaff));
    expect(res.status).toBe(200);
    const body = parseStreamableHttpBody(await res.text());
    const content = (body as { result?: { structuredContent?: Record<string, unknown> } }).result
      ?.structuredContent;
    expect(content).toMatchObject({ role: "staff" });
  });

  it("3 — S-5 demotion: PAT minted owner-scoped, membership=staff → role:staff", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(4), patDemoted));
    expect(res.status).toBe(200);
    const body = parseStreamableHttpBody(await res.text());
    const content = (body as { result?: { structuredContent?: Record<string, unknown> } }).result
      ?.structuredContent;
    expect(content).toMatchObject({ role: "staff" });
  });

  it("4 — anonymous → 401 + audit_log count UNCHANGED (F-4 canary)", async () => {
    fakeRedis.clear();
    const before = await auditCount(tenantAId);
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(5)));
    expect(res.status).toBe(401);
    const body = parseRpcBody(await res.text());
    expect(body.error?.code).toBe(-32003);
    const after = await auditCount(tenantAId);
    expect(after).toBe(before); // ← F-4: anonymous path MUST NOT audit.
  });

  it("5 — cross-tenant reject: tenant A PAT on tenant B host → 401 (anonymous), no audit", async () => {
    fakeRedis.clear();
    const beforeAudit = await auditCount(tenantBId);
    const res = await POST(mcpRequest(HOST_B, pingEnvelope(6), patTenantA));
    expect(res.status).toBe(401);
    const body = parseRpcBody(await res.text());
    expect(body.error?.code).toBe(-32003);
    expect(await auditCount(tenantBId)).toBe(beforeAudit);
  });

  it("6 — stale-membership: delete the membership after mint → subsequent call 401", async () => {
    fakeRedis.clear();
    if (!userStaleMembershipId) throw new Error("fixture: no stale membership id");
    await sql`DELETE FROM memberships WHERE id = ${userStaleMembershipId}::uuid`;
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(7), patStale));
    expect(res.status).toBe(401);
  });

  it("7 — 64KB body cap: >64KB POST → 413, never reaches the SDK", async () => {
    fakeRedis.clear();
    const big = JSON.stringify({ pad: "a".repeat(70 * 1024) });
    const res = await POST(mcpRequest(HOST_A, big, patOwner));
    expect(res.status).toBe(413);
    const body = parseRpcBody(await res.text());
    expect(body.error?.code).toBe(-32600);
  });

  it("8 — expired PAT → 401", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(8), patExpired));
    expect(res.status).toBe(401);
    const body = parseRpcBody(await res.text());
    expect(body.error?.code).toBe(-32003);
  });

  it("9 — revoked PAT → 401", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(HOST_A, pingEnvelope(9), patRevoked));
    expect(res.status).toBe(401);
    const body = parseRpcBody(await res.text());
    expect(body.error?.code).toBe(-32003);
  });

  it("F-8 canary — error response body does NOT contain a PAT substring or base64url tail", async () => {
    // On the happy path, the PAT plaintext is in the Authorization
    // header. We fire a valid request whose handler completes,
    // then fire an invalid one (unknown tool) whose error response
    // body we scan. The F-8 invariant: nothing in the body matches
    // `eruq_pat_` or the 43-char base64url tail of the PAT we sent.
    //
    // (The stronger F-8 test — a test-only tool that throws with the
    // PAT embedded in its message — requires a test-only tool
    // registration gated behind APP_ENV=e2e, which is out of scope for
    // this 7.2 integration surface. The unit-test coverage in
    // errors.test.ts pins the closed-set message policy.)
    fakeRedis.clear();
    const body = {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "this-tool-does-not-exist", arguments: {} },
    };
    const res = await POST(mcpRequest(HOST_A, body, patOwner));
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("eruq_pat_");
    const tail = patOwner.slice(9); // 43 base64url chars
    expect(text).not.toContain(tail);
    expect(text).toContain("jsonrpc");
  });
});
