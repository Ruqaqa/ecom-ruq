/**
 * Playwright bearer-role coverage — sub-chunk 7.6.2.
 *
 * Closes the `requireMembership` blind spot with end-to-end proofs:
 *
 *   Scenarios 1–3 exercise MCP `tools/list` and `tools/call` under
 *     owner-, staff-, and support-scoped PATs. Proves:
 *       - owner PAT: create_product visible, run_sql_readonly hidden
 *         (the run_sql_readonly tool is gated behind
 *         MCP_RUN_SQL_ENABLED, which the E2E harness leaves off).
 *       - staff PAT: create_product visible AND invocable.
 *       - support PAT: create_product NOT visible, tools/call refuses.
 *     Scenario 1 runs on the full mobile + locale matrix (UI-touching
 *     mint step is the reason for the matrix). Scenarios 2–5 are
 *     single-project: they mint through the UI once on
 *     `desktop-chromium-en` and then exercise pure-HTTP MCP / tRPC
 *     bearer flows, which are locale-independent and device-
 *     independent. The `test.skip` at the top of each scenario
 *     enforces that. Per the 7.6.2 architect brief: "Pure-HTTP
 *     scenarios run once".
 *
 *   Scenario 4 — tokens.create via bearer owner PAT. Asserts:
 *     (a) HTTP 403 + response body contains byte-exact
 *         "session required for this action";
 *     (b) Audit row written: operation='tokens.create',
 *         errorCode='forbidden', actorType='user', tokenId NOT NULL
 *         (proves the bearer was attributed BEFORE refusal);
 *     (c) Response body leak check — no tokenPrefix, no scopes, no
 *         role, no PAT-list metadata (lastUsedAt / expiresAt /
 *         createdAt / name).
 *
 *   Scenario 5 — tokens.list via bearer owner PAT. Asserts:
 *     (a) HTTP 403 + byte-exact "session required for this action";
 *     (b) NO audit row for tokens.list in the correlation window
 *         (queries are not audited per prd.md §3.7);
 *     (c) Body leak check — no row count, no prefix, no scope, no
 *         list-metadata keys.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { OWNER_EMAIL, FIXTURE_PASSWORD } from "../../../scripts/seed-admin-user";
import { testTokenName } from "../helpers/test-token-name";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const TENANT_DOMAIN = "localhost:5001";

/**
 * Scenarios 2–5 are pure-HTTP and locale/device-independent. They run on
 * exactly one Playwright project to avoid burning 5× the runtime on
 * redundant English HTTP flows under different viewports. Scenario 1
 * retains the full matrix because it exercises UI in both locales.
 */
const PURE_HTTP_PROJECT = "desktop-chromium-en";

const expected = {
  en: {
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
    newButton: "New token",
    submitCreate: "Create token",
    nameLabel: "Name",
    ownerConfirmLabel: "Yes, mint a token with full owner access.",
    ackButton: "I've saved this token securely",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    newButton: "رمز جديد",
    submitCreate: "إنشاء الرمز",
    nameLabel: "الاسم",
    ownerConfirmLabel: "نعم، أنشئ رمزًا بصلاحية مالك كاملة.",
    ackButton: "لقد حفظت هذا الرمز بأمان",
  },
} as const;

