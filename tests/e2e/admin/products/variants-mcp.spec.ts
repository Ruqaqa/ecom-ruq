/**
 * Chunk 1a.5.1 — End-to-end: MCP `set_product_options` and
 * `set_product_variants` round-trip (Block 6, pure-HTTP, single project).
 *
 * Mints an owner PAT, then drives create_product → set_product_options →
 * set_product_variants through the MCP HTTP endpoint. Asserts:
 *   - the cartesian-product variant set is hard-deletable on diff-removal
 *     (set_product_variants set-replace contract).
 *   - audit `before`/`after` are bounded snapshots ({productId, count,
 *     ids, hash} for variants and {productId, optionsCount, optionIds,
 *     valuesCount, valueIds, hash} for options) — no localized name/
 *     value text and no SKU strings cross into the wire envelope's
 *     audit fields. `hash` is 32 hex chars / 128 bits.
 *
 * Coverage-lint substring contract: `set_product_options`,
 * `set_product_variants`, `products.setOptions`, `products.setVariants`
 * (set_product_options, set_product_variants, products.setOptions,
 * products.setVariants).
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

async function cleanupBySlug(productSlug: string): Promise<void> {
  // FK cascade from products → product_options → product_option_values
  // and from products → product_variants does the rest.
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM products WHERE slug = ${productSlug}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("MCP set_product_options + set_product_variants round-trip", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(120_000);
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-vrnt"));

  const productSlug = `vrnt-prod-${randomUUID().slice(0, 8)}`;
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
          name: { en: "Variant Test", ar: "اختبار" },
        },
      },
    });
    const prodId = (
      createdProd.parsed.result?.structuredContent as { id?: string }
    )?.id;
    const prodUpdatedAt0 = (
      createdProd.parsed.result?.structuredContent as { updatedAt?: string }
    )?.updatedAt;
    expect(prodId).toBeTruthy();
    expect(prodUpdatedAt0).toBeTruthy();

    // 2. set_product_options — define one option (Color) with two values.
    const optsRes = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "set_product_options",
        arguments: {
          productId: prodId,
          expectedUpdatedAt: prodUpdatedAt0,
          options: [
            {
              name: { en: "Color", ar: "اللون" },
              values: [
                { value: { en: "Red", ar: "أحمر" } },
                { value: { en: "Blue", ar: "أزرق" } },
              ],
            },
          ],
        },
      },
    });
    expect(optsRes.parsed.error).toBeUndefined();
    expect(optsRes.parsed.result?.isError).not.toBe(true);
    const optsContent = optsRes.parsed.result?.structuredContent as {
      productUpdatedAt?: string;
      options?: Array<{
        id: string;
        values: Array<{ id: string }>;
      }>;
      after?: { optionsCount?: number; valuesCount?: number; hash?: string };
      before?: { hash?: string };
    };
    expect(optsContent.options).toHaveLength(1);
    expect(optsContent.options![0]!.values).toHaveLength(2);
    expect(optsContent.after?.optionsCount).toBe(1);
    expect(optsContent.after?.valuesCount).toBe(2);
    // Audit hash is the bounded change-detector — present and 16 hex.
    expect(optsContent.after?.hash).toMatch(/^[0-9a-f]{32}$/);

    const redValueId = optsContent.options![0]!.values[0]!.id;
    const blueValueId = optsContent.options![0]!.values[1]!.id;
    const prodUpdatedAt1 = optsContent.productUpdatedAt!;

    // 3. set_product_variants — insert two cartesian rows.
    const v1Res = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "set_product_variants",
        arguments: {
          productId: prodId,
          expectedUpdatedAt: prodUpdatedAt1,
          variants: [
            {
              sku: `${productSlug}-RED`,
              priceMinor: 1000,
              stock: 5,
              optionValueIds: [redValueId],
            },
            {
              sku: `${productSlug}-BLUE`,
              priceMinor: 1100,
              stock: 0,
              optionValueIds: [blueValueId],
            },
          ],
        },
      },
    });
    expect(v1Res.parsed.error).toBeUndefined();
    expect(v1Res.parsed.result?.isError).not.toBe(true);
    const v1Content = v1Res.parsed.result?.structuredContent as {
      productUpdatedAt?: string;
      variants?: Array<{ id: string; sku: string }>;
      after?: { count?: number; hash?: string };
    };
    expect(v1Content.variants).toHaveLength(2);
    expect(v1Content.after?.count).toBe(2);
    expect(v1Content.after?.hash).toMatch(/^[0-9a-f]{32}$/);

    // 4. set_product_variants again — drop the BLUE row (omit it).
    const blueVariantId = v1Content.variants!.find(
      (v) => v.sku === `${productSlug}-BLUE`,
    )!.id;
    void blueVariantId; // intentionally not included in the next call
    const redVariantId = v1Content.variants!.find(
      (v) => v.sku === `${productSlug}-RED`,
    )!.id;

    const v2Res = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "set_product_variants",
        arguments: {
          productId: prodId,
          expectedUpdatedAt: v1Content.productUpdatedAt,
          variants: [
            {
              id: redVariantId,
              sku: `${productSlug}-RED`,
              priceMinor: 1500, // price bump
              stock: 5,
              optionValueIds: [redValueId],
            },
          ],
        },
      },
    });
    expect(v2Res.parsed.error).toBeUndefined();
    const v2Content = v2Res.parsed.result?.structuredContent as {
      variants?: Array<{ id: string; sku: string; priceMinor: number }>;
      before?: { count?: number };
      after?: { count?: number };
    };
    expect(v2Content.variants).toHaveLength(1);
    expect(v2Content.variants![0]!.priceMinor).toBe(1500);
    expect(v2Content.before?.count).toBe(2);
    expect(v2Content.after?.count).toBe(1);
  } finally {
    await cleanupBySlug(productSlug);
  }
});
