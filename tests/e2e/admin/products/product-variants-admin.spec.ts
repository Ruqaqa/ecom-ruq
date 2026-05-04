/**
 * End-to-end: admin defines options + edits variants (Tier-4 happy path).
 *
 * Per docs/testing.md §3, the variants surface gets ONE happy-path
 * browser test that exercises the option → variant cascade. Everything
 * else lives at lower tiers:
 *
 *   - Cascade contracts (add/remove option types, value diffs, hard-
 *     delete on omission, cap=100, sku_taken opacity, dup-SKU pin) →
 *     tests/unit/services/variants/* (set-product-options.test.ts,
 *     set-product-options-cascade.test.ts, set-product-variants.test.ts,
 *     validate-variants.test.ts) and tests/unit/trpc/routers/
 *     products-variants-cascade.test.ts.
 *   - State-C collapse, bulk-apply price/stock, expand banner, cap-hit
 *     warning, kebab remove → component-level UI niceties; not on the
 *     critical path.
 *   - Per-keystroke price input controller bug → covered as one focused
 *     follow-up regression test below (no Tier-2 fixture exists for the
 *     React controlled-input bug; that's the only justification).
 *
 * Mobile-first matrix runs this once per device-locale project pinned
 * in playwright.config; no inner-locale loop.
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
    emailLabel: "Email",
    passwordLabel: "Password",
    editTitle: "Edit product",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    editTitle: "تعديل المنتج",
  },
} as const;

function localeFromProject(): "en" | "ar" {
  const name = test.info().project.name;
  return name.endsWith("-ar") ? "ar" : "en";
}

async function signIn(page: Page): Promise<void> {
  const locale = localeFromProject();
  const e = expected[locale];
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: e.signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(e.emailLabel, { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel(e.passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), {
    timeout: 30_000,
  });
}

async function seedProduct(): Promise<{ id: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `e2e-variants-${randomUUID().slice(0, 8)}`;
    const name = {
      en: `VarEN-${randomUUID().slice(0, 6)}`,
      ar: `VarAR-${randomUUID().slice(0, 6)}`,
    };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json(name)},
        'draft'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface DbVariantRow {
  id: string;
  sku: string;
  price_minor: number;
  stock: number;
}

async function readVariants(productId: string): Promise<DbVariantRow[]> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<DbVariantRow[]>`
      SELECT id::text AS id, sku, price_minor, stock
      FROM product_variants
      WHERE product_id = ${productId}
      ORDER BY created_at, id
    `;
    return rows;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("variants: add option type with two values → cascade generates two rows → save persists", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const locale = localeFromProject();
  const e = expected[locale];
  const seeded = await seedProduct();
  await signIn(page);

  await page.goto(`/${locale}/admin/products/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(e.editTitle);

  // No options yet → flat single-variant form is visible.
  await expect(page.getByTestId("variant-flat-form")).toBeVisible();
  await expect(page.getByTestId("variant-row")).toHaveCount(0);

  // Add option type "Colour" with two values.
  await page.getByTestId("add-option-type").click();
  const card = page.getByTestId("option-type-card").first();
  await card.getByTestId("option-name-en-input").fill("Colour");
  await card.getByTestId("option-name-ar-input").fill("اللون");
  await card.getByTestId("add-option-value").click();
  await card
    .getByTestId("option-value-row")
    .first()
    .getByTestId("option-value-en-input")
    .fill("Black");
  await card
    .getByTestId("option-value-row")
    .first()
    .getByTestId("option-value-ar-input")
    .fill("أسود");
  await card.getByTestId("add-option-value").click();
  await card
    .getByTestId("option-value-row")
    .nth(1)
    .getByTestId("option-value-en-input")
    .fill("White");
  await card
    .getByTestId("option-value-row")
    .nth(1)
    .getByTestId("option-value-ar-input")
    .fill("أبيض");

  // Cascade: flat form replaced by two variant rows.
  await expect(page.getByTestId("variant-flat-form")).toHaveCount(0);
  const rows = page.getByTestId("variant-row");
  await expect(rows).toHaveCount(2);

  // Fill SKU/price/stock per row.
  const blackSku = `e2e-${randomUUID().slice(0, 6)}-BLK`;
  const whiteSku = `e2e-${randomUUID().slice(0, 6)}-WHT`;
  await rows.nth(0).getByTestId("variant-sku").fill(blackSku);
  await rows.nth(0).getByTestId("variant-price").fill("1250.00");
  await rows.nth(0).getByTestId("variant-stock").fill("12");
  await rows.nth(1).getByTestId("variant-sku").fill(whiteSku);
  await rows.nth(1).getByTestId("variant-price").fill("1250.00");
  await rows.nth(1).getByTestId("variant-stock").fill("8");

  // Per docs/testing.md §4.2, axe runs once per distinct visual page in
  // the suite. The variants edit page is asserted here.
  await expectAxeClean(page);

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?updatedId=`),
      { timeout: 15_000 },
    ),
    page.getByTestId("edit-product-submit").click(),
  ]);

  const variants = await readVariants(seeded.id);
  expect(variants).toHaveLength(2);
  const skus = variants.map((v) => v.sku).sort();
  expect(skus).toEqual([blackSku, whiteSku].sort());
  const black = variants.find((v) => v.sku === blackSku)!;
  expect(black.price_minor).toBe(125000);
  expect(black.stock).toBe(12);
  const white = variants.find((v) => v.sku === whiteSku)!;
  expect(white.price_minor).toBe(125000);
  expect(white.stock).toBe(8);
});

/**
 * Regression guard for the per-keystroke price-input bug. The earlier
 * controlled-input implementation reformatted each keystroke through
 * the cents round-trip ("3" → "3.00") and silently dropped subsequent
 * characters into the .00 slot. There is no Tier-2 fixture for the
 * React controlled-input behaviour in this codebase; the bug is
 * end-to-end visible (typed value mismatches saved cents) and
 * load-bearing for revenue. One focused spec, flat-form path only.
 */
test("variants: per-keystroke price typing keeps every character", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const locale = localeFromProject();
  const seeded = await seedProduct();
  await signIn(page);
  await page.goto(`/${locale}/admin/products/${seeded.id}`);

  const sku = `e2e-${randomUUID().slice(0, 6)}-FLT`;
  await page.getByTestId("variant-flat-sku").fill(sku);
  const priceField = page.getByTestId("variant-flat-price");
  await priceField.click();
  await priceField.pressSequentially("12.34", { delay: 30 });
  await expect(priceField).toHaveValue("12.34");
  await page.getByTestId("variant-flat-sku").focus();
  await expect(priceField).toHaveValue("12.34");

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?updatedId=`),
      { timeout: 15_000 },
    ),
    page.getByTestId("edit-product-submit").click(),
  ]);
  const rows = await readVariants(seeded.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.price_minor).toBe(1234);
});
