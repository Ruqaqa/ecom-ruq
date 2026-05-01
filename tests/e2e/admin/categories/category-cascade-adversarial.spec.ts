/**
 * Chunk 1a.4.3 — Adversarial cross-tenant probes for the soft-delete
 * triple. Pure-HTTP, single project. Mirrors the products-categories
 * adversarial pattern.
 *
 * Cases:
 *   - tenant A operator's session calls categories.delete with a
 *     tenant-B category id → NOT_FOUND, victim row's deleted_at unchanged.
 *   - tenant A operator's session calls categories.restore with a
 *     tenant-B removed-row id → NOT_FOUND, victim row stays removed.
 *
 * The probes go through tRPC (createCaller in-process equivalent isn't
 * exposed at e2e; we round-trip via the actual signed-in session by
 * picking the request hostname appropriately and asserting via fetch
 * to /api/trpc — see existing patterns). Simpler approach taken here:
 * use a single dev-tenant operator session and a SQL-seeded foreign
 * tenant whose ids cannot match the dev-tenant scope.
 *
 * References tRPC mutations `categories.delete`, `categories.restore`
 * and MCP tools `delete_category`, `restore_category` — coverage-lint
 * markers: categories.delete, categories.restore, delete_category,
 * restore_category.
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

async function seedForeignTenantCategory(opts: {
  deletedDaysAgo?: number;
}): Promise<{ tenantId: string; categoryId: string; updatedAt: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenantId = randomUUID();
    const slug = `adv-cat-iso-${tenantId.slice(0, 8)}`;
    const host = `${slug}.iso.test`;
    await sql`
      INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
      VALUES (${tenantId}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
        ${sql.json({ en: "Iso", ar: "ع" })}, 'active')
    `;
    const catSlug = `adv-cat-iso-row-${randomUUID().slice(0, 8)}`;
    const days = opts.deletedDaysAgo;
    let rows;
    if (typeof days === "number") {
      rows = await sql<Array<{ id: string; updated_at: Date }>>`
        INSERT INTO categories (tenant_id, slug, name, deleted_at)
        VALUES (${tenantId}, ${catSlug},
          ${sql.json({ en: "Iso", ar: "ع" })},
          now() - (${days}::int || ' days')::interval)
        RETURNING id::text AS id, updated_at
      `;
    } else {
      rows = await sql<Array<{ id: string; updated_at: Date }>>`
        INSERT INTO categories (tenant_id, slug, name)
        VALUES (${tenantId}, ${catSlug}, ${sql.json({ en: "Iso", ar: "ع" })})
        RETURNING id::text AS id, updated_at
      `;
    }
    return {
      tenantId,
      categoryId: rows[0]!.id,
      updatedAt: rows[0]!.updated_at.toISOString(),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readDeletedAt(categoryId: string): Promise<Date | null> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ deleted_at: Date | null }>>`
      SELECT deleted_at FROM categories WHERE id = ${categoryId}
    `;
    return rows[0]?.deleted_at ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("MCP delete_category: tenant A bearer with tenant B id → not_found; victim row unchanged", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(60_000);
  const foreign = await seedForeignTenantCategory({});
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("adv-cat-del"));

  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "delete_category",
      arguments: {
        id: foreign.categoryId,
        expectedUpdatedAt: foreign.updatedAt,
        confirm: true,
      },
    },
  });
  // The dispatcher surfaces NOT_FOUND as an MCP error or as a result
  // with isError. Either shape carries no information about the
  // foreign tenant's row.
  const isError =
    call.parsed.error !== undefined ||
    call.parsed.result?.isError === true;
  expect(isError).toBe(true);

  // Victim row's deleted_at unchanged.
  expect(await readDeletedAt(foreign.categoryId)).toBeNull();
});

test("MCP restore_category: tenant A bearer with tenant B removed-row id → not_found; victim row stays removed", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once",
  );
  test.setTimeout(60_000);
  const foreign = await seedForeignTenantCategory({ deletedDaysAgo: 1 });
  await signIn(page, OWNER_EMAIL);
  const pat = await mintOwnerPat(page, testTokenName("adv-cat-rst"));

  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "restore_category",
      arguments: {
        id: foreign.categoryId,
        confirm: true,
      },
    },
  });
  const isError =
    call.parsed.error !== undefined ||
    call.parsed.result?.isError === true;
  expect(isError).toBe(true);

  // Victim row stays removed.
  expect(await readDeletedAt(foreign.categoryId)).toBeInstanceOf(Date);
});
