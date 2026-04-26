/**
 * Chunk 1a.4.1 — MCP smoke spec for the new categories surface.
 *
 * Pure-HTTP scenario: mint an owner PAT, then drive create / update /
 * list of categories through the MCP HTTP endpoint with bearer auth.
 * Locale-independent, runs once on `desktop-chromium-en`.
 *
 * Coverage-lint contract: the literal substrings `categories.create`,
 * `categories.update`, `categories.list` MUST appear in this file so
 * `pnpm check:e2e-coverage` ties the tRPC mutations + read to a
 * Playwright reference.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";
import { testTokenName } from "../../helpers/test-token-name";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
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
  await page.getByLabel(expected.ownerConfirmLabel, { exact: true }).check();
  await page.getByRole("button", { name: expected.submitCreate }).click();
  const plaintext = (
    await page.getByTestId("revealed-token-plaintext").textContent()
  )?.trim() ?? "";
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

async function deleteCategoryHard(slug: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM categories WHERE slug = ${slug}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Round-trip the full MCP categories surface: list_categories,
 * create_category, update_category. Tied to the tRPC mutation names
 * via the literals: categories.create, categories.update, categories.list.
 */
test("MCP create_category → update_category → list_categories round-trip", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(90_000);
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-cat-roundtrip"));

  const slug = `cat-mcp-${randomUUID().slice(0, 8)}`;
  try {
    // 1. categories.create equivalent — create_category MCP tool.
    const created = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_category",
        arguments: {
          slug,
          name: { en: "MCP Cat", ar: "تجربة" },
        },
      },
    });
    expect(created.parsed.error).toBeUndefined();
    expect(created.parsed.result?.isError).not.toBe(true);
    const createdId = (
      created.parsed.result?.structuredContent as { id?: string }
    )?.id;
    expect(createdId).toBeTruthy();
    const createdUpdatedAt = (
      created.parsed.result?.structuredContent as { updatedAt?: string }
    )?.updatedAt;
    expect(createdUpdatedAt).toBeTruthy();

    // 2. categories.update equivalent — update_category MCP tool.
    const updated = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "update_category",
        arguments: {
          id: createdId,
          expectedUpdatedAt: createdUpdatedAt,
          position: 5,
        },
      },
    });
    expect(updated.parsed.error).toBeUndefined();
    expect(updated.parsed.result?.isError).not.toBe(true);
    expect(
      (updated.parsed.result?.structuredContent as { position?: number })
        ?.position,
    ).toBe(5);

    // 3. categories.list equivalent — list_categories MCP tool.
    const listed = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_categories", arguments: {} },
    });
    expect(listed.parsed.error).toBeUndefined();
    const items =
      (listed.parsed.result?.structuredContent as {
        items?: Array<{ id: string }>;
      })?.items ?? [];
    expect(items.some((i) => i.id === createdId)).toBe(true);
  } finally {
    await deleteCategoryHard(slug);
  }
});
