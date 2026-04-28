/**
 * Chunk 1a.4.2 — End-to-end: MCP `set_product_categories` round-trip
 * (Block 6, pure-HTTP, single project).
 *
 * Mint an owner PAT, then drive create_product + create_category +
 * set_product_categories + listForProduct through the MCP HTTP
 * endpoint. Verifies that duplicate ids are silently deduped in the
 * audit `after`.
 *
 * Coverage-lint substring contract: `set_product_categories` and
 * `products.setCategories` (set_product_categories, products.setCategories).
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

async function cleanupBySlugs(
  productSlug: string,
  categorySlugs: ReadonlyArray<string>,
): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM products WHERE slug = ${productSlug}`;
    if (categorySlugs.length > 0) {
      await sql`DELETE FROM categories WHERE slug = ANY(${sql.array(categorySlugs as string[])})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("MCP set_product_categories round-trip dedupes duplicate ids", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(90_000);
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-pcat"));

  const productSlug = `pcat-prod-${randomUUID().slice(0, 8)}`;
  const cat1Slug = `pcat-c1-${randomUUID().slice(0, 8)}`;
  const cat2Slug = `pcat-c2-${randomUUID().slice(0, 8)}`;
  const cat3Slug = `pcat-c3-${randomUUID().slice(0, 8)}`;
  try {
    // 1. Create product.
    const createdProd = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_product",
        arguments: {
          slug: productSlug,
          name: { en: "MCP Prod", ar: "منتج" },
        },
      },
    });
    const prodId = (
      createdProd.parsed.result?.structuredContent as { id?: string }
    )?.id;
    const prodUpdatedAt = (
      createdProd.parsed.result?.structuredContent as { updatedAt?: string }
    )?.updatedAt;
    expect(prodId).toBeTruthy();
    expect(prodUpdatedAt).toBeTruthy();

    // 2. Create three categories.
    const ids: string[] = [];
    for (const slug of [cat1Slug, cat2Slug, cat3Slug]) {
      const c = await mcpCall(request, pat, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_category",
          arguments: {
            slug,
            name: { en: slug, ar: slug },
          },
        },
      });
      const id = (c.parsed.result?.structuredContent as { id?: string })?.id;
      expect(id).toBeTruthy();
      ids.push(id!);
    }
    const [c1, c2, c3] = ids;
    void c3; // c3 is created but not attached — used to verify dedupe-only

    // 3. set_product_categories with duplicates: [c1, c1, c2] dedupes
    //    to {c1, c2} in the audit `after`.
    const setRes = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "set_product_categories",
        arguments: {
          productId: prodId,
          expectedUpdatedAt: prodUpdatedAt,
          categoryIds: [c1, c1, c2],
        },
      },
    });
    expect(setRes.parsed.error).toBeUndefined();
    expect(setRes.parsed.result?.isError).not.toBe(true);
    const after = (
      setRes.parsed.result?.structuredContent as {
        after?: { categories: Array<{ id: string; slug: string }> };
      }
    )?.after;
    expect(after?.categories).toHaveLength(2);
    expect(after?.categories.map((c) => c.id).sort()).toEqual(
      [c1, c2].sort(),
    );
  } finally {
    await cleanupBySlugs(productSlug, [cat1Slug, cat2Slug, cat3Slug]);
  }
});
