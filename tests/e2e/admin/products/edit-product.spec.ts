/**
 * Admin edits a product — Tier-4 keep per docs/testing.md §3.
 *
 * The §3 reason this spec earns Tier 4 is the OCC stale-write banner:
 * the integration of form serialization, expectedUpdatedAt round-trip,
 * server-side comparison, and visible banner can only be verified end-
 * to-end. Everything else trims down per the chunk-2 audit:
 *   - Inner `for (locale of [...])` loops dropped (project pins locale).
 *   - One axe pass per the /admin/products/[id] page (in happy path).
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - Slug-collision, anonymous redirect, customer redirect, staff Tier-B
 *     hide, discard-confirm dialog, audit canary-leak — all covered at
 *     Tier 2 (services + tRPC routers + audit-trail tests).
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const expected = {
  en: {
    signInSubmit: "Sign in",
    editTitle: "Edit product",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    editTitle: "تعديل المنتج",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
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

async function seedProduct(opts?: {
  costPriceMinor?: number | null;
  nameEn?: string;
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `e2e-edit-${randomUUID().slice(0, 8)}`;
    const name = {
      en: opts?.nameEn ?? `EditEN-${randomUUID().slice(0, 6)}`,
      ar: `EditAR-${randomUUID().slice(0, 6)}`,
    };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status, cost_price_minor)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json(name)},
        'draft',
        ${opts?.costPriceMinor ?? null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function bumpUpdatedAt(productId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE products SET updated_at = now() + interval '1 second' WHERE id = ${productId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readProductRow(productId: string): Promise<{ status: string; cost_price_minor: number | null; name: { en: string; ar: string } } | undefined> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ status: string; cost_price_minor: number | null; name: { en: string; ar: string } }>>`
      SELECT status, cost_price_minor, name FROM products WHERE id = ${productId}
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("owner edits a product happy path", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  // Seed in halalas (12345 = 123.45 SAR). The form displays riyals;
  // payload converts back to halalas before reaching the service.
  const seeded = await seedProduct({ costPriceMinor: 12345 });
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/products/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected[locale].editTitle,
  );

  // Form is pre-filled — cost-price field is rendered for owner.
  await expect(page.locator("#product-cost-price")).toHaveValue("123.45");

  // Submit button starts disabled (no edits yet).
  const submit = page.getByTestId("edit-product-submit");
  await expect(submit).toBeDisabled();

  // Edit name + status + cost price.
  const newNameEn = `Edited-${Date.now()}`;
  await page.locator("#product-name-en").fill(newNameEn);
  await page.locator("#product-status").selectOption({ value: "active" });
  await page.locator("#product-cost-price").fill("250.50");

  await expect(submit).toBeEnabled();
  // Single axe scan for /admin/products/[id] (§4.2 — once per page,
  // once per locale via the project matrix).
  await expectAxeClean(page);

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?updatedId=`),
      { timeout: 15_000 },
    ),
    submit.click(),
  ]);
  await expect(page.getByTestId("updated-product-message")).toBeVisible();

  const row = await readProductRow(seeded.id);
  expect(row?.status).toBe("active");
  expect(row?.cost_price_minor).toBe(25050);
  expect(row?.name.en).toBe(newNameEn);
});

test("stale OCC token surfaces stale-write banner; row not destructively overwritten", async ({
  page,
}, testInfo) => {
  // The reason this spec is at Tier 4 (per docs/testing.md §3). Single
  // project run is enough — the OCC race is wire-shape integration,
  // locale-independent.
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — OCC race is locale-independent",
  );
  const seeded = await seedProduct({ nameEn: "Pristine" });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);

  // Out-of-band: bump updated_at so the form's expectedUpdatedAt is stale.
  await bumpUpdatedAt(seeded.id);

  await page.locator("#product-name-en").fill("ShouldNotApply");
  await page.getByTestId("edit-product-submit").click();
  await expect(page.getByTestId("edit-product-stale-write")).toBeVisible();

  const row = await readProductRow(seeded.id);
  expect(row?.name.en).toBe("Pristine");
});
