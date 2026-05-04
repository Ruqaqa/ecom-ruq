/**
 * Admin creates a product — Tier-4 keep per docs/testing.md §3.
 *
 * Per chunk-2 audit:
 *   - Inner `for (locale of [...])` loops dropped — Playwright projects
 *     pin one locale per profile (iPhone 14 / EN, Pixel 7 / AR).
 *   - One critical-error case kept (121-char slug → inline error). Audit
 *     canary-leak + body-size 413 + slug auto-derive UX moved to (or
 *     already covered at) Tier 2.
 *   - One axe pass on /admin/products/new lives in the happy-path test
 *     (runs once per locale across the project matrix).
 *   - Per-feature touch-target assertions removed (§4.2).
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  CUSTOMER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const expected = {
  en: {
    signInTitle: "Sign in",
    signInSubmit: "Sign in",
    formTitle: "New product",
    submit: "Create product",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInSubmit: "تسجيل الدخول",
    formTitle: "منتج جديد",
    submit: "إنشاء المنتج",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  return testInfo.project.metadata?.locale === "ar" ? "ar" : "en";
}

function unique(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

async function readProductsForTenant(tenantDomain: string, slug: string): Promise<
  Array<{ id: string; tenant_id: string }>
> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await sql<Array<{ id: string; tenant_id: string }>>`
      SELECT p.id, p.tenant_id::text AS tenant_id
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND p.slug = ${slug}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("admin creates a product — happy path", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const slug = unique(`admin-${locale}`).toLowerCase();
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/products/new`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].formTitle);
  const submit = page.getByRole("button", { name: expected[locale].submit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  // Single axe scan for the /admin/products/new page (§4.2 — once per page,
  // once per locale via the project matrix).
  await expectAxeClean(page);

  await page.locator("#product-slug").fill(slug);
  await page.locator("#product-name-en").fill("Sony A7 IV");
  await page.locator("#product-name-ar").fill("سوني");
  await submit.click();

  await page.waitForURL(
    new RegExp(`/${locale}/admin/products\\?createdId=[^&]+`),
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("created-product-message")).toBeVisible();

  const rows = await readProductsForTenant("localhost:5001", slug);
  expect(rows.length).toBe(1);
  expect(rows[0]?.tenant_id).toBeTruthy();
});

test("admin new-product page redirects anonymous to signin", async ({ page }) => {
  await page.goto(`/en/admin/products/new`);
  await page.waitForURL(/\/en\/signin(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.en.signInTitle);
});

test("customer is denied access to admin new-product", async ({ page }) => {
  await signIn(page, "en", CUSTOMER_EMAIL);
  await page.goto(`/en/admin/products/new`);
  await page.waitForURL(/\/en\/signin\?denied=admin/, { timeout: 15_000 });
});

test("121-char slug surfaces inline error and creates no product row", async ({
  page,
}, testInfo) => {
  // The keep-bar critical-error case for create. Bypasses the input's
  // maxLength=120 attribute via DOM evaluate to drive the SERVER's
  // Zod max(120) — proves form → wire → server validation → inline
  // error UI round-trips. The deeper audit-leak canary + body-size
  // 413 are covered at Tier 2 (router + lib layer). Single project
  // run — wire shape is locale-independent.
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — slug-length wire shape is locale-independent",
  );
  const longSlug = unique("toolong").toLowerCase().padEnd(121, "x");
  await signIn(page, "en", OWNER_EMAIL);

  await page.goto(`/en/admin/products/new`);
  const submit = page.getByRole("button", { name: expected.en.submit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });

  // Bypass maxLength=120 via DOM evaluate; dispatch input event so
  // React state catches up.
  await page.locator("#product-slug").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, longSlug);
  await page.locator("#product-name-en").fill("n");
  await page.locator("#product-name-ar").fill("ن");
  await submit.click();

  await expect(page).toHaveURL(/\/admin\/products\/new/);
  await expect(page.locator("#product-slug-error")).toBeVisible();

  const rows = await readProductsForTenant("localhost:5001", longSlug);
  expect(rows.length).toBe(0);
});
