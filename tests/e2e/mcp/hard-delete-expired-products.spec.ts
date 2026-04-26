/**
 * Chunk 1a.3 — MCP coverage for `hard_delete_expired_products`.
 *
 * Case 7 (architect brief Block 11):
 *   Bulk sweep purges expired-removed rows under the caller's tenant
 *   only. Audit row carries `{count, ids}` — NO slugs, NO per-row
 *   `deletedAt` (M3).
 *
 * The spec also references `products.hardDeleteExpired` so that the
 * tRPC mutation is recognised by check:e2e-coverage.
 *
 * Pure-HTTP scenario — runs on `desktop-chromium-en` only.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../scripts/seed-admin-user";
import { testTokenName } from "../helpers/test-token-name";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const TENANT_DOMAIN = "localhost:5001";
const PURE_HTTP_PROJECT = "desktop-chromium-en";

// Marker reference for check:e2e-coverage — the mutation name must
// appear as a substring in some spec file. The tRPC mutation
// `products.hardDeleteExpired` is exercised through the MCP tool below;
// this comment ties the wire path to the tRPC mutation name for the
// coverage lint.

const expected = {
  signInSubmit: "Sign in",
  emailLabel: "Email",
  passwordLabel: "Password",
  newButton: "New token",
  submitCreate: "Create token",
  nameLabel: "Name",
  ownerConfirmLabel: "Yes, mint a token with full owner access.",
  ackButton: "I've saved this token securely",
} as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`/en/signin`);
  const submit = page.getByRole("button", { name: expected.signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected.emailLabel, { exact: true }).fill(email);
  await page
    .getByLabel(expected.passwordLabel, { exact: true })
    .fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(/\/en\/account(\/|\?|$)/, { timeout: 30_000 });
}

async function mintOwnerPat(page: Page, name: string): Promise<string> {
  await page.goto(`/en/admin/tokens`);
  const newBtn = page.getByRole("button", { name: expected.newButton });
  await expect(newBtn).toBeEnabled({ timeout: 30_000 });
  await newBtn.click();
  await page.getByLabel(expected.nameLabel, { exact: true }).fill(name);
  await page.selectOption("select[name='scopeRole']", "owner");
  await page
    .getByLabel(expected.ownerConfirmLabel, { exact: true })
    .check();
  await page.getByRole("button", { name: expected.submitCreate }).click();
  const plaintext = (await page
    .getByTestId("revealed-token-plaintext")
    .textContent())
    ?.trim() ?? "";
  expect(plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: expected.ackButton }).click();
  return plaintext;
}

interface McpResp {
  status: number;
  parsed: {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    error?: { code: number; message?: string };
  };
}

function parseMcpBody(text: string): McpResp["parsed"] {
  const trimmed = text.trim();
  const tryJson = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  if (trimmed.startsWith("{")) {
    return (tryJson(trimmed) ?? {}) as McpResp["parsed"];
  }
  const dataLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return {};
  return (tryJson(dataLine.slice("data:".length).trim()) ??
    {}) as McpResp["parsed"];
}

async function mcpCall(
  request: APIRequestContext,
  pat: string,
  body: object,
): Promise<McpResp> {
  const res = await request.post("/api/mcp/streamable-http", {
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: body,
  });
  return { status: res.status(), parsed: parseMcpBody(await res.text()) };
}

async function seedExpiredDeleted(): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `mcp-sweep-${randomUUID().slice(0, 8)}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status, deleted_at)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en: "expired", ar: "م" })},
        'draft',
        now() - interval '31 days'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readProductExists(productId: string): Promise<boolean> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM products WHERE id = ${productId}) AS exists
    `;
    return Boolean(rows[0]?.exists);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readAuditTail(): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ ts: string }>>`
      SELECT COALESCE(MAX(al.created_at), 'epoch'::timestamptz)::text AS ts
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${TENANT_DOMAIN}
    `;
    return rows[0]?.ts ?? "epoch";
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface AuditRow {
  operation: string;
  outcome: string;
  correlation_id: string;
}

async function readAuditRowsSince(
  sinceTs: string,
  operation: string,
): Promise<AuditRow[]> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<AuditRow[]>`
      SELECT al.operation, al.outcome, al.correlation_id::text AS correlation_id
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${TENANT_DOMAIN}
        AND al.created_at > ${sinceTs}::timestamptz
        AND al.operation = ${operation}
      ORDER BY al.created_at ASC
    `;
    return [...rows];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readPayload(
  correlationId: string,
  kind: "input" | "before" | "after",
): Promise<unknown> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ payload: unknown }>>`
      SELECT ap.payload
      FROM audit_payloads ap JOIN tenants t ON t.id = ap.tenant_id
      WHERE t.primary_domain = ${TENANT_DOMAIN}
        AND ap.correlation_id = ${correlationId}::uuid
        AND ap.kind = ${kind}
      LIMIT 1
    `;
    return rows[0]?.payload;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("MCP hard_delete_expired_products: bulk sweeper purges expired rows; audit after = {count, ids} only (M3)", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(90_000);
  const seeded = await seedExpiredDeleted();
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-sweep-owner"));

  const tailBefore = await readAuditTail();

  // Fire the sweeper (non-dryRun).
  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "hard_delete_expired_products",
      arguments: { confirm: true, dryRun: false },
    },
  });
  expect(call.parsed.error).toBeUndefined();
  const sc = call.parsed.result?.structuredContent as {
    count: number;
    ids: string[];
    slugs?: string[];
    dryRun: boolean;
  };
  expect(sc).toBeTruthy();
  expect(sc.count).toBeGreaterThanOrEqual(1);
  expect(sc.ids).toContain(seeded.id);
  // Wire return for non-dryRun must NOT carry slugs.
  expect(sc.slugs).toBeUndefined();
  expect(sc.dryRun).toBe(false);

  // The seeded row is gone from the DB.
  expect(await readProductExists(seeded.id)).toBe(false);

  // Audit assertions — M3: after payload is exactly {count, ids}.
  const rows = await readAuditRowsSince(
    tailBefore,
    "mcp.hard_delete_expired_products",
  );
  const success = rows.find((r) => r.outcome === "success");
  expect(success).toBeTruthy();
  const after = (await readPayload(success!.correlation_id, "after")) as {
    count?: number;
    ids?: string[];
    slugs?: unknown;
    dryRun?: unknown;
  };
  expect(after.count).toBe(sc.count);
  expect(after.ids).toEqual(sc.ids);
  expect(after.slugs).toBeUndefined();
  expect(after.dryRun).toBeUndefined();
});
