/**
 * Integration matrix — `run_sql_readonly` MCP tool (sub-chunk 7.4).
 *
 * 7.4 ships this tool LOCKED OFF. Gate = two conditions, both must be
 * satisfied for the tool to be VISIBLE in `tools/list`:
 *   - `MCP_RUN_SQL_ENABLED === "1"` (env flag, default unset).
 *   - The caller's PAT `scopes.tools` array includes `"run_sql_readonly"`.
 *
 * But even when the visibility gate is fully open, `authorize(ctx)`
 * UNCONDITIONALLY throws `forbidden` in 7.4. Relaxing `authorize` is a
 * later chunk's job. The five-case matrix below proves the full
 * semantics — visibility composes, `authorize` is the hard lock.
 *
 * Drives the Next.js MCP route handler against real Postgres + fake
 * Redis, mirroring the 7.3 `create-product.test.ts` self-seed pattern.
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

const tenantId = randomUUID();
const userNoToolsId = randomUUID();
const userWithToolsId = randomUUID();

// PAT whose scopes = { role:'owner' }  — no `tools` array.
const patNoTools = `eruq_pat_${randomBytes(24).toString("base64url")}`;
// PAT whose scopes = { role:'owner', tools:['run_sql_readonly'] }.
const patWithTools = `eruq_pat_${randomBytes(24).toString("base64url")}`;

let patNoToolsRowId: string | null = null;
let patWithToolsRowId: string | null = null;

const HOST = `mcp-rsql-${tenantId.slice(0, 8)}.test.local`;

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

function listToolsEnvelope(id = 1): object {
  return { jsonrpc: "2.0", id, method: "tools/list" };
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
    tools?: Array<{ name: string }>;
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
  correlationId: string,
): Promise<Array<{ kind: string; payload: unknown }>> {
  return sql<Array<{ kind: string; payload: unknown }>>`
    SELECT kind, payload
    FROM audit_payloads
    WHERE tenant_id = ${tId}::uuid AND correlation_id = ${correlationId}::uuid
    ORDER BY created_at ASC
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
        slug: "mcp-rsql",
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
    VALUES (${tenantId}, ${`mcp-rsql-${tenantId.slice(0, 8)}`}, ${HOST}, 'en', 'active',
      ${sql.json({ en: "T", ar: "ت" })}, ${`no-reply@${HOST}`})
  `;

  for (const uid of [userNoToolsId, userWithToolsId]) {
    await sql`
      INSERT INTO "user" (id, email, email_verified)
      VALUES (${uid}, ${`int-${uid.slice(0, 8)}@example.com`}, true)
    `;
    await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
      VALUES (${randomUUID()}, ${tenantId}, ${uid}, 'owner')`;
  }

  const [noToolsRow] = await sql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userNoToolsId}, ${tenantId}, 'no-tools-pat',
      ${hashBearerToken(patNoTools)}, ${patNoTools.slice(9, 17)}, ${sql.json({ role: "owner" })})
    RETURNING id
  `;
  patNoToolsRowId = noToolsRow?.id ?? null;

  const [withToolsRow] = await sql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userWithToolsId}, ${tenantId}, 'with-tools-pat',
      ${hashBearerToken(patWithTools)}, ${patWithTools.slice(9, 17)},
      ${sql.json({ role: "owner", tools: ["run_sql_readonly"] })})
    RETURNING id
  `;
  patWithToolsRowId = withToolsRow?.id ?? null;

  clearTenantCacheForTests();
});

afterAll(async () => {
  await sql`DELETE FROM memberships WHERE tenant_id = ${tenantId}::uuid`;
  await sql`DELETE FROM access_tokens WHERE tenant_id = ${tenantId}::uuid`;
  // audit_log is append-only + trigger-protected; leave as-is. Tenant
  // carries a fresh UUID per run so this never collides with later runs.
  __setBearerLookupDbForTests(null);
  __setTenantLookupLoaderForTests(null);
  __setRedisForTests(null);
  clearTenantCacheForTests();
  await sql.end({ timeout: 5 });
  await drizzleClient.end({ timeout: 5 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MCP run_sql_readonly (locked off) integration", () => {
  it("case 1 — flag off: tool hidden in tools/list", async () => {
    fakeRedis.clear();
    // Flag deliberately NOT stubbed on — verify the env is not "1".
    delete process.env.MCP_RUN_SQL_ENABLED;
    const res = await POST(mcpRequest(listToolsEnvelope(), patNoTools));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    const tools = parsed.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("ping");
    expect(names).toContain("create_product");
    expect(names).not.toContain("run_sql_readonly");
  });

  it("case 2 — flag off: direct invoke rejected with forbidden, no PAT leak", async () => {
    fakeRedis.clear();
    delete process.env.MCP_RUN_SQL_ENABLED;
    const body = callToolEnvelope("run_sql_readonly", {});
    const res = await POST(mcpRequest(body, patNoTools));
    expect(res.status).toBe(200);
    const bodyText = await res.text();

    // F-8 canary: no PAT substring in the wire body (even in the error).
    expect(bodyText.toLowerCase()).not.toContain("eruq_pat_");
    const tail = patNoTools.slice(9);
    expect(bodyText).not.toContain(tail);

    const parsed = parseStreamableHttpBody(bodyText);
    // forbidden maps to JSON-RPC -32003 per errors.ts.
    const errCode =
      parsed.error?.code ??
      (parsed.result?.isError === true ? -32003 : undefined);
    expect(errCode).toBe(-32003);
  });

  it("case 3 — rejection writes an audit row (forbidden)", async () => {
    fakeRedis.clear();
    delete process.env.MCP_RUN_SQL_ENABLED;
    const before = await readAuditLog(tenantId);
    const beforeForbidden = before.filter(
      (r) => r.operation === "mcp.run_sql_readonly" && r.outcome === "failure",
    );

    const body = callToolEnvelope("run_sql_readonly", {});
    const res = await POST(mcpRequest(body, patNoTools));
    await res.text();

    const after = await readAuditLog(tenantId);
    const afterForbidden = after.filter(
      (r) => r.operation === "mcp.run_sql_readonly" && r.outcome === "failure",
    );
    expect(afterForbidden.length).toBe(beforeForbidden.length + 1);
    const newRow = afterForbidden[afterForbidden.length - 1]!;
    expect(newRow.error).toBe(JSON.stringify({ code: "forbidden" }));
    expect(newRow.actor_id).toBe(userNoToolsId);
    expect(newRow.token_id).toBe(patNoToolsRowId);
    expect(newRow.correlation_id).toBeTruthy();

    // `inputForFailure(McpError('forbidden'))` returns undefined → no
    // `input` payload row for this correlation id. Assert on reality.
    const payloads = await readAuditPayloads(tenantId, newRow.correlation_id);
    const inputPayloads = payloads.filter((p) => p.kind === "input");
    expect(inputPayloads.length).toBe(0);
  });

  it("case 4 — flag on + scope present: listed but authorize still rejects", async () => {
    fakeRedis.clear();
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "1");

    // (a) tools/list now includes run_sql_readonly for the scoped PAT.
    const listRes = await POST(mcpRequest(listToolsEnvelope(), patWithTools));
    expect(listRes.status).toBe(200);
    const listParsed = parseStreamableHttpBody(await listRes.text());
    const names = (listParsed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("run_sql_readonly");

    // (b) direct invoke still rejects with forbidden — authorize is the
    // hard lock in 7.4, regardless of the visibility gate.
    const callBody = callToolEnvelope("run_sql_readonly", {});
    const callRes = await POST(mcpRequest(callBody, patWithTools));
    expect(callRes.status).toBe(200);
    const parsed = parseStreamableHttpBody(await callRes.text());
    const errCode =
      parsed.error?.code ??
      (parsed.result?.isError === true ? -32003 : undefined);
    expect(errCode).toBe(-32003);

    // Rejection audit row written with the scoped PAT as actor.
    const auditRows = await readAuditLog(tenantId);
    const row = auditRows.find(
      (r) =>
        r.operation === "mcp.run_sql_readonly" &&
        r.outcome === "failure" &&
        r.token_id === patWithToolsRowId,
    );
    expect(row).toBeTruthy();
    expect(row!.error).toBe(JSON.stringify({ code: "forbidden" }));
  });

  it("case 5 — flag on + scope absent: still hidden", async () => {
    fakeRedis.clear();
    vi.stubEnv("MCP_RUN_SQL_ENABLED", "1");
    const res = await POST(mcpRequest(listToolsEnvelope(), patNoTools));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    const names = (parsed.result?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("run_sql_readonly");
    // Still hides. Sanity — ping is still there.
    expect(names).toContain("ping");
  });
});
