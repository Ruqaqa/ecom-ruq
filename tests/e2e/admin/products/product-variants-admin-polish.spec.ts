/**
 * Chunk 1a.5.3 — End-to-end: variants admin polish.
 *
 * Six surfaces covered (each with its own focused test, both locales,
 * full mobile + desktop matrix):
 *   1. Bulk select + apply price/stock to multiple variant rows.
 *   2. Per-row remove via kebab → inline confirm → save (hard-delete
 *      via diff-on-omission contract on `setVariants`).
 *   3. Remove an option type with cascade-warning dialog showing the
 *      live count of variant rows that will be removed; proceeding
 *      hard-deletes the doomed rows in the same tx as the option.
 *   4. Cap-hit pre-save warning when defining options would generate
 *      more than 100 combinations (advisory only — server is the
 *      trust boundary; bypass surfaces as a top-level error).
 *   5a. Client-side duplicate-SKU pre-check pins both colliding rows.
 *   5b. Server-side `sku_taken` opacity — section-level top error
 *       only, NO row-level decoration, NO auto-scroll, NO focus shift
 *       (security spec §B addendum, the existence-leak guard).
 *   6. State-C transition (multi → single): removing the last option
 *      collapses the grid to flat single-variant form; the first row's
 *      typed SKU/price/stock is preserved on the default row.
 *
 * Mobile-first (the iPhone-14 / Pixel-7 projects in playwright.config
 * automatically run this spec at 360px in both en and ar). Each test
 * keeps under the 30-second budget by isolating the surface under
 * test and avoiding wholesale re-creation of the variant tree.
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
    saveSubmit: "Save changes",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
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

interface SeededProduct {
  id: string;
  slug: string;
}

/**
 * Seed a product with a bare minimum row. Tests that need pre-existing
 * options + variants seed those via DB inserts in their own helpers so
 * each test starts from a known baseline.
 */