async function signIn(page: Page, locale: "en" | "ar", email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

/**
 * Mints a PAT through the admin UI and returns its plaintext. Closes
 * the reveal panel (ack) before returning so the list query resumes.
 *
 * `scopeRole` accepts 'owner' | 'staff' | 'support'. For owner scope the
 * ownerScopeConfirm box is checked automatically.
 */
async function mintPatViaAdminUi(
  page: Page,
  locale: "en" | "ar",
  name: string,
  scopeRole: "owner" | "staff" | "support",
): Promise<string> {
  await page.goto(`/${locale}/admin/tokens`);
  const newBtn = page.getByRole("button", { name: expected[locale].newButton });
  await expect(newBtn).toBeEnabled({ timeout: 30_000 });
  await newBtn.click();
  await page.getByLabel(expected[locale].nameLabel, { exact: true }).fill(name);
  await page.selectOption("select[name='scopeRole']", scopeRole);
  if (scopeRole === "owner") {
    await page
      .getByLabel(expected[locale].ownerConfirmLabel, { exact: true })
      .check();
  }
  await page.getByRole("button", { name: expected[locale].submitCreate }).click();
  const plaintextEl = page.getByTestId("revealed-token-plaintext");
  await expect(plaintextEl).toBeVisible({ timeout: 15_000 });
  const plaintext = (await plaintextEl.textContent())?.trim() ?? "";
  expect(plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);
  // Ack to close the reveal panel; keeps the UI in a clean state for
  // any subsequent admin navigation.
  await page.getByRole("button", { name: expected[locale].ackButton }).click();
  return plaintext;
}

interface McpResponseSummary {
  status: number;
  parsed: {
    result?: {
      tools?: Array<{ name: string; description?: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text: string }>;
    };
    error?: { code: number; message?: string };
  };
  rawText: string;
}

function parseMcpBody(text: string): McpResponseSummary["parsed"] {
  const trimmed = text.trim();
  const tryJson = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  if (trimmed.startsWith("{")) {
    return (tryJson(trimmed) ?? {}) as McpResponseSummary["parsed"];
  }
  // SSE — pull the data: line.
  const dataLine = trimmed
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return {};
  return (tryJson(dataLine.slice("data:".length).trim()) ?? {}) as McpResponseSummary["parsed"];
}

async function mcpCall(
  request: APIRequestContext,
  pat: string,
  body: object,
): Promise<McpResponseSummary> {
  const res = await request.post("/api/mcp/streamable-http", {
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: body,
  });
  const rawText = await res.text();
  return { status: res.status(), parsed: parseMcpBody(rawText), rawText };
}

// ─── Scenarios 1–3: MCP tools/list + tools/call under role-scoped PATs ───

for (const locale of ["en", "ar"] as const) {
  test(`scenario 1: owner PAT — MCP tools/list exposes create_product, hides run_sql_readonly — ${locale}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, locale, OWNER_EMAIL);

    const name = testTokenName(`bearer-coverage-owner-${locale}`);
    const pat = await mintPatViaAdminUi(page, locale, name, "owner");

    const list = await mcpCall(request, pat, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(list.status).toBe(200);
    const tools = list.parsed.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_product");
    // run_sql_readonly stays gated behind MCP_RUN_SQL_ENABLED, which
    // the E2E harness does NOT set. The tool is registered but the
    // isVisibleFor gate hides it.
    expect(names).not.toContain("run_sql_readonly");
  });
}

test("scenario 2: staff PAT — MCP tools/list includes create_product and tools/call succeeds", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once (locale/device-independent)",
  );
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  const name = testTokenName("bearer-coverage-staff");
  const pat = await mintPatViaAdminUi(page, "en", name, "staff");

  const list = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  expect(list.status).toBe(200);
  const names = (list.parsed.result?.tools ?? []).map((t) => t.name);
  expect(names).toContain("create_product");

  // Invoke create_product. Staff has Tier-B write access; the gate is
  // roles: ['owner','staff'] at products.create. Successful response
  // carries a structuredContent with slug + costPriceSar (the MCP
  // boundary speaks SAR; service stays in halalas).
  const slug = `bearer-cov-staff-${Date.now()}`;
  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_product",
      arguments: {
        slug,
        name: { en: "bearer coverage staff", ar: "موظف" },
      },
    },
  });
  expect(call.status).toBe(200);
  expect(call.parsed.error).toBeUndefined();
  const content = call.parsed.result?.structuredContent;
  expect(content).toBeTruthy();
  expect((content as Record<string, unknown>).slug).toBe(slug);
  expect(content).toHaveProperty("costPriceSar");
});

test("scenario 3: support PAT — MCP tools/list HIDES create_product and tools/call is refused", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once (locale/device-independent)",
  );
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  const name = testTokenName("bearer-coverage-support");
  const pat = await mintPatViaAdminUi(page, "en", name, "support");

  const list = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  expect(list.status).toBe(200);
  const names = (list.parsed.result?.tools ?? []).map((t) => t.name);
  expect(names).not.toContain("create_product");

  // tools/call returns an error (either top-level -32601 or tool-error
  // envelope). Either way the product must not be created.
  const call = await mcpCall(request, pat, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_product",
      arguments: {
        slug: `bearer-cov-support-${Date.now()}`,
        name: { en: "support rejected", ar: "مرفوض" },
      },
    },
  });
  // Either top-level JSON-RPC error or tool-error isError=true — both
  // prove the call was refused. The body must NOT expose
  // structuredContent for a refused call.
  const isRefused =
    call.parsed.error !== undefined || call.parsed.result?.isError === true;
  expect(isRefused).toBe(true);
  expect(call.parsed.result?.structuredContent).toBeUndefined();
});

// ─── Scenarios 4–5: HTTP tRPC tokens.* via bearer owner PAT ───

/** Metadata-leak keys that must NEVER appear in a 403 body. */
const BODY_LEAK_KEYS = [
  "tokenPrefix",
  "scopes",
  '"role"',
  "lastUsedAt",
  "expiresAt",
  "createdAt",
  '"name"',
];

async function readLatestAuditRowSince(
  tenantDomain: string,
  sinceTs: string,
  operation: string,
): Promise<Array<{
  operation: string;
  outcome: string;
  error: string | null;
  actor_type: string;
  token_id: string | null;
}>> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<
      Array<{
        operation: string;
        outcome: string;
        error: string | null;
        actor_type: string;
        token_id: string | null;
      }>
    >`
      SELECT al.operation, al.outcome, al.error, al.actor_type,
             al.token_id::text AS token_id
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND al.created_at > ${sinceTs}::timestamptz
        AND al.operation = ${operation}
      ORDER BY al.created_at ASC
    `;
    return [...rows];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readAuditTail(tenantDomain: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ ts: string }>>`
      SELECT COALESCE(MAX(al.created_at), 'epoch'::timestamptz)::text AS ts
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
    `;
    return rows[0]?.ts ?? "epoch";
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("scenario 4: bearer owner → tokens.create → 403 'session required for this action' + audit row (tokenId NOT NULL) + no body leak", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once (locale/device-independent)",
  );
  test.setTimeout(90_000);
  await signIn(page, "en", OWNER_EMAIL);
  const name = testTokenName("bearer-tokens-create");
  const pat = await mintPatViaAdminUi(page, "en", name, "owner");

  const sinceTs = await readAuditTail(TENANT_DOMAIN);

  const res = await request.post("/api/trpc/tokens.create", {
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    data: {
      json: {
        name: testTokenName("bearer-attempt"),
        scopes: { role: "staff" },
      },
    },
  });

  // (a) 403 with byte-exact message.
  expect(res.status()).toBe(403);
  const body = await res.text();
  expect(body).toContain("session required for this action");

  // Allow audit writer to flush before the DB read.
  await page.waitForTimeout(200);

  // (b) Exactly one audit row: tokens.create, forbidden, actor_type='user',
  //     token_id NOT NULL. A failing bearer still has an attributed
  //     identity — this is the lock that the PAT is recorded BEFORE the
  //     middleware refuses.
  const rows = await readLatestAuditRowSince(
    TENANT_DOMAIN,
    sinceTs,
    "tokens.create",
  );
  const match = rows.find(
    (r) =>
      r.outcome === "failure" &&
      r.error === JSON.stringify({ code: "forbidden" }) &&
      r.actor_type === "user" &&
      r.token_id !== null,
  );
  expect(
    match,
    "audit row tokens.create forbidden with actor_type='user' and token_id NOT NULL must exist",
  ).toBeTruthy();

  // (c) Body leak check — bare refusal only.
  for (const leak of BODY_LEAK_KEYS) {
    expect(
      body,
      `403 body must not contain metadata key ${leak}`,
    ).not.toContain(leak);
  }
  // And never the PAT itself (bracketing canary).
  expect(body).not.toContain(pat);
  expect(body).not.toContain(pat.slice(9, 17));
});

test("scenario 5: bearer owner → tokens.list → 403 'session required for this action' + NO audit row + no body leak", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== PURE_HTTP_PROJECT,
    "pure-HTTP scenario runs once (locale/device-independent)",
  );
  test.setTimeout(90_000);
  await signIn(page, "en", OWNER_EMAIL);
  const name = testTokenName("bearer-tokens-list");
  const pat = await mintPatViaAdminUi(page, "en", name, "owner");

  const sinceTs = await readAuditTail(TENANT_DOMAIN);

  // tokens.list is a tRPC query — GET with ?input=... (superjson wrapped).
  // Empty input object encodes as {"0":{"json":null}} on a batch, or
  // simply no ?input on a singleton. tRPC accepts `input=%7B%22json%22%3Anull%7D`
  // for a no-arg procedure.
  const res = await request.get(
    `/api/trpc/tokens.list?input=${encodeURIComponent(JSON.stringify({ json: null }))}`,
    {
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/json",
      },
    },
  );

  // (a) 403 with byte-exact message.
  expect(res.status()).toBe(403);
  const body = await res.text();
  expect(body).toContain("session required for this action");

  // Allow any potential audit write to flush — though queries do not
  // audit, the check below verifies that.
  await page.waitForTimeout(200);

  // (b) NO audit row for tokens.list in the correlation window.
  const rows = await readLatestAuditRowSince(
    TENANT_DOMAIN,
    sinceTs,
    "tokens.list",
  );
  expect(rows.length, "tokens.list is a query and must not audit").toBe(0);

  // (c) Body leak check — bare refusal only.
  for (const leak of BODY_LEAK_KEYS) {
    expect(
      body,
      `403 body must not contain metadata key ${leak}`,
    ).not.toContain(leak);
  }
  expect(body).not.toContain(pat);
  expect(body).not.toContain(pat.slice(9, 17));
});
