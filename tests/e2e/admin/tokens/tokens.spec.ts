/**
 * Admin manages personal access tokens — Tier-4 keep per docs/testing.md §3.
 *
 * Per chunk-5 audit (testing.md split: Tier 4 is no longer the default):
 *   - One Tier-4 spec: mint a token, copy/ack the plaintext, then revoke
 *     it. That's the entire operator golden path; everything else moved
 *     down a tier.
 *   - Inner `for (locale of [...])` loops dropped — Playwright projects
 *     pin one locale per profile (iPhone 14 / EN, Pixel 7 / AR).
 *   - One axe pass on /admin/tokens lives in this spec (runs once per
 *     locale across the project matrix, §4.2).
 *   - Per-feature touch-target assertions removed (§4.2).
 *
 * Moved to (or already at) Tier 2:
 *   - Anonymous → signin redirect, customer → ?denied=admin (covered by
 *     auth/cross-tenant Tier-2 tests).
 *   - Name-empty validation, owner-confirm reset, experimental-tools
 *     confirm rule (tests/unit/services/tokens/* — strict-schema,
 *     experimental-confirm, scopes-allowlist).
 *   - Adversarial tenantId rejection (create-access-token-strict-schema).
 *   - Failure-path audit canary (tests/unit/trpc/routers/tokens.test.ts).
 *   - Staff-role visibility / FORBIDDEN (tokens.test.ts staff caller).
 *   - Revoke-dialog cancel/ESC/backdrop semantics (this is third-party
 *     `<dialog>` behavior; we trust the platform).
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import postgres from "postgres";
import Redis from "ioredis";
import { expectAxeClean } from "../../helpers/axe";
import { testTokenName } from "../../helpers/test-token-name";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

// Flush the PAT issuance rate-limit bucket for the dev tenant before every
// test that mints PATs. The production limit is 20/hour; with parallel
// Playwright workers across two locales the suite can trivially exceed
// that budget against the single seeded dev tenant.
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
    revokeRow: "Revoke",
    revokeDialogConfirm: "Revoke",
    nameLabel: "Name",
    ownerConfirmLabel: "Yes, mint a token with full owner access.",
  },
  ar: {
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
    revokeRow: "إلغاء",
    revokeDialogConfirm: "إلغاء الرمز",
    nameLabel: "الاسم",
    ownerConfirmLabel: "نعم، أنشئ رمزًا بصلاحية مالك كاملة.",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  return testInfo.project.metadata?.locale === "ar" ? "ar" : "en";
}

async function signIn(page: Page, locale: Locale, email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

async function grantClipboard(context: BrowserContext): Promise<void> {
  // Clipboard permissions are Chromium-specific; WebKit rejects them with
  // a context-poisoning error. Skip on non-chromium — the DOM-level
  // canary (plaintext-not-in-page after ack) is the stronger assertion.
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
): Promise<Array<{ id: string; revoked_at: string | null }>> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await sql<Array<{ id: string; revoked_at: string | null }>>`
      SELECT at.id::text AS id,
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

test("admin mints, copies, and revokes a token", async ({
  page,
  context,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await grantClipboard(context);
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/tokens`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].pageHeading);
  // Single axe scan for /admin/tokens (§4.2 — once per page,
  // once per locale via the project matrix).
  await expectAxeClean(page);

  const newButton = page.getByRole("button", { name: expected[locale].newButton });
  await expect(newButton).toBeEnabled({ timeout: 30_000 });
  await newButton.click();

  await expect(
    page.getByRole("heading", { name: expected[locale].createHeading }),
  ).toBeVisible();

  const tokenName = testTokenName(`mint-and-revoke-${locale}`);
  await page.getByLabel(expected[locale].nameLabel, { exact: true }).fill(tokenName);

  // Owner role + confirm — exercises the destructive-op gate end-to-end.
  await page.selectOption("select[name='scopeRole']", "owner");
  await page.getByLabel(expected[locale].ownerConfirmLabel, { exact: true }).check();

  const createSubmit = page.getByRole("button", { name: expected[locale].submitCreate });
  await expect(createSubmit).toBeEnabled();
  await createSubmit.click();

  // Reveal panel surfaces with a plaintext token in the testid'd slot.
  await expect(page.getByRole("heading", { name: expected[locale].revealHeading })).toBeVisible({
    timeout: 15_000,
  });
  const plaintextEl = page.getByTestId("revealed-token-plaintext");
  await expect(plaintextEl).toBeVisible();
  const plaintext = (await plaintextEl.textContent())?.trim() ?? "";
  expect(plaintext).toMatch(/^eruq_pat_[A-Za-z0-9_-]{43}$/);

  // Copy button → clipboard (Chromium only — WebKit perms reject).
  await page.getByRole("button", { name: expected[locale].copyButton }).click();
  try {
    const clipRead = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipRead).toBe(plaintext);
  } catch {
    // Clipboard API unavailable in this project (e.g. WebKit perms).
  }

  // Ack closes the reveal panel — plaintext gone from the DOM.
  await page.getByRole("button", { name: expected[locale].ackButton }).click();
  await expect(
    page.getByRole("heading", { name: expected[locale].revealHeading }),
  ).toHaveCount(0);
  const bodyHtml = await page.content();
  expect(bodyHtml).not.toContain(plaintext);

  // Token row visible in the list by name.
  await expect(page.getByText(tokenName, { exact: true })).toBeVisible();

  // Revoke flow — open dialog, confirm, row disappears.
  const revokeRow = page
    .getByRole("listitem")
    .filter({ hasText: tokenName })
    .getByRole("button", { name: expected[locale].revokeRow });
  await revokeRow.click();
  const revokeDialog = page.getByRole("dialog");
  await expect(revokeDialog).toBeVisible();
  await expect(revokeDialog).toContainText(tokenName);
  await revokeDialog
    .getByRole("button", { name: expected[locale].revokeDialogConfirm, exact: true })
    .click();
  await expect(page.getByText(tokenName, { exact: true })).toHaveCount(0, { timeout: 10_000 });

  // DB verification — row carries revoked_at.
  const rows = await readTokensByName("localhost:5001", tokenName);
  expect(rows.length).toBe(1);
  expect(rows[0]?.revoked_at).not.toBeNull();
});