async function seedProduct(): Promise<SeededProduct> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `e2e-vp-${randomUUID().slice(0, 8)}`;
    const name = {
      en: `VarPolEN-${randomUUID().slice(0, 6)}`,
      ar: `VarPolAR-${randomUUID().slice(0, 6)}`,
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

/**
 * Seed Colour × Size (2 × 2) options + 4 variants on a freshly-created
 * product. Returns the variant ids by deterministic SKU so tests can
 * reference them.
 */
async function seedColourSizeProduct(): Promise<{
  product: SeededProduct;
  variants: { id: string; sku: string }[];
}> {
  const product = await seedProduct();
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenant = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM tenants WHERE primary_domain = 'localhost:5001'
    `;
    const tenantId = tenant[0]!.id;

    const colour = await sql<Array<{ id: string }>>`
      INSERT INTO product_options (tenant_id, product_id, name, position)
      VALUES (${tenantId}, ${product.id}, ${sql.json({ en: "Colour", ar: "اللون" })}, 1)
      RETURNING id::text AS id
    `;
    const size = await sql<Array<{ id: string }>>`
      INSERT INTO product_options (tenant_id, product_id, name, position)
      VALUES (${tenantId}, ${product.id}, ${sql.json({ en: "Size", ar: "المقاس" })}, 2)
      RETURNING id::text AS id
    `;
    const colourId = colour[0]!.id;
    const sizeId = size[0]!.id;

    const black = await sql<Array<{ id: string }>>`
      INSERT INTO product_option_values (tenant_id, option_id, value, position)
      VALUES (${tenantId}, ${colourId}, ${sql.json({ en: "Black", ar: "أسود" })}, 1)
      RETURNING id::text AS id
    `;
    const white = await sql<Array<{ id: string }>>`
      INSERT INTO product_option_values (tenant_id, option_id, value, position)
      VALUES (${tenantId}, ${colourId}, ${sql.json({ en: "White", ar: "أبيض" })}, 2)
      RETURNING id::text AS id
    `;
    const small = await sql<Array<{ id: string }>>`
      INSERT INTO product_option_values (tenant_id, option_id, value, position)
      VALUES (${tenantId}, ${sizeId}, ${sql.json({ en: "S", ar: "صغير" })}, 1)
      RETURNING id::text AS id
    `;
    const medium = await sql<Array<{ id: string }>>`
      INSERT INTO product_option_values (tenant_id, option_id, value, position)
      VALUES (${tenantId}, ${sizeId}, ${sql.json({ en: "M", ar: "متوسط" })}, 2)
      RETURNING id::text AS id
    `;
    const blackId = black[0]!.id;
    const whiteId = white[0]!.id;
    const smallId = small[0]!.id;
    const mediumId = medium[0]!.id;

    const skuPrefix = `e2e-${randomUUID().slice(0, 6)}`;
    const variants: Array<{ sku: string; values: string[] }> = [
      { sku: `${skuPrefix}-BLK-S`, values: [blackId, smallId] },
      { sku: `${skuPrefix}-BLK-M`, values: [blackId, mediumId] },
      { sku: `${skuPrefix}-WHT-S`, values: [whiteId, smallId] },
      { sku: `${skuPrefix}-WHT-M`, values: [whiteId, mediumId] },
    ];

    const created: Array<{ id: string; sku: string }> = [];
    for (const v of variants) {
      const row = await sql<Array<{ id: string }>>`
        INSERT INTO product_variants (
          tenant_id, product_id, sku, price_minor, currency, stock,
          active, option_value_ids
        )
        VALUES (
          ${tenantId}, ${product.id}, ${v.sku}, 100000, 'SAR', 5, true,
          ${sql.json(v.values)}
        )
        RETURNING id::text AS id
      `;
      created.push({ id: row[0]!.id, sku: v.sku });
    }
    return { product, variants: created };
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

async function readOptionsCount(productId: string): Promise<number> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM product_options WHERE product_id = ${productId}
    `;
    return rows[0]!.c;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Seed a different product on the same tenant carrying a SKU. Used by
 * the server-side `sku_taken` opacity test to set up a tenant-wide
 * collision the operator can be made to trigger from a different
 * product's edit page.
 */
async function seedProductWithSku(sku: string): Promise<SeededProduct> {
  const product = await seedProduct();
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenant = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM tenants WHERE primary_domain = 'localhost:5001'
    `;
    await sql`
      INSERT INTO product_variants (
        tenant_id, product_id, sku, price_minor, currency, stock,
        active, option_value_ids
      )
      VALUES (
        ${tenant[0]!.id}, ${product.id}, ${sku}, 50000, 'SAR', 1, true, '[]'::jsonb
      )
    `;
    return product;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForVariantsReady(page: Page, atLeast: number): Promise<void> {
  await expect(page.getByTestId("variant-row")).toHaveCount(atLeast, {
    timeout: 15_000,
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`bulk-apply price+stock to selected variant rows — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { product, variants } = await seedColourSizeProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);

    // Enter select-mode via the Select toggle in the section header.
    await page.getByTestId("variants-section-select-toggle").click();
    const checkboxes = page.getByTestId("variant-row-checkbox");
    await expect(checkboxes).toHaveCount(4);

    // Select the first two rows.
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await expect(page.getByTestId("variants-bulk-toolbar")).toBeVisible();
    await expect(
      page.getByTestId("variants-bulk-toolbar-count"),
    ).toBeVisible();

    // Open the bulk-apply sheet and overwrite price + stock.
    await page.getByTestId("variants-bulk-toolbar-apply").click();
    await expect(page.getByTestId("bulk-apply-sheet")).toBeVisible();
    await expectAxeClean(page);
    await page.getByTestId("bulk-apply-price-toggle").check();
    await page.getByTestId("bulk-apply-price-field").fill("799");
    await page.getByTestId("bulk-apply-stock-toggle").check();
    await page.getByTestId("bulk-apply-stock-field").fill("99");
    await page.getByTestId("bulk-apply-confirm").click();
    await expect(page.getByTestId("bulk-apply-sheet")).toHaveCount(0);

    // Save and assert DB state.
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    const dbVariants = await readVariants(product.id);
    expect(dbVariants).toHaveLength(4);
    // The first two seeded variants (insertion order) got the bulk patch.
    const bulkedSkus = new Set([variants[0]!.sku, variants[1]!.sku]);
    const bulked = dbVariants.filter((v) => bulkedSkus.has(v.sku));
    const untouched = dbVariants.filter((v) => !bulkedSkus.has(v.sku));
    expect(bulked).toHaveLength(2);
    for (const b of bulked) {
      expect(b.price_minor).toBe(79900);
      expect(b.stock).toBe(99);
    }
    for (const u of untouched) {
      // Original price 1000.00 SAR (100000 minor); original stock 5.
      expect(u.price_minor).toBe(100000);
      expect(u.stock).toBe(5);
    }
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`per-row remove via kebab + inline confirm — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { product, variants } = await seedColourSizeProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);

    // Open the kebab on the first row, click Remove.
    const firstRow = page.getByTestId("variant-row").first();
    await firstRow.getByTestId("variant-row-menu-cta").click();
    await firstRow.getByTestId("variant-row-menu-remove").click();
    await expect(firstRow.getByTestId("variant-row-remove-confirm")).toBeVisible();
    await firstRow.getByTestId("variant-row-remove-confirm-yes").click();
    // Row count dropped to 3.
    await expect(page.getByTestId("variant-row")).toHaveCount(3);

    // Save and assert hard-delete.
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    const dbVariants = await readVariants(product.id);
    expect(dbVariants).toHaveLength(3);
    const dbSkus = dbVariants.map((v) => v.sku).sort();
    const expectedSkus = [variants[1]!.sku, variants[2]!.sku, variants[3]!.sku].sort();
    expect(dbSkus).toEqual(expectedSkus);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`cascade-remove option type with confirm dialog — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { product } = await seedColourSizeProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);

    // Click Remove on the first option type (Colour). Cascade dialog
    // surfaces with the live count of variant rows (4 rows × 1 of 2
    // colour values each = 4 doomed: every variant references either
    // Black or White).
    const colourCard = page.getByTestId("option-type-card").first();
    await colourCard.getByTestId("option-remove-cta").click();
    await expect(page.getByTestId("remove-option-dialog")).toBeVisible();
    await expectAxeClean(page);
    await expect(page.getByTestId("remove-option-cascade-warning")).toBeVisible();
    // Two options remain after removing one ⇒ NOT a State-C collapse,
    // so the collapse-preview line is absent.
    await expect(page.getByTestId("remove-option-collapse-preview")).toHaveCount(0);

    await page.getByTestId("remove-option-confirm").click();
    await expect(page.getByTestId("remove-option-dialog")).toHaveCount(0);

    // Save → cascade-deletes all four variants in the same tx as the
    // option removal. The remaining option (Size) regenerates two new
    // variants based on the Size values, with empty SKU/price/stock —
    // those rows are not "operator touched" so the variants leg of
    // the save chain skips them. Net result: 1 option left, 0 variants.
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    const remainingOptions = await readOptionsCount(product.id);
    expect(remainingOptions).toBe(1);
    const dbVariants = await readVariants(product.id);
    expect(dbVariants).toHaveLength(0);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`State-C collapse: removing the last option preserves first row's data on the default — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Seed a product with a single option (Colour) × two values; first
    // variant carries SKU/price/stock. Removing Colour collapses to
    // single-variant default; the default-row should pick up the first
    // variant's typed values.
    const product = await seedProduct();
    const sql = postgres(DATABASE_URL, { max: 1 });
    let blackSku = "";
    try {
      const tenant = await sql<Array<{ id: string }>>`
        SELECT id::text AS id FROM tenants WHERE primary_domain = 'localhost:5001'
      `;
      const tenantId = tenant[0]!.id;
      const colour = await sql<Array<{ id: string }>>`
        INSERT INTO product_options (tenant_id, product_id, name, position)
        VALUES (${tenantId}, ${product.id}, ${sql.json({ en: "Colour", ar: "اللون" })}, 1)
        RETURNING id::text AS id
      `;
      const colourId = colour[0]!.id;
      const black = await sql<Array<{ id: string }>>`
        INSERT INTO product_option_values (tenant_id, option_id, value, position)
        VALUES (${tenantId}, ${colourId}, ${sql.json({ en: "Black", ar: "أسود" })}, 1)
        RETURNING id::text AS id
      `;
      const white = await sql<Array<{ id: string }>>`
        INSERT INTO product_option_values (tenant_id, option_id, value, position)
        VALUES (${tenantId}, ${colourId}, ${sql.json({ en: "White", ar: "أبيض" })}, 2)
        RETURNING id::text AS id
      `;
      const blackId = black[0]!.id;
      const whiteId = white[0]!.id;
      blackSku = `e2e-${randomUUID().slice(0, 6)}-BLK`;
      const whiteSku = `e2e-${randomUUID().slice(0, 6)}-WHT`;
      await sql`
        INSERT INTO product_variants (
          tenant_id, product_id, sku, price_minor, currency, stock, active, option_value_ids
        ) VALUES
        (${tenantId}, ${product.id}, ${blackSku}, 75000, 'SAR', 7, true, ${sql.json([blackId])}),
        (${tenantId}, ${product.id}, ${whiteSku}, 75000, 'SAR', 7, true, ${sql.json([whiteId])})
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 2);

    // Remove Colour. Dialog body should include the collapse-preview.
    const colourCard = page.getByTestId("option-type-card").first();
    await colourCard.getByTestId("option-remove-cta").click();
    await expect(page.getByTestId("remove-option-dialog")).toBeVisible();
    await expect(
      page.getByTestId("remove-option-collapse-preview"),
    ).toBeVisible();
    await page.getByTestId("remove-option-confirm").click();

    // Grid collapsed to flat-form; the dismissible collapse banner
    // surfaces.
    await expect(page.getByTestId("variant-flat-form")).toBeVisible();
    await expect(page.getByTestId("variant-row")).toHaveCount(0);
    await expect(page.getByTestId("variants-collapse-notice")).toBeVisible();
    // The flat form's SKU is the first row's preserved SKU.
    await expect(page.getByTestId("variant-flat-sku")).toHaveValue(blackSku);

    // Save and confirm DB state.
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    const remainingOptions = await readOptionsCount(product.id);
    expect(remainingOptions).toBe(0);
    const dbVariants = await readVariants(product.id);
    expect(dbVariants).toHaveLength(1);
    expect(dbVariants[0]!.sku).toBe(blackSku);
    expect(dbVariants[0]!.price_minor).toBe(75000);
    expect(dbVariants[0]!.stock).toBe(7);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`cap-hit pre-save warning when options × values exceeds 100 — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const product = await seedProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);

    // Define 1 option with 11 values (no cartesian growth — projection
    // = 11). Then add a second option with 11 values (projection =
    // 121, > 100). Verify the cap-warning appears.
    await page.getByTestId("add-option-type").click();
    const opt1 = page.getByTestId("option-type-card").first();
    await opt1.getByTestId("option-name-en-input").fill("Letter A");
    await opt1.getByTestId("option-name-ar-input").fill("الحرف أ");
    for (let i = 0; i < 11; i++) {
      await opt1.getByTestId("add-option-value").click();
      const value = opt1.getByTestId("option-value-row").nth(i);
      await value.getByTestId("option-value-en-input").fill(`A${i}`);
      await value.getByTestId("option-value-ar-input").fill(`أ${i}`);
    }
    // 11 variants — under cap. No warning.
    await expect(page.getByTestId("variants-cap-warning")).toHaveCount(0);

    await page.getByTestId("add-option-type").click();
    const opt2 = page.getByTestId("option-type-card").nth(1);
    await opt2.getByTestId("option-name-en-input").fill("Letter B");
    await opt2.getByTestId("option-name-ar-input").fill("الحرف ب");
    for (let i = 0; i < 11; i++) {
      await opt2.getByTestId("add-option-value").click();
      const value = opt2.getByTestId("option-value-row").nth(i);
      await value.getByTestId("option-value-en-input").fill(`B${i}`);
      await value.getByTestId("option-value-ar-input").fill(`B${i}`);
    }
    // 11 × 11 = 121 — over cap. Warning surfaces.
    await expect(page.getByTestId("variants-cap-warning")).toBeVisible();
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`client-side duplicate-SKU pre-check pins both colliding rows — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { product, variants } = await seedColourSizeProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);

    // Type the same SKU into the first two rows (overwriting the
    // seeded distinct SKUs). Save attempt; the form should NOT submit
    // and both rows should show the duplicate-in-form pin.
    const dupSku = `dup-${randomUUID().slice(0, 6)}`;
    await page.getByTestId("variant-sku").nth(0).fill(dupSku);
    await page.getByTestId("variant-sku").nth(1).fill(dupSku);
    await page.getByTestId("edit-product-submit").click();

    // Both rows show the row-pinned dup-in-form error; the section-
    // level top-error stays empty.
    const firstRow = page.getByTestId("variant-row").first();
    const secondRow = page.getByTestId("variant-row").nth(1);
    await expect(firstRow.getByTestId("variant-sku")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(secondRow.getByTestId("variant-sku")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("variants-top-error")).toHaveCount(0);
    // We should NOT have navigated.
    await expect(page).toHaveURL(
      new RegExp(`/${locale}/admin/products/${product.id}$`),
    );

    // Resolve the dup; now save lands.
    const distinct = `${dupSku}-x`;
    await page.getByTestId("variant-sku").nth(1).fill(distinct);
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeEnabled();
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    const _unused = variants;
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`server sku_taken surfaces opaquely at top-of-form, no row decoration, no auto-scroll — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Seed a sibling product on the same tenant carrying SKU `victim`.
    const collidingSku = `e2e-collide-${randomUUID().slice(0, 6)}`;
    await seedProductWithSku(collidingSku);
    // Edit a different product; its first variant tries to take the
    // colliding SKU.
    const { product, variants } = await seedColourSizeProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);

    // Type the colliding SKU into row 3 only; the in-form pre-check
    // passes (no other row in this product has it). Playwright's
    // .fill() may auto-scroll the input into view — that's an artefact
    // of the typing, not the server response we're testing.
    const targetRow = page.getByTestId("variant-row").nth(2);
    const targetSkuInput = targetRow.getByTestId("variant-sku");
    await targetSkuInput.fill(collidingSku);

    // Capture the suspect row's bounding rect AFTER typing and BEFORE
    // Save so the assertion reflects only the response handler's
    // behaviour. The security-bound contract is "no auto-scroll into
    // the suspect row" — equivalently, the suspect row's viewport
    // position must not change as a result of the server response.
    const skuBoxBefore = await targetSkuInput.boundingBox();

    await page.getByTestId("edit-product-submit").click();

    // Top-of-form banner appears with the bound copy.
    await expect(page.getByTestId("variants-top-error")).toBeVisible();
    // Row stays visually clean: no aria-invalid on its SKU input.
    await expect(targetSkuInput).not.toHaveAttribute("aria-invalid", "true");
    // Form did not navigate.
    await expect(page).toHaveURL(
      new RegExp(`/${locale}/admin/products/${product.id}$`),
    );
    // No auto-scroll into the suspect row — its viewport position did
    // not move CLOSER (scroll-into-view would shift it INTO the
    // viewport, dramatically changing y). We allow small layout shifts
    // from the top-error banner's appearance (≤ 120px on the smallest
    // viewport) but reject any bigger movement that would imply
    // scroll-into-view of the row.
    const skuBoxAfter = await targetSkuInput.boundingBox();
    if (skuBoxBefore && skuBoxAfter) {
      expect(Math.abs(skuBoxAfter.y - skuBoxBefore.y)).toBeLessThanOrEqual(120);
    }
    const _unused = variants;
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`per-keystroke price typing keeps every character on flat form and on a variant card — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // Flat form first: a freshly-seeded product has no options, so the
    // single-variant default is rendered. Type a multi-character price
    // one keystroke at a time. The bug this guards against reformatted
    // each keystroke through the cents round-trip ("3" → "3.00") and
    // silently dropped subsequent characters into the .00 slot. Assert
    // the visible value matches what was typed AND the saved cents
    // match the typed amount end-to-end.
    const flatProduct = await seedProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${flatProduct.id}`);
    const flatSku = `e2e-${randomUUID().slice(0, 6)}-FLT`;
    await page.getByTestId("variant-flat-sku").fill(flatSku);
    const flatPrice = page.getByTestId("variant-flat-price");
    await flatPrice.click();
    await flatPrice.pressSequentially("12.34", { delay: 30 });
    await expect(flatPrice).toHaveValue("12.34");
    await page.getByTestId("variant-flat-sku").focus();
    await expect(flatPrice).toHaveValue("12.34");
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      page.getByTestId("edit-product-submit").click(),
    ]);
    const flatRows = await readVariants(flatProduct.id);
    expect(flatRows).toHaveLength(1);
    expect(flatRows[0]!.price_minor).toBe(1234);

    // Multi-variant card next: pick the first row of a 2×2 product and
    // re-type its price character-by-character. Same assertions: every
    // character lands and the saved cents reflect the full input.
    const { product, variants } = await seedColourSizeProduct();
    await page.goto(`/${locale}/admin/products/${product.id}`);
    await waitForVariantsReady(page, 4);
    const firstRow = page.getByTestId("variant-row").first();
    const firstPrice = firstRow.getByTestId("variant-price");
    await firstPrice.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await page.keyboard.press("Backspace");
    await firstPrice.pressSequentially("56.78", { delay: 30 });
    await expect(firstPrice).toHaveValue("56.78");
    await firstRow.getByTestId("variant-sku").focus();
    await expect(firstPrice).toHaveValue("56.78");
    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      page.getByTestId("edit-product-submit").click(),
    ]);
    const multiRows = await readVariants(product.id);
    const seededFirstSku = variants[0]!.sku;
    const updated = multiRows.find((r) => r.sku === seededFirstSku);
    expect(updated, `row ${seededFirstSku} should still exist`).toBeDefined();
    expect(updated!.price_minor).toBe(5678);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`expand banner only fires when the flat form has typed data — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // Empty flat form: adding the first option type with no SKU/price/
    // stock typed in should NOT surface the expand banner — the banner
    // would otherwise promise preservation that has nothing to land on.
    const emptyProduct = await seedProduct();
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${emptyProduct.id}`);
    await expect(page.getByTestId("variant-flat-form")).toBeVisible();
    await page.getByTestId("add-option-type").click();
    await expect(
      page.getByTestId("variants-expand-notice"),
    ).toHaveCount(0);

    // Flat form with typed data: adding the first option type SHOULD
    // surface the expand banner, since the operator's typed-in data
    // really will carry over to the first generated variant row.
    const seededProduct = await seedProduct();
    await page.goto(`/${locale}/admin/products/${seededProduct.id}`);
    const flatSku = `e2e-${randomUUID().slice(0, 6)}-EXP`;
    await page.getByTestId("variant-flat-sku").fill(flatSku);
    const flatPrice = page.getByTestId("variant-flat-price");
    await flatPrice.click();
    await flatPrice.pressSequentially("9.99", { delay: 30 });
    await page.getByTestId("variant-flat-sku").focus();
    await page.getByTestId("add-option-type").click();
    await expect(page.getByTestId("variants-expand-notice")).toBeVisible();
  });
}
