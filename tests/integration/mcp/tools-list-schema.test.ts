/**
 * Integration test — `tools/list` MUST advertise real JSON Schema for
 * each tool's `inputSchema` (sub-chunk 7.5 fix).
 *
 * Before this fix, the registry emitted `{ type: "object" }` for every
 * tool, so MCP clients (Claude Desktop, Claude Code) could not introspect
 * parameter shapes and had to guess field names. Every guess failed.
 *
 * This is the wire-shape contract for JSON Schema crossing the MCP
 * transport — kept as a Tier-3 test because the regression mode is
 * silent (clients break, server doesn't). Scope is intentionally tight:
 * one empty-schema sample (ping), one non-empty sample (create_product),
 * one nested-object proof. Anonymous reject is covered by mcp-ping
 * case 4 — not duplicated here.
 */
import {
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
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

const tenantId = randomUUID();
const userOwnerId = randomUUID();
const patOwner = `eruq_pat_${randomBytes(24).toString("base64url")}`;

const HOST = `mcp-tlist-${tenantId.slice(0, 8)}.test.local`;

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

interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function parseStreamableHttpBody(text: string): {
  id?: unknown;
  result?: { tools?: AdvertisedTool[] };
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

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER)
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");

  await sql`SELECT 1`;

  __setBearerLookupDbForTests(db);
  __setRedisForTests(fakeRedis as unknown as import("ioredis").default);

  __setTenantLookupLoaderForTests(async (host) => {
    if (host === HOST) {
      return {
        id: tenantId,
        slug: "mcp-tlist",
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
    VALUES (${tenantId}, ${`mcp-tlist-${tenantId.slice(0, 8)}`}, ${HOST}, 'en', 'active',
      ${sql.json({ en: "T", ar: "ت" })}, ${`no-reply@${HOST}`})
  `;

  await sql`
    INSERT INTO "user" (id, email, email_verified)
    VALUES (${userOwnerId}, ${`int-${userOwnerId.slice(0, 8)}@example.com`}, true)
  `;
  await sql`INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantId}, ${userOwnerId}, 'owner')`;

  await sql`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (${userOwnerId}, ${tenantId}, 'owner-pat',
      ${hashBearerToken(patOwner)}, ${patOwner.slice(9, 17)}, ${sql.json({ role: "owner" })})
  `;

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

describe("MCP tools/list advertises real JSON Schema per tool", () => {
  it("ping: inputSchema is type:object with empty properties and additionalProperties:false", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(listToolsEnvelope(1), patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    const tools = parsed.result?.tools ?? [];
    const ping = tools.find((t) => t.name === "ping");
    expect(ping).toBeTruthy();
    expect(ping!.inputSchema).toBeTruthy();
    expect(ping!.inputSchema.type).toBe("object");
    expect(ping!.inputSchema.properties).toBeTruthy();
    expect(Object.keys(ping!.inputSchema.properties as object)).toHaveLength(0);
    expect(ping!.inputSchema.additionalProperties).toBe(false);
  });

  it("create_product: inputSchema has non-empty properties, required includes slug+name, additionalProperties:false", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(listToolsEnvelope(2), patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    const tools = parsed.result?.tools ?? [];
    const createProduct = tools.find((t) => t.name === "create_product");
    expect(createProduct).toBeTruthy();

    const sch = createProduct!.inputSchema;
    expect(sch.type).toBe("object");
    expect(sch.additionalProperties).toBe(false);

    const props = sch.properties as Record<string, unknown>;
    expect(props).toBeTruthy();
    // At least these caller-visible fields must be present in properties.
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "slug",
        "name",
        "description",
        "status",
      ]),
    );

    const required = sch.required as string[];
    expect(Array.isArray(required)).toBe(true);
    // JSON Schema 'required' is semantically unordered — use arrayContaining.
    // slug has no default; name has no default; both must be required.
    // status has .default() and so is NOT required on the caller side.
    // description is .nullish() → optional.
    expect(required).toEqual(expect.arrayContaining(["slug", "name"]));
    expect(required).not.toContain("description");
  });

  it("create_product: nested `name` property is its own object schema with required:['en','ar']", async () => {
    fakeRedis.clear();
    const res = await POST(mcpRequest(listToolsEnvelope(3), patOwner));
    expect(res.status).toBe(200);
    const parsed = parseStreamableHttpBody(await res.text());
    const tools = parsed.result?.tools ?? [];
    const createProduct = tools.find((t) => t.name === "create_product");
    expect(createProduct).toBeTruthy();

    const props = createProduct!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const nameProp = props.name;
    expect(nameProp).toBeTruthy();
    expect(nameProp!.type).toBe("object");
    const nameProps = nameProp!.properties as Record<string, unknown>;
    expect(nameProps).toBeTruthy();
    expect(Object.keys(nameProps)).toEqual(
      expect.arrayContaining(["en", "ar"]),
    );
    const nameRequired = nameProp!.required as string[];
    expect(Array.isArray(nameRequired)).toBe(true);
    expect(nameRequired).toEqual(expect.arrayContaining(["en", "ar"]));
  });

});
