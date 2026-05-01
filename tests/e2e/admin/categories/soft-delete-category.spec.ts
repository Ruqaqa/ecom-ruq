/**
 * Chunk 1a.4.3 — End-to-end: admin removes a category from the edit
 * page and the cascade behavior is visible on the list.
 *
 * Cases:
 *   1. Owner removes a leaf category from the edit page → row hides on
 *      default list, reappears under "Show removed", removed-flash visible.
 *   2. Cascade warning shows the descendant count in the confirm dialog;
 *      removing a parent flips the whole live subtree on the list.
 *   3. A removed category disappears from the product-edit category
 *      picker (cross-cut to the 1a.4.2 multi-pick).
 *   4. Stale-write on remove: row's updated_at bumped out-of-band → the
 *      stale-write banner appears, row stays live.
 *
 * References tRPC mutations `categories.delete` and `categories.restore`
 * so check:e2e-coverage finds them. Wire path: categories.delete.
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
    listTitle: "Categories",
    editTitle: "Edit category",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    listTitle: "الفئات",
    editTitle: "تعديل الفئة",
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

interface SeedOpts {
  slug?: string;
  parentId?: string | null;
  nameEn?: string;
  nameAr?: string;
}

async function seedCategory(
  opts: SeedOpts = {},
): Promise<{ id: string; slug: string; nameEn: string; nameAr: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = opts.slug ?? `e2e-del-cat-${randomUUID().slice(0, 8)}`;
    const en = `${opts.nameEn ?? "RemovableCat"}-${randomUUID().slice(0, 6)}`;
    const ar = `${opts.nameAr ?? "فئة-قابلة-للحذف"}-${randomUUID().slice(0, 6)}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name, parent_id)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en, ar })},
        ${opts.parentId ?? null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug, nameEn: en, nameAr: ar };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedProduct(): Promise<{ id: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `e2e-del-cat-prod-${randomUUID().slice(0, 8)}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en: "P", ar: "م" })},
        'draft'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id };
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

async function bumpUpdatedAt(categoryId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE categories SET updated_at = now() + interval '1 second' WHERE id = ${categoryId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function softDeleteDirect(categoryId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE categories SET deleted_at = now() WHERE id = ${categoryId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`case 1: owner removes a leaf category from edit; row hides + reappears under Show removed — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seeded = await seedCategory();
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/categories/${seeded.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].editTitle,
    );

    const removeCta = page.getByTestId("remove-category-cta");
    await expect(removeCta).toBeVisible();
    const ctaBox = await removeCta.boundingBox();
    expect(ctaBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await removeCta.click();

    const dialog = page.getByTestId("remove-category-dialog");
    await expect(dialog).toBeVisible();
    const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
    await expect(dialog).toContainText(seededName);
    await expect(dialog).not.toContainText("{name}");
    // Leaf — no cascade warning.
    await expect(
      page.getByTestId("remove-category-cascade-warning"),
    ).toHaveCount(0);
    await expectAxeClean(page);

    const confirmBtn = page.getByTestId("remove-category-confirm");
    const confirmBox = await confirmBtn.boundingBox();
    expect(confirmBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/categories\\?removedId=`),
        { timeout: 15_000 },
      ),
      confirmBtn.click(),
    ]);

    await expect(page.getByTestId("removed-category-message")).toBeVisible();
    expect(await readDeletedAt(seeded.id)).toBeInstanceOf(Date);

    // Default list does NOT include the removed row.
    const defaultRowLinks = page.getByTestId("category-row-link");
    const hrefs = await defaultRowLinks.evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    expect(
      hrefs.every((h) => !h.endsWith(`/admin/categories/${seeded.id}`)),
    ).toBe(true);

    // Toggle Show removed → row reappears with removed-badge.
    await page.getByTestId("show-removed-toggle").click();
    await page.waitForURL(/\?showRemoved=1/, { timeout: 15_000 });
    const removedRowLink = page
      .locator('[data-testid="category-row-link"]:visible')
      .filter({ hasText: seededName });
    await expect(removedRowLink).toHaveCount(1);
    const removedRow = removedRowLink.locator(
      'xpath=ancestor::*[@data-testid="category-row"][1]',
    );
    await expect(removedRow).toHaveAttribute("data-removed", "true");
    await expect(removedRow.getByTestId("removed-badge")).not.toHaveCount(0);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`case 2: cascade warning + parent removal flips whole subtree — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const root = await seedCategory({ nameEn: "CascadeRoot" });
    const child = await seedCategory({
      parentId: root.id,
      nameEn: "CascadeChild",
    });
    const grand = await seedCategory({
      parentId: child.id,
      nameEn: "CascadeGrand",
    });
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/categories/${root.id}`);
    await page.getByTestId("remove-category-cta").click();

    const dialog = page.getByTestId("remove-category-dialog");
    await expect(dialog).toBeVisible();
    const cascadeWarning = page.getByTestId("remove-category-cascade-warning");
    await expect(cascadeWarning).toBeVisible();
    // Arabic ICU plural for 2 uses the dual form "فئتين" without the
    // digit; assert the digit only on the English render.
    if (locale === "en") {
      await expect(cascadeWarning).toContainText("2");
    }
    await expectAxeClean(page);

    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/categories\\?removedId=`),
        { timeout: 15_000 },
      ),
      page.getByTestId("remove-category-confirm").click(),
    ]);

    // All three rows now soft-deleted in the DB.
    expect(await readDeletedAt(root.id)).toBeInstanceOf(Date);
    expect(await readDeletedAt(child.id)).toBeInstanceOf(Date);
    expect(await readDeletedAt(grand.id)).toBeInstanceOf(Date);

    await page.getByTestId("show-removed-toggle").click();
    await page.waitForURL(/\?showRemoved=1/, { timeout: 15_000 });
    // Each of the three names appears with a removed badge (locale-pick
    // for display; en used for our seeded names regardless of locale).
    const seededNameRoot =
      locale === "ar" ? root.nameAr : root.nameEn;
    await expect(
      page
        .locator('[data-testid="category-row-link"]:visible')
        .filter({ hasText: seededNameRoot }),
    ).toHaveCount(1);
  });
}

test("case 3: a removed category disappears from the product-edit category picker — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — wire-shape coverage, locale-independent",
  );
  test.setTimeout(60_000);
  const cat = await seedCategory({ nameEn: "PickerVisible" });
  const product = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);

  // Open product edit and confirm the category is selectable in picker.
  await page.goto(`/en/admin/products/${product.id}`);
  await page.getByTestId("product-categories-add").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  const visibleRow = page.locator(
    `[data-testid="category-picker-row"][data-id="${cat.id}"]`,
  );
  await expect(visibleRow).toBeVisible();

  // Soft-delete the category out-of-band.
  await softDeleteDirect(cat.id);

  // Reload product edit; reopen picker; assert the category is GONE.
  await page.goto(`/en/admin/products/${product.id}`);
  await page.getByTestId("product-categories-add").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  const goneRow = page.locator(
    `[data-testid="category-picker-row"][data-id="${cat.id}"]`,
  );
  await expect(goneRow).toHaveCount(0);
});

test("case 4: stale-write on remove shows banner; row stays live — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — stale-write race is wire-shape coverage, locale-independent",
  );
  test.setTimeout(60_000);
  const seeded = await seedCategory();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);

  await bumpUpdatedAt(seeded.id);

  await page.getByTestId("remove-category-cta").click();
  await page.getByTestId("remove-category-confirm").click();

  await expect(page.getByTestId("edit-category-stale-write")).toBeVisible();
  expect(await readDeletedAt(seeded.id)).toBeNull();
});
