/**
 * Chunk 1a.3 — MCP coverage for `delete_product` and `restore_product`.
 *
 * Cases (per architect brief Block 11 cases 5–6):
 *   5. delete_product without `confirm: true` rejects with
 *      validation_failed; the row stays alive.
 *   6. delete_product → restore_product round-trip via MCP;
 *      audit_log carries success rows for both, and the audit
 *      `before`/`after` payloads include `costPriceMinor` (M1).
 *
 * Pure-HTTP scenarios — locale/device-independent, run on
 * `desktop-chromium-en` only. UI is touched once (PAT mint).
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
      content?: Array<{ type: string; text: string }>;
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

async function seedProduct(opts?: {
  costPriceMinor?: number;
}): Promise<{ id: string; slug: string; updatedAt: Date }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `mcp-del-${randomUUID().slice(0, 8)}`;
    const cost = opts?.costPriceMinor ?? null;
    const rows = await sql<
      Array<{ id: string; updated_at: Date }>
    >`
      INSERT INTO products (tenant_id, slug, name, status, cost_price_minor)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en: "MCP del", ar: "م" })},
        'draft',
        ${cost}
      )
      RETURNING id::text AS id, updated_at
    `;
    return { id: rows[0]!.id, slug, updatedAt: rows[0]!.updated_at };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readProductDeletedAt(productId: string): Promise<Date | null> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ deleted_at: Date | null }>>`
      SELECT deleted_at FROM products WHERE id = ${productId}
    `;
    return rows[0]?.deleted_at ?? null;
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
  error: string | null;
  correlation_id: string;
}

async function readAuditRowsSince(
  sinceTs: string,
  operation: string,
): Promise<AuditRow[]> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<AuditRow[]>`
      SELECT al.operation, al.outcome, al.error, al.correlation_id::text AS correlation_id
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

test("MCP delete_product without confirm: validation_failed; row stays alive", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-del-no-confirm"));

  // confirm: false → schema reject. The MCP seam parses input strictly.
  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "delete_product",
      arguments: {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: false,
      },
    },
  });
  const refused =
    call.parsed.error !== undefined || call.parsed.result?.isError === true;
  expect(refused).toBe(true);
  expect(call.parsed.result?.structuredContent).toBeUndefined();

  // Row is unchanged.
  expect(await readProductDeletedAt(seeded.id)).toBeNull();

  // Follow-up list_products call still surfaces it.
  const list = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_products", arguments: { limit: 50 } },
  });
  const items =
    (list.parsed.result?.structuredContent as { items?: Array<{ id: string }> })
      ?.items ?? [];
  expect(items.some((i) => i.id === seeded.id)).toBe(true);
});

test("MCP delete_product → restore_product round-trip; audit before/after carry costPriceMinor (M1)", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(90_000);
  const seeded = await seedProduct({ costPriceMinor: 12345 });
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-del-roundtrip"));

  const tailBefore = await readAuditTail();

  // Delete.
  const del = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "delete_product",
      arguments: {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      },
    },
  });
  expect(del.parsed.error).toBeUndefined();
  expect(del.parsed.result?.isError).not.toBe(true);
  expect(
    (del.parsed.result?.structuredContent as { id?: string })?.id,
  ).toBe(seeded.id);
  expect(await readProductDeletedAt(seeded.id)).toBeInstanceOf(Date);

  // Restore.
  const rst = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "restore_product",
      arguments: { id: seeded.id, confirm: true },
    },
  });
  expect(rst.parsed.error).toBeUndefined();
  expect(rst.parsed.result?.isError).not.toBe(true);
  expect(
    (rst.parsed.result?.structuredContent as { deletedAtIso?: unknown })
      ?.deletedAtIso,
  ).toBeNull();
  expect(await readProductDeletedAt(seeded.id)).toBeNull();

  // Audit assertions.
  const delRows = await readAuditRowsSince(tailBefore, "mcp.delete_product");
  expect(delRows.length).toBeGreaterThan(0);
  const delSuccess = delRows.find((r) => r.outcome === "success");
  expect(delSuccess).toBeTruthy();
  const delBefore = (await readPayload(
    delSuccess!.correlation_id,
    "before",
  )) as { costPriceMinor?: number | null };
  const delAfter = (await readPayload(
    delSuccess!.correlation_id,
    "after",
  )) as { costPriceMinor?: number | null; deletedAt?: unknown };
  // M1: full ProductOwner shape recorded — costPriceMinor present.
  expect(delBefore.costPriceMinor).toBe(12345);
  expect(delAfter.costPriceMinor).toBe(12345);
  expect(delAfter.deletedAt).toBeTruthy();

  const rstRows = await readAuditRowsSince(tailBefore, "mcp.restore_product");
  const rstSuccess = rstRows.find((r) => r.outcome === "success");
  expect(rstSuccess).toBeTruthy();
  const rstAfter = (await readPayload(
    rstSuccess!.correlation_id,
    "after",
  )) as { costPriceMinor?: number | null; deletedAt?: unknown };
  expect(rstAfter.costPriceMinor).toBe(12345);
  expect(rstAfter.deletedAt).toBeNull();
});
