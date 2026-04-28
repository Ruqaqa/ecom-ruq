/**
 * Chunk 1a.4.2 — End-to-end: product-edit categories picker (Block 4).
 *
 * Covers UI integration of the chip+sheet on the product edit form,
 * plus the master-brief addendum's overscroll-contain assertion (Apply
 * stays visible after scrolling the picker body to its bottom).
 *
 * Coverage-lint substring contract: `products.setCategories` and
 * `categories.listForProduct` must appear in this file
 * (products.setCategories, categories.listForProduct).
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
    title: "Edit product",
    submit: "Save changes",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    title: "تعديل المنتج",
    submit: "حفظ التغييرات",
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
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
    const slug = `e2e-pcp-${randomUUID().slice(0, 8)}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en: "Probe", ar: "اختبار" })},
        'draft'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedCategory(opts: {
  slug: string;
  name?: { en: string; ar: string };
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const name = opts.name ?? { en: opts.slug, ar: opts.slug };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${opts.slug},
        ${sql.json(name)}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug: opts.slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function softDeleteCategory(id: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE categories SET deleted_at = now() WHERE id = ${id}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readLinkedCategoryIds(productId: string): Promise<string[]> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ category_id: string }>>`
      SELECT category_id::text AS category_id FROM product_categories
      WHERE product_id = ${productId} ORDER BY category_id
    `;
    return rows.map((r) => r.category_id);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function uniqueSlug(tag: string): string {
  return `e2e-pcp-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

for (const locale of ["en", "ar"] as const) {
  test(`product edit — open picker, multi-select, Apply renders chips with full localized path, ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const product = await seedProduct();
    const cat1 = await seedCategory({
      slug: uniqueSlug("chip-1"),
      name: { en: "Pens", ar: "أقلام" },
    });
    const cat2 = await seedCategory({
      slug: uniqueSlug("chip-2"),
      name: { en: "Notebooks", ar: "دفاتر" },
    });

    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/products/${product.id}`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].title,
    );
    const section = page.getByTestId("product-categories-section");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("product-categories-empty")).toBeVisible();

    // axe with picker closed.
    await expectAxeClean(page);

    await page.getByTestId("product-categories-add").click();
    await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

    // axe with picker open.
    await expectAxeClean(page);

    // Multi-select: pick both.
    await page
      .locator(
        `[data-testid="category-picker-row"][data-id="${cat1.id}"] [data-testid="category-picker-checkbox"]`,
      )
      .check();
    await page
      .locator(
        `[data-testid="category-picker-row"][data-id="${cat2.id}"] [data-testid="category-picker-checkbox"]`,
      )
      .check();

    await page.getByTestId("category-picker-apply").click();
    await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);

    // Chips render with full localized path. Note: the data-id is ON
    // the chip element itself, not a descendant, so use a compound
    // attribute selector rather than `.filter({ has: ... })`.
    const chip1 = page.locator(
      `[data-testid="product-category-chip"][data-id="${cat1.id}"]`,
    );
    const chip2 = page.locator(
      `[data-testid="product-category-chip"][data-id="${cat2.id}"]`,
    );
    await expect(chip1).toBeVisible();
    await expect(chip2).toBeVisible();
    if (locale === "en") {
      await expect(chip1).toContainText("Pens");
      await expect(chip2).toContainText("Notebooks");
    } else {
      await expect(chip1).toContainText("أقلام");
      await expect(chip2).toContainText("دفاتر");
    }

    // Save commits both legs of the two-mutation flow.
    await page.getByTestId("edit-product-submit").click();
    await page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?updatedId=`),
      { timeout: 15_000 },
    );

    // DB confirms both categories landed.
    const linked = await readLinkedCategoryIds(product.id);
    expect(linked.sort()).toEqual([cat1.id, cat2.id].sort());
  });
}

test("product edit — chip × button removes the category from the local set; Save persists", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const product = await seedProduct();
  const cat1 = await seedCategory({ slug: uniqueSlug("rm-1") });
  const cat2 = await seedCategory({ slug: uniqueSlug("rm-2") });
  // Pre-link both via direct DB insert.
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES
        ((SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
         ${product.id}, ${cat1.id}),
        ((SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
         ${product.id}, ${cat2.id})
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${product.id}`);

  // Both chips render.
  await expect(
    page.getByTestId("product-category-chip"),
  ).toHaveCount(2);

  // Remove chip 1 via × button. After the click, focus must land on
  // a remaining chip's remove button (DOM order). When the last chip
  // is removed, focus falls back to the Add Categories button.
  const chip1 = page.locator(
    `[data-testid="product-category-chip"][data-id="${cat1.id}"]`,
  );
  await chip1.getByTestId("product-category-chip-remove").click();
  await expect(
    page.getByTestId("product-category-chip"),
  ).toHaveCount(1);

  // Focus moved to a chip-remove button (the surviving chip).
  const focusedTestId1 = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid"),
  );
  expect(focusedTestId1).toBe("product-category-chip-remove");

  // Remove the last chip — focus falls back to Add Categories.
  await page
    .locator('[data-testid="product-category-chip-remove"]')
    .click();
  await expect(
    page.getByTestId("product-category-chip"),
  ).toHaveCount(0);
  const focusedTestId2 = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-testid"),
  );
  expect(focusedTestId2).toBe("product-categories-add");

  // Save — categories-only edit should still trigger a save (dirty).
  await page.getByTestId("edit-product-submit").click();
  await page.waitForURL(/\/en\/admin\/products\?updatedId=/, {
    timeout: 15_000,
  });

  const linked = await readLinkedCategoryIds(product.id);
  expect(linked).toEqual([]);
});

test("product edit — picker Apply button stays visible after scrolling picker body to bottom (overscroll-contain)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const product = await seedProduct();
  // Seed enough categories to make the picker body actually scroll.
  const seeds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const c = await seedCategory({
      slug: uniqueSlug(`scroll-${i}`),
      name: { en: `Category ${i}`, ar: `فئة ${i}` },
    });
    seeds.push(c.id);
  }
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${product.id}`);
  await page.getByTestId("product-categories-add").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

  // Scroll the picker body to its bottom.
  const body = page.getByTestId("category-picker-body");
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // Apply button MUST remain visible — overscroll-contain plus the
  // sticky footer is what guarantees this. If overscroll-contain
  // were missing, the body's rubber-band on iOS would briefly hide
  // the footer; the assertion would flake there. On desktop the
  // sticky footer is the load-bearing guarantee.
  const apply = page.getByTestId("category-picker-apply");
  await expect(apply).toBeVisible();
});

test("product edit — stale-category banner appears when a selected category is soft-deleted out-of-band; chips refresh", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const product = await seedProduct();
  const cat1 = await seedCategory({ slug: uniqueSlug("stale") });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${product.id}`);

  // Select cat1 via the picker.
  await page.getByTestId("product-categories-add").click();
  await page
    .locator(
      `[data-testid="category-picker-row"][data-id="${cat1.id}"] [data-testid="category-picker-checkbox"]`,
    )
    .check();
  await page.getByTestId("category-picker-apply").click();

  // Out-of-band: soft-delete cat1 BEFORE saving.
  await softDeleteCategory(cat1.id);

  // Save — setCategories returns BAD_REQUEST category_not_found.
  await page.getByTestId("edit-product-submit").click();

  // Banner appears.
  await expect(
    page.getByTestId("product-categories-stale-error"),
  ).toBeVisible({ timeout: 15_000 });

  // Chips refreshed to the server's actual current set (empty).
  await expect(
    page.getByTestId("product-category-chip"),
  ).toHaveCount(0);
});
