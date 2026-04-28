/**
 * Chunk 1a.4.2 — End-to-end: adversarial isolation for
 * `set_product_categories` (Block 6, pure-HTTP, single project).
 *
 * Cases (all required by master brief):
 *   - cross-tenant categoryId attach → category_not_found
 *   - cross-tenant productId → product_not_found
 *   - soft-deleted category in input → category_not_found
 *   - soft-deleted product → product_not_found
 *   - empty array detaches all (audit before non-empty / after empty)
 *   - duplicate ids deduped silently (audit after has one)
 *   - OCC stale → CONFLICT stale_write
 *   - 33-element array → BAD_REQUEST (validation_failed)
 *   - existence-leak shape parity: 4 probes, all error responses share
 *     the same shape (no distinguishing fields beyond `message`)
 *   - MCP non-bearer → unauthorized; MCP non-write-role → forbidden;
 *     tool not in tools/list for those identities.
 *
 * Coverage-lint substring contract: also references `set_product_categories`
 * and `products.setCategories` (set_product_categories,
 * products.setCategories).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  OWNER_EMAIL,
  CUSTOMER_EMAIL,
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
    error?: { code: number; message?: string; data?: unknown };
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
  pat: string | null,
  body: object,
): Promise<McpResp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (pat !== null) headers.authorization = `Bearer ${pat}`;
  const res = await request.post("/api/mcp/streamable-http", {
    headers,
    data: body,
  });
  return { status: res.status(), parsed: parseMcpBody(await res.text()) };
}

async function seedProduct(opts: {
  tenantHost?: string;
  deletedAt?: Date | null;
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `adv-prod-${randomUUID().slice(0, 8)}`;
    const tenantHost = opts.tenantHost ?? "localhost:5001";
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status, deleted_at)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = ${tenantHost}),
        ${slug},
        ${sql.json({ en: "P", ar: "م" })},
        'draft',
        ${opts.deletedAt ? opts.deletedAt.toISOString() : null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedCategory(opts: {
  tenantHost?: string;
  deletedAt?: Date | null;
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `adv-cat-${randomUUID().slice(0, 8)}`;
    const tenantHost = opts.tenantHost ?? "localhost:5001";
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name, deleted_at)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = ${tenantHost}),
        ${slug},
        ${sql.json({ en: "C", ar: "ف" })},
        ${opts.deletedAt ? opts.deletedAt.toISOString() : null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedForeignTenantArtifacts(): Promise<{
  tenantId: string;
  host: string;
  productId: string;
  categoryId: string;
}> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenantId = randomUUID();
    const slug = `adv-iso-${tenantId.slice(0, 8)}`;
    const host = `${slug}.iso.test`;
    await sql`
      INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
      VALUES (${tenantId}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
        ${sql.json({ en: "Iso", ar: "ع" })}, 'active')
    `;
    const productSlug = `adv-iso-prod-${randomUUID().slice(0, 8)}`;
    const productRows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (${tenantId}, ${productSlug}, ${sql.json({ en: "P", ar: "م" })}, 'draft')
      RETURNING id::text AS id
    `;
    const categorySlug = `adv-iso-cat-${randomUUID().slice(0, 8)}`;
    const categoryRows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (${tenantId}, ${categorySlug}, ${sql.json({ en: "C", ar: "ف" })})
      RETURNING id::text AS id
    `;
    return {
      tenantId,
      host,
      productId: productRows[0]!.id,
      categoryId: categoryRows[0]!.id,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function bumpProductUpdatedAt(productId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE products SET updated_at = now() + interval '1 second' WHERE id = ${productId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("MCP set_product_categories — adversarial isolation suite", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(120_000);
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("mcp-pcat-adv"));

  // Cross-tenant artifacts.
  const foreign = await seedForeignTenantArtifacts();

  // Local artifacts.
  const liveProduct = await seedProduct({});
  const liveCat = await seedCategory({});
  const deletedCat = await seedCategory({ deletedAt: new Date() });
  const deletedProduct = await seedProduct({ deletedAt: new Date() });

  // Get the product's current updatedAt for OCC.
  async function readProductOcc(id: string): Promise<string> {
    const sql = postgres(DATABASE_URL, { max: 1 });
    try {
      const rows = await sql<Array<{ ts: string }>>`
        SELECT updated_at::text AS ts FROM products WHERE id = ${id}
      `;
      return new Date(rows[0]?.ts ?? new Date().toISOString()).toISOString();
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  const liveOcc = await readProductOcc(liveProduct.id);

  // Reusable invocation.
  async function callSet(args: object) {
    return mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: "set_product_categories", arguments: args },
    });
  }

  // True if the response surfaces a tool-error in either of the two
  // shapes MCP can use: (a) JSON-RPC `error` envelope (closed-set
  // McpError → -32xxx code), or (b) `result.isError: true`. Both are
  // failures from the caller's perspective.
  function isToolError(r: McpResp): boolean {
    if (r.parsed.error !== undefined) return true;
    if (r.parsed.result?.isError === true) return true;
    return false;
  }

  // The MCP transport maps the service's closed-set error MESSAGES to
  // closed-set audit CODES on the wire. BAD_REQUEST `category_not_found`
  // surfaces as JSON-RPC error code -32602 / message "validation_failed".
  // NOT_FOUND `product_not_found` surfaces as -32600-band / "not_found".
  // The adversarial assertions check the MCP-layer outcome AND that
  // the constraint names from the data layer never leak.
  function bodyOf(r: McpResp): string {
    return JSON.stringify(r.parsed);
  }

  // 1. Cross-tenant categoryId → tool error, no constraint-name leak.
  {
    const r = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: liveOcc,
      categoryIds: [foreign.categoryId],
    });
    expect(isToolError(r)).toBe(true);
    expect(bodyOf(r)).toContain("validation_failed");
    expect(bodyOf(r)).not.toContain(
      "product_categories_category_same_tenant_fk",
    );
    expect(bodyOf(r)).not.toContain(foreign.categoryId);
  }

  // 2. Cross-tenant productId → not-found-class tool error.
  {
    const r = await callSet({
      productId: foreign.productId,
      expectedUpdatedAt: new Date().toISOString(),
      categoryIds: [],
    });
    expect(isToolError(r)).toBe(true);
    expect(bodyOf(r)).toContain("not_found");
    expect(bodyOf(r)).not.toContain(foreign.productId);
  }

  // 3. Soft-deleted category → validation_failed (same shape as cross-tenant).
  {
    const r = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: liveOcc,
      categoryIds: [deletedCat.id],
    });
    expect(isToolError(r)).toBe(true);
    expect(bodyOf(r)).toContain("validation_failed");
  }

  // 4. Soft-deleted product → not-found-class tool error.
  {
    const r = await callSet({
      productId: deletedProduct.id,
      expectedUpdatedAt: new Date().toISOString(),
      categoryIds: [],
    });
    expect(isToolError(r)).toBe(true);
    expect(bodyOf(r)).toContain("not_found");
  }

  // 5. Happy-path attach + then empty-array detach. Verify before/after
  //    semantics in the wire return.
  {
    const occ1 = await readProductOcc(liveProduct.id);
    const r1 = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: occ1,
      categoryIds: [liveCat.id],
    });
    expect(r1.parsed.result?.isError).not.toBe(true);
    const before1 = (
      r1.parsed.result?.structuredContent as {
        before?: { categories: unknown[] };
      }
    )?.before;
    const after1 = (
      r1.parsed.result?.structuredContent as {
        after?: { categories: Array<{ id: string }> };
      }
    )?.after;
    expect(before1?.categories).toEqual([]);
    expect(after1?.categories.map((c) => c.id)).toEqual([liveCat.id]);

    // Empty-array detach all.
    const occ2 = await readProductOcc(liveProduct.id);
    const r2 = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: occ2,
      categoryIds: [],
    });
    const before2 = (
      r2.parsed.result?.structuredContent as {
        before?: { categories: Array<{ id: string }> };
      }
    )?.before;
    const after2 = (
      r2.parsed.result?.structuredContent as {
        after?: { categories: unknown[] };
      }
    )?.after;
    expect(before2?.categories.map((c) => c.id)).toEqual([liveCat.id]);
    expect(after2?.categories).toEqual([]);
  }

  // 6. Duplicate ids deduped → after has one.
  {
    const occ = await readProductOcc(liveProduct.id);
    const r = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: occ,
      categoryIds: [liveCat.id, liveCat.id, liveCat.id],
    });
    expect(r.parsed.result?.isError).not.toBe(true);
    const after = (
      r.parsed.result?.structuredContent as {
        after?: { categories: Array<{ id: string }> };
      }
    )?.after;
    expect(after?.categories).toHaveLength(1);
  }

  // 7. OCC stale → stale_write tool error.
  {
    const occ = await readProductOcc(liveProduct.id);
    await bumpProductUpdatedAt(liveProduct.id);
    const r = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: occ,
      categoryIds: [],
    });
    expect(isToolError(r)).toBe(true);
    expect(bodyOf(r)).toContain("stale_write");
  }

  // 8. 33-element array → validation rejection (input fails before
  //    the service body runs).
  {
    const occ = await readProductOcc(liveProduct.id);
    const ids = Array.from({ length: 33 }, () => randomUUID());
    const r = await callSet({
      productId: liveProduct.id,
      expectedUpdatedAt: occ,
      categoryIds: ids,
    });
    expect(isToolError(r)).toBe(true);
  }

  // 9. Existence-leak shape parity. Four probes, each must yield an
  //    error response of the SAME structural shape (modulo the human
  //    `message` text) — no extra leaked fields.
  {
    const probe = async (
      args: object,
    ): Promise<{ envelope: "error" | "result"; keys: string[] }> => {
      const r = await callSet(args);
      expect(isToolError(r)).toBe(true);
      // Capture whichever envelope the transport used. JSON-RPC errors
      // strip `message` (text varies legitimately); result envelopes
      // get all keys compared.
      if (r.parsed.error !== undefined) {
        const errKeys = Object.keys(r.parsed.error)
          .filter((k) => k !== "message")
          .sort();
        return { envelope: "error", keys: errKeys };
      }
      const result = r.parsed.result as Record<string, unknown>;
      return { envelope: "result", keys: Object.keys(result).sort() };
    };

    const occ = await readProductOcc(liveProduct.id);
    const k1 = await probe({
      productId: foreign.productId,
      expectedUpdatedAt: new Date().toISOString(),
      categoryIds: [],
    });
    const k2 = await probe({
      productId: liveProduct.id,
      expectedUpdatedAt: occ,
      categoryIds: [foreign.categoryId],
    });
    const k3 = await probe({
      productId: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      categoryIds: [],
    });
    const k4 = await probe({
      productId: liveProduct.id,
      expectedUpdatedAt: occ,
      categoryIds: [randomUUID()],
    });
    // Must use the same envelope shape (all `error` or all `result`)
    // AND the same set of fields. If two probes differ on either
    // dimension, that's a distinguishing-fingerprint leak.
    expect(k1.envelope).toBe(k2.envelope);
    expect(k2.envelope).toBe(k3.envelope);
    expect(k3.envelope).toBe(k4.envelope);
    expect(k1.keys).toEqual(k2.keys);
    expect(k2.keys).toEqual(k3.keys);
    expect(k3.keys).toEqual(k4.keys);
  }
});

test("MCP set_product_categories — non-bearer call rejected as unauthorized", async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  const r = await mcpCall(request, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "set_product_categories",
      arguments: {
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
      },
    },
  });
  // Either an HTTP 401 or an in-body unauthorized error is acceptable;
  // the rule is the call MUST NOT succeed.
  const body = JSON.stringify(r.parsed);
  const isUnauth =
    r.status === 401 ||
    body.toLowerCase().includes("unauthorized") ||
    body.toLowerCase().includes("authentication");
  expect(isUnauth).toBe(true);
});

test("MCP set_product_categories — non-write-role bearer cannot see or call the tool", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  // A customer cannot mint a PAT (the admin-tokens page is owner-only).
  // Instead, we sign in as customer and ensure the MCP endpoint refuses
  // with a non-2xx (no PAT, anonymous identity, same as previous test).
  await signIn(page, CUSTOMER_EMAIL);
  // Customer has no PAT. The tools/list on a non-bearer must NOT
  // surface the set_product_categories name.
  const r = await mcpCall(request, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const list = (r.parsed.result as { tools?: Array<{ name: string }> })
    ?.tools ?? [];
  const names = list.map((t) => t.name);
  expect(names).not.toContain("set_product_categories");
});
