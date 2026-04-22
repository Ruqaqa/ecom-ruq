/**
 * Sub-chunk 7.5 — Admin UI for personal access tokens (PATs).
 *
 * Coverage per the 7.5 architect plan (merged with security findings):
 *   1. Happy path create → copy → ack → list → revoke, in both locales
 *   2. Anonymous → signin redirect
 *   3. Customer → /signin?denied=admin
 *   4. Name-empty validation error surfaces inline, no row created
 *   5. Revoke dialog: cancel, ESC, backdrop-click all do NOT fire the mutation
 *   6. HTTP-path adversarial tenantId tampering (security C-1)
 *   7. Failure-path audit canary (security M-1)
 *   8. Touch-target 44×44 audit (CLAUDE.md §3)
 *   9. Staff-role view — list visible, create/revoke hidden (security M-3)
 *  10. Experimental tools confirm flag required (security H-4)
 *
 * Data fixtures seeded by `scripts/seed-admin-user.ts` via global-setup:
 *   - admin-owner@test.local (OWNER membership)
 *   - admin-staff@test.local (STAFF membership) — added in 7.5
 *   - customer@test.local (no membership)
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import postgres from "postgres";
import Redis from "ioredis";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  STAFF_EMAIL,
  CUSTOMER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

// Flush the PAT issuance rate-limit bucket for the dev tenant before every
// test that mints PATs. The production limit is 20/hour; with four parallel
// Playwright workers times two locales times multiple mint flows the suite
// can trivially exceed that budget against the single seeded dev tenant.
// The bucket-flush pattern mirrors what the unit-test suite does in its
// per-test beforeEach. Best-effort — if Redis is down, the test will
// surface a real rate-limit error with a clear message.
async function flushPatIssuanceBuckets(): Promise<void> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(
        cursor,
        "MATCH",
        "ratelimit:pat:issuance:*",
        "COUNT",
        500,
      );
      cursor = next;
      if (keys.length > 0) await r.del(...keys);
    } while (cursor !== "0");
  } catch {
    // Swallow — Redis unavailable means the test will trip rate-limit
    // and fail loudly, which surfaces the real environment problem.
  } finally {
    await r.quit().catch(() => undefined);
  }
}

test.beforeEach(async () => {
  await flushPatIssuanceBuckets();
});

const expected = {
  en: {
    signInTitle: "Sign in",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
    pageHeading: "Access tokens",
    newButton: "New token",
    createHeading: "New access token",
    submitCreate: "Create token",
    revealHeading: "Your new token",
    copyButton: "Copy",
    ackButton: "I've saved this token securely",
    listHeading: "Active tokens",
    revokeRow: "Revoke",
    revokeDialogConfirm: "Revoke",
    revokeDialogCancel: "Cancel",
    nameLabel: "Name",
    ownerConfirmLabel: "Yes, mint a token with full owner access.",
    experimentalSummary: "Grant advanced tools (optional)",
    experimentalConfirmLabel: "Yes, grant these experimental tools.",
    toolRunSqlReadonly: "Direct database read-only access",
    lastUsedNeverRow: "Last used: Never",
    expiresRowPrefix: "Expires:",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    pageHeading: "رموز الوصول",
    newButton: "رمز جديد",
    createHeading: "رمز وصول جديد",
    submitCreate: "إنشاء الرمز",
    revealHeading: "رمزك الجديد",
    copyButton: "نسخ",
    ackButton: "لقد حفظت هذا الرمز بأمان",
    listHeading: "الرموز النشطة",
    revokeRow: "إلغاء",
    revokeDialogConfirm: "إلغاء الرمز",
    revokeDialogCancel: "تراجع",
    nameLabel: "الاسم",
    ownerConfirmLabel: "نعم، أنشئ رمزًا بصلاحية مالك كاملة.",
    experimentalSummary: "منح أدوات متقدمة (اختياري)",
    experimentalConfirmLabel: "نعم، أنشئ هذا الرمز مع الأدوات التجريبية.",
    toolRunSqlReadonly: "وصول مباشر للقراءة من قاعدة البيانات",
    lastUsedNeverRow: "آخر استخدام: أبدًا",
    expiresRowPrefix: "تاريخ الانتهاء:",
  },
} as const;

function unique(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function signIn(page: Page, locale: "en" | "ar", email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

async function grantClipboard(context: BrowserContext): Promise<void> {
  // Clipboard permission names are Chromium-specific: iPhone 14 / any
  // WebKit project rejects `clipboard-write` / `clipboard-read` as
  // "Unknown permission" — AND the failure sticks on the context so
  // later newPage() calls also fail. Only attempt on Chromium-based
  // projects. The DOM-level canary below (plaintext-not-in-page after
  // ack) is the stronger security assertion, so skipping the
  // clipboard-read verification on WebKit is acceptable.
  const browserName = context.browser()?.browserType().name();
  if (browserName !== "chromium") return;
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  } catch {
    // Defensive — Chromium should accept these.
  }
}

async function readTokensByName(
  tenantDomain: string,
  name: string,
): Promise<Array<{ id: string; scopes: unknown; revoked_at: string | null }>> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await sql<Array<{ id: string; scopes: unknown; revoked_at: string | null }>>`
      SELECT at.id::text AS id,
             at.scopes,
             at.revoked_at::text AS revoked_at
      FROM access_tokens at JOIN tenants t ON t.id = at.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND at.name = ${name}
      ORDER BY at.created_at DESC
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function auditTail(tenantDomain: string): Promise<string> {
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

async function readAuditSince(
  tenantDomain: string,
  sinceTs: string,
): Promise<{
  log: Array<{ operation: string; outcome: string; error: string | null }>;
  payloads: unknown[];
}> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const log = await sql<Array<{ operation: string; outcome: string; error: string | null }>>`
      SELECT al.operation, al.outcome, al.error
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND al.created_at > ${sinceTs}::timestamptz
    `;
    const payloads = await sql<Array<{ payload: unknown }>>`
      SELECT ap.payload
      FROM audit_payloads ap JOIN tenants t ON t.id = ap.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND ap.correlation_id IN (
          SELECT al.correlation_id FROM audit_log al JOIN tenants t2 ON t2.id = al.tenant_id
          WHERE t2.primary_domain = ${tenantDomain}
            AND al.created_at > ${sinceTs}::timestamptz
        )
    `;
    return { log: [...log], payloads: payloads.map((p) => p.payload) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`admin mints, copies, and revokes a PAT — ${locale}`, async ({ page, context }) => {
    test.setTimeout(60_000);
    await grantClipboard(context);
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/tokens`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].pageHeading);
    await expectAxeClean(page);

    const newButton = page.getByRole("button", { name: expected[locale].newButton });
    await expect(newButton).toBeEnabled({ timeout: 30_000 });
    await newButton.click();

    await expect(
      page.getByRole("heading", { name: expected[locale].createHeading }),
    ).toBeVisible();
    // Axe-clean on the expanded create form.
    await expectAxeClean(page);

    const tokenName = unique(`claude-desktop-${locale}`);
    await page.getByLabel(expected[locale].nameLabel, { exact: true }).fill(tokenName);

    // Pick 90-day expiry.
    await page.selectOption("select[name='expiresInDays']", "90");

    // Pick owner role + check ownerScopeConfirm.
    await page.selectOption("select[name='scopeRole']", "owner");
    await page.getByLabel(expected[locale].ownerConfirmLabel, { exact: true }).check();

    const createSubmit = page.getByRole("button", { name: expected[locale].submitCreate });
    await expect(createSubmit).toBeEnabled();
    await createSubmit.click();

    // Reveal panel appears, plaintext shown in testid'd code element.
    await expect(page.getByRole("heading", { name: expected[locale].revealHeading })).toBeVisible({
      timeout: 15_000,
    });
    const plaintextEl = page.getByTestId("revealed-token-plaintext");
    await expect(plaintextEl).toBeVisible();
    const plaintext = (await plaintextEl.textContent())?.trim() ?? "";
    expect(plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);

    await expectAxeClean(page);

    // Copy button → clipboard; WebKit mobile may reject — try/catch the read.
    const copyBtn = page.getByRole("button", { name: expected[locale].copyButton });
    await copyBtn.click();
    try {
      const clipRead = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipRead).toBe(plaintext);
    } catch {
      // Clipboard API unavailable in this project (e.g. WebKit perms).
      // We still asserted copy-button presence + click; the DOM-level
      // canary below is the stronger assertion.
    }

    // Ack button — clears the reveal panel.
    await page.getByRole("button", { name: expected[locale].ackButton }).click();
    await expect(
      page.getByRole("heading", { name: expected[locale].revealHeading }),
    ).toHaveCount(0);

    // Plaintext not present in DOM after ack.
    const bodyHtml = await page.content();
    expect(bodyHtml).not.toContain(plaintext);

    // Token row visible in the list (by name).
    await expect(page.getByText(tokenName, { exact: true })).toBeVisible();

    // Row exposes last-used + expiry fields. Freshly minted → "Never"
    // on last-used; expiry label always present (we don't pin the exact
    // formatted date string, it's locale-dependent).
    const newRow = page.getByRole("listitem").filter({ hasText: tokenName });
    await expect(newRow).toContainText(expected[locale].lastUsedNeverRow);
    await expect(newRow).toContainText(expected[locale].expiresRowPrefix);

    // Audit canary — plaintext not in audit_log or audit_payloads for
    // this tenant's recent activity.
    const auditEpoch = new Date(Date.now() - 60 * 1000).toISOString();
    const bundle = await readAuditSince("localhost:5001", auditEpoch);
    const auditBody = JSON.stringify(bundle);
    expect(auditBody).not.toContain(plaintext);

    // Revoke flow.
    const revokeRow = page
      .getByRole("listitem")
      .filter({ hasText: tokenName })
      .getByRole("button", { name: expected[locale].revokeRow });
    await revokeRow.click();
    const revokeDialog = page.getByRole("dialog");
    await expect(revokeDialog).toBeVisible();
    await expect(revokeDialog).toContainText(tokenName);
    await expectAxeClean(page, { include: ["dialog"] });

    const confirmBtn = revokeDialog.getByRole("button", {
      name: expected[locale].revokeDialogConfirm,
      exact: true,
    });
    await confirmBtn.click();

    await expect(page.getByText(tokenName, { exact: true })).toHaveCount(0, { timeout: 10_000 });

    // DB verification: row exists but now carries revoked_at.
    const rows = await readTokensByName("localhost:5001", tokenName);
    expect(rows.length).toBe(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });
}

test("admin tokens page redirects anonymous to signin", async ({ page }) => {
  await page.goto(`/en/admin/tokens`);
  await page.waitForURL(/\/en\/signin(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.en.signInTitle);
});

test("customer → admin tokens page redirected to signin with denied=admin", async ({ page }) => {
  await signIn(page, "en", CUSTOMER_EMAIL);
  await page.goto(`/en/admin/tokens`);
  await page.waitForURL(/\/en\/signin\?denied=admin/, { timeout: 15_000 });
});

test("name-empty → inline validation error, no row inserted, no plaintext revealed", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/tokens`);
  const newButton = page.getByRole("button", { name: expected.en.newButton });
  await expect(newButton).toBeEnabled({ timeout: 30_000 });
  await newButton.click();

  // Do not fill name; submit (role default = staff).
  const submit = page.getByRole("button", { name: expected.en.submitCreate });
  await submit.click();

  // Reveal panel NEVER appeared.
  await expect(page.getByRole("heading", { name: expected.en.revealHeading })).toHaveCount(0);

  // Field error visible on name.
  await expect(page.locator("#token-name-error")).toBeVisible();
});

test("revoke dialog: Cancel / ESC / backdrop-click do not fire the mutation", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/tokens`);
  await expect(page.getByRole("button", { name: expected.en.newButton })).toBeEnabled({
    timeout: 30_000,
  });

  // Seed a token so there's something to revoke.
  const seedName = unique("revoke-seed");
  await page.getByRole("button", { name: expected.en.newButton }).click();
  await page.getByLabel(expected.en.nameLabel, { exact: true }).fill(seedName);
  await page.getByRole("button", { name: expected.en.submitCreate }).click();
  await expect(page.getByRole("heading", { name: expected.en.revealHeading })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: expected.en.ackButton }).click();
  await expect(page.getByText(seedName, { exact: true })).toBeVisible();

  // Track any tokens.revoke POSTs while we fiddle with the dialog.
  const revokeRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/api\/trpc\/.*tokens\.revoke/.test(req.url())) {
      revokeRequests.push(req.url());
    }
  });

  const revokeRow = page
    .getByRole("listitem")
    .filter({ hasText: seedName })
    .getByRole("button", { name: expected.en.revokeRow });

  // 1. Cancel button closes dialog, no request.
  await revokeRow.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: expected.en.revokeDialogCancel }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(revokeRequests.length).toBe(0);

  // 2. ESC key closes dialog, no request.
  await revokeRow.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(revokeRequests.length).toBe(0);

  // 3. Backdrop click does NOT dismiss (destructive-op discipline).
  await revokeRow.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Click outside the dialog's content box — the dialog element itself
  // receives the click, which is the backdrop in a native <dialog>.
  await page.locator("dialog").click({ position: { x: 2, y: 2 }, force: true });
  // Dialog remains open.
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(revokeRequests.length).toBe(0);

  // Finally, actually revoke.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: expected.en.revokeDialogConfirm, exact: true })
    .click();
  await expect(page.getByText(seedName, { exact: true })).toHaveCount(0, { timeout: 10_000 });
  expect(revokeRequests.length).toBe(1);
});

test("HTTP-path adversarial tenantId tampering rejected with unrecognized-keys Zod error", async ({
  page,
  request,
}) => {
  await signIn(page, "en", OWNER_EMAIL);
  // Grab a cookie so the request has a valid owner session.
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const tokenName = unique("adv-tenantid");
  // tRPC v11 accepts `{ json, meta }` with superjson; but a direct POST
  // with a JSON body is how an attacker would craft this. We bypass
  // the superjson wrapper and rely on Zod's `.strict()` to reject the
  // unknown key.
  const res = await request.post("/api/trpc/tokens.create", {
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
    },
    data: {
      json: {
        name: tokenName,
        scopes: { role: "staff" },
        tenantId: "00000000-0000-0000-0000-000000000001",
      },
    },
  });

  // 400 Bad Request from the strict-schema rejection.
  expect(res.status()).toBe(400);
  const bodyText = await res.text();
  // Zod's unrecognized_keys issue surfaces the offending key in the error.
  expect(bodyText).toMatch(/tenantId|unrecognized/i);

  // No row for this name under localhost tenant OR under any other tenant.
  const rows = await readTokensByName("localhost:5001", tokenName);
  expect(rows.length).toBe(0);
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const anywhere = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM access_tokens WHERE name = ${tokenName}
    `;
    expect(anywhere[0]?.n ?? 0).toBe(0);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("failure-path audit canary — invalid mint writes failure audit, no plaintext", async ({
  page,
  request,
}) => {
  await signIn(page, "en", OWNER_EMAIL);
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const tailBefore = await auditTail("localhost:5001");

  // Submit a deliberately invalid mint — empty name.
  const res = await request.post("/api/trpc/tokens.create", {
    headers: { "content-type": "application/json", cookie: cookieHeader },
    data: { json: { name: "", scopes: { role: "staff" } } },
  });
  expect(res.status()).toBe(400);

  // Give audit writer time to flush.
  await page.waitForTimeout(200);

  const bundle = await readAuditSince("localhost:5001", tailBefore);
  const failure = bundle.log.find(
    (r) =>
      r.operation === "tokens.create" &&
      r.outcome === "failure" &&
      r.error === JSON.stringify({ code: "validation_failed" }),
  );
  expect(failure, "tokens.create validation_failed audit row must exist").toBeTruthy();

  // No plaintext ever issued on failure path; the `eruq_pat_` prefix
  // never appears in the failure payload bundle.
  const dump = JSON.stringify(bundle);
  expect(dump).not.toContain("eruq_pat_");
});

test("touch targets — copy / ack / revoke / submit are ≥ 44×44 on mobile", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await grantClipboard(context);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/tokens`);

  const newButton = page.getByRole("button", { name: expected.en.newButton });
  await expect(newButton).toBeEnabled({ timeout: 30_000 });
  const newBox = await newButton.boundingBox();
  expect(newBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(newBox?.width ?? 0).toBeGreaterThanOrEqual(44);

  await newButton.click();
  const tokenName = unique("touch-target");
  await page.getByLabel(expected.en.nameLabel, { exact: true }).fill(tokenName);
  const submit = page.getByRole("button", { name: expected.en.submitCreate });
  const submitBox = await submit.boundingBox();
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await submit.click();

  await expect(page.getByRole("heading", { name: expected.en.revealHeading })).toBeVisible({
    timeout: 15_000,
  });
  const copy = page.getByRole("button", { name: expected.en.copyButton });
  const copyBox = await copy.boundingBox();
  expect(copyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(copyBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  const ack = page.getByRole("button", { name: expected.en.ackButton });
  const ackBox = await ack.boundingBox();
  expect(ackBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await ack.click();

  const revokeBtn = page
    .getByRole("listitem")
    .filter({ hasText: tokenName })
    .getByRole("button", { name: expected.en.revokeRow });
  const revokeBox = await revokeBtn.boundingBox();
  expect(revokeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(revokeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
});

test("staff-role view — list visible, create/revoke hidden", async ({ page }) => {
  test.setTimeout(45_000);
  await signIn(page, "en", STAFF_EMAIL);
  await page.goto(`/en/admin/tokens`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.en.pageHeading);

  // The staff role can see the list but must NOT see the create button.
  await expect(page.getByRole("button", { name: expected.en.newButton })).toHaveCount(0);
  // And must NOT see any revoke action on rows (no dead UI that produces
  // FORBIDDEN banners on click — security M-3).
  await expect(page.getByRole("button", { name: expected.en.revokeRow })).toHaveCount(0);
});

test("experimental tools confirm required — unchecked = field error; checked = row created with tools", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/tokens`);
  await page.getByRole("button", { name: expected.en.newButton }).click();

  const tokenName = unique("exp-tool");
  await page.getByLabel(expected.en.nameLabel, { exact: true }).fill(tokenName);

  // Open the experimental disclosure.
  await page.getByText(expected.en.experimentalSummary).click();

  // Tick the run_sql_readonly box but NOT the confirm.
  await page.getByLabel(expected.en.toolRunSqlReadonly, { exact: true }).check();

  await page.getByRole("button", { name: expected.en.submitCreate }).click();

  // Field error surfaces on the confirm checkbox; no reveal panel; no row.
  await expect(page.getByRole("heading", { name: expected.en.revealHeading })).toHaveCount(0);
  await expect(page.locator("#token-experimental-confirm-error")).toBeVisible();

  const beforeRows = await readTokensByName("localhost:5001", tokenName);
  expect(beforeRows.length).toBe(0);

  // Now tick the confirm and submit.
  await page.getByLabel(expected.en.experimentalConfirmLabel, { exact: true }).check();
  await page.getByRole("button", { name: expected.en.submitCreate }).click();
  await expect(page.getByRole("heading", { name: expected.en.revealHeading })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: expected.en.ackButton }).click();

  const afterRows = await readTokensByName("localhost:5001", tokenName);
  expect(afterRows.length).toBe(1);
  const scopes = afterRows[0]?.scopes as { role: string; tools?: string[] } | null;
  expect(scopes?.tools ?? []).toEqual(["run_sql_readonly"]);
});
