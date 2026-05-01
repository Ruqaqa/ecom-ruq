/**
 * Chunk 1a.5.2 — End-to-end: admin defines options + edits variants.
 *
 * Drives the full user flow at 360px in both locales:
 *   1. Open the product edit page — single-variant flat form is visible
 *      (no options defined yet).
 *   2. Add an option type ("Colour") with two values ("Black", "White").
 *   3. The Variants list auto-generates two rows from the cartesian
 *      product. Each row carries its option-value tuple as the
 *      `data-key` so we can scope assertions.
 *   4. Fill SKU / price / stock per row.
 *   5. Save. The page redirects back to the products list.
 *   6. Re-open the edit page. Options + variants persist; SKU / price /
 *      stock all match what was entered.
 *   7. axe is clean on the edit page in both locales.
 *
 * Mobile-first (the iPhone-14 / Pixel-7 projects in playwright.config
 * automatically run this spec at 360px in both en and ar). The test
 * also exercises the cap-counter and the disabled-by-design "remove
 * option" affordance (1a.5.3 wires the cascade flow; 1a.5.2 surfaces
 * the disabled state with helper copy so the matrix asserts the
 * keyboard / a11y shape is in place).
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
    optionsHeading: "Options",
    addOptionType: "Add an option type",
    addOptionValue: "Add a value",
    variantsHeading: "Variants",
    saveSubmit: "Save changes",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    editTitle: "تعديل المنتج",
    optionsHeading: "الخيارات",
    addOptionType: "أضف نوع خيار",
    addOptionValue: "أضف قيمة",
    variantsHeading: "التنويعات",
    saveSubmit: "حفظ التغييرات",
  },
} as const;

async function signIn(
  page: Page,
  locale: "en" | "ar",
  email: string,
): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", {
    name: expected[locale].signInSubmit,
  });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page
    .getByLabel(expected[locale].emailLabel, { exact: true })
    .fill(email);
  await page
    .getByLabel(expected[locale].passwordLabel, { exact: true })
    .fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), {
    timeout: 30_000,
  });
}

async function seedProduct(): Promise<{ id: string; slug: string }> {
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
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface DbVariantRow {
  id: string;
  sku: string;
  price_minor: number;
  stock: number;
  option_value_ids: string[];
}

async function readVariants(productId: string): Promise<DbVariantRow[]> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<DbVariantRow[]>`
      SELECT id::text AS id, sku, price_minor, stock,
             option_value_ids
      FROM product_variants
      WHERE product_id = ${productId}
      ORDER BY created_at, id
    `;
    return rows;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readOptionsCount(productId: string): Promise<{
  options: number;
  values: number;
}> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const optsRows = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM product_options WHERE product_id = ${productId}
    `;
    const valsRows = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c
      FROM product_option_values
      WHERE option_id IN (
        SELECT id FROM product_options WHERE product_id = ${productId}
      )
    `;
    return { options: optsRows[0]!.c, values: valsRows[0]!.c };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`owner defines options + variants on a product (happy path) — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seeded = await seedProduct();
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/products/${seeded.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].editTitle,
    );

    // No options yet → flat single-variant form is visible, the
    // variants list is not yet present.
    await expect(page.getByTestId("variant-flat-form")).toBeVisible();
    await expect(page.getByTestId("variant-row")).toHaveCount(0);
    await expect(page.getByTestId("option-type-card")).toHaveCount(0);

    // Cap counter on options panel is visible (text varies by locale —
    // AR uses Arabic-Indic digits).
    await expect(page.getByTestId("option-cap-counter")).toBeVisible();

    // Add option type.
    await page.getByTestId("add-option-type").click();
    const newOptionCard = page.getByTestId("option-type-card").first();
    await newOptionCard.getByTestId("option-name-en-input").fill("Colour");
    await newOptionCard.getByTestId("option-name-ar-input").fill("اللون");
    // Add the first value: "Black".
    await newOptionCard.getByTestId("add-option-value").click();
    const firstValue = newOptionCard.getByTestId("option-value-row").first();
    await firstValue.getByTestId("option-value-en-input").fill("Black");
    await firstValue.getByTestId("option-value-ar-input").fill("أسود");
    // Add the second value: "White".
    await newOptionCard.getByTestId("add-option-value").click();
    const secondValue = newOptionCard.getByTestId("option-value-row").nth(1);
    await secondValue.getByTestId("option-value-en-input").fill("White");
    await secondValue.getByTestId("option-value-ar-input").fill("أبيض");

    // The flat form has been replaced by the auto-generated variants
    // list — exactly two rows for the two values.
    await expect(page.getByTestId("variant-flat-form")).toHaveCount(0);
    const rows = page.getByTestId("variant-row");
    await expect(rows).toHaveCount(2);

    // Variant cap counter is visible (text varies by locale digit set).
    await expect(page.getByTestId("variant-cap-counter")).toBeVisible();
    await expect(page.getByTestId("option-type-card")).toHaveCount(1);

    // Fill SKU/price/stock on both rows. Use deterministic SKUs so we
    // can verify them on read-back.
    const blackSku = `e2e-${randomUUID().slice(0, 6)}-BLK`;
    const whiteSku = `e2e-${randomUUID().slice(0, 6)}-WHT`;
    const row1 = rows.nth(0);
    await row1.getByTestId("variant-sku").fill(blackSku);
    await row1.getByTestId("variant-price").fill("1250.00");
    await row1.getByTestId("variant-stock").fill("12");
    const row2 = rows.nth(1);
    await row2.getByTestId("variant-sku").fill(whiteSku);
    await row2.getByTestId("variant-price").fill("1250.00");
    await row2.getByTestId("variant-stock").fill("8");

    // Remove-option affordance is disabled in 1a.5.2 — covered here
    // so the matrix asserts the disabled-state copy is wired in both
    // locales (the active cascade flow lands in 1a.5.3). The helper
    // paragraph carries its own testid so the assertion doesn't
    // couple to the en or ar copy text.
    const removeOption = newOptionCard.getByTestId("option-remove-cta");
    await expect(removeOption).toBeDisabled();
    await expect(removeOption).toHaveAttribute("aria-disabled", "true");
    await expect(
      newOptionCard.getByTestId("remove-option-cta-disabled-helper"),
    ).toBeVisible();

    // axe-clean before submit.
    await expectAxeClean(page);

    // Submit. Page redirects to the products list on success.
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);

    // DB reflects the writes.
    const counts = await readOptionsCount(seeded.id);
    expect(counts.options).toBe(1);
    expect(counts.values).toBe(2);
    const variants = await readVariants(seeded.id);
    expect(variants).toHaveLength(2);
    const skus = variants.map((v) => v.sku).sort();
    expect(skus).toEqual([blackSku, whiteSku].sort());
    const blackVariant = variants.find((v) => v.sku === blackSku)!;
    expect(blackVariant.price_minor).toBe(125000);
    expect(blackVariant.stock).toBe(12);
    const whiteVariant = variants.find((v) => v.sku === whiteSku)!;
    expect(whiteVariant.price_minor).toBe(125000);
    expect(whiteVariant.stock).toBe(8);

    // Re-open the edit page — options + variants are hydrated; SKU /
    // price / stock survive the round trip.
    await page.goto(`/${locale}/admin/products/${seeded.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].editTitle,
    );
    await expect(page.getByTestId("variant-row")).toHaveCount(2);
    // Find each row by its SKU (the value-id ordering is deterministic
    // but we don't pin the value-ids in this spec).
    const reloadedSkus = await page
      .getByTestId("variant-sku")
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLInputElement).value),
      );
    expect(reloadedSkus.sort()).toEqual([blackSku, whiteSku].sort());
  });
}
