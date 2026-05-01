/**
 * Chunk 1a.4.3 — End-to-end: admin restores a removed category.
 *
 * Cases:
 *   1. Restore a removed leaf round-trips — restored-flash visible, row
 *      flips back to live.
 *   2. Disabled-when-parent-removed: a removed child whose parent is
 *      also removed shows a disabled Restore CTA + helper text. Click
 *      does NOT open the dialog.
 *   3. Restore the parent first → child's CTA re-enables; restore round-
 *      trips successfully.
 *   4. Slug collision on restore surfaces the user-friendly error.
 *
 * References tRPC mutation `categories.restore` so check:e2e-coverage
 * finds it. Wire path: categories.restore.
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
  },
  ar: {
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

interface SeedOpts {
  slug?: string;
  parentId?: string | null;
  deletedDaysAgo?: number;
  nameEn?: string;
  nameAr?: string;
}

async function seedCategory(
  opts: SeedOpts = {},
): Promise<{ id: string; slug: string; nameEn: string; nameAr: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = opts.slug ?? `e2e-rst-cat-${randomUUID().slice(0, 8)}`;
    const en = `${opts.nameEn ?? "RestorableCat"}-${randomUUID().slice(0, 6)}`;
    const ar = `${opts.nameAr ?? "فئة-قابلة-للاستعادة"}-${randomUUID().slice(0, 6)}`;
    const days = opts.deletedDaysAgo;
    if (typeof days === "number") {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO categories (tenant_id, slug, name, parent_id, deleted_at)
        VALUES (
          (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
          ${slug},
          ${sql.json({ en, ar })},
          ${opts.parentId ?? null},
          now() - (${days}::int || ' days')::interval
        )
        RETURNING id::text AS id
      `;
      return { id: rows[0]!.id, slug, nameEn: en, nameAr: ar };
    }
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

for (const locale of ["en", "ar"] as const) {
  test(`case 1: restore a removed leaf round-trips — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seeded = await seedCategory({ deletedDaysAgo: 1 });
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/categories?showRemoved=1`);
    const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
    const rowLink = page
      .locator('[data-testid="category-row-link"]:visible')
      .filter({ hasText: seededName });
    await expect(rowLink).toHaveCount(1);
    const row = rowLink.locator(
      'xpath=ancestor::*[@data-testid="category-row"][1]',
    );

    const restoreCta = row.getByTestId("restore-category-cta").first();
    await expect(restoreCta).toBeEnabled();
    const ctaBox = await restoreCta.boundingBox();
    expect(ctaBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await restoreCta.click();

    const dialog = row.getByTestId("restore-category-dialog").first();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(seededName);
    await expect(dialog).not.toContainText("{name}");
    await expectAxeClean(page);

    await row.getByTestId("restore-category-confirm").first().click();

    await expect(page.getByTestId("restored-category-message")).toBeVisible({
      timeout: 15_000,
    });
    expect(await readDeletedAt(seeded.id)).toBeNull();
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`case 2: restore CTA disabled when parent is still removed — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const parent = await seedCategory({ deletedDaysAgo: 1 });
    const child = await seedCategory({
      parentId: parent.id,
      deletedDaysAgo: 1,
    });
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/categories?showRemoved=1`);
    const childName = locale === "ar" ? child.nameAr : child.nameEn;
    const childLink = page
      .locator('[data-testid="category-row-link"]:visible')
      .filter({ hasText: childName });
    await expect(childLink).toHaveCount(1);
    const childRow = childLink.locator(
      'xpath=ancestor::*[@data-testid="category-row"][1]',
    );

    const childCta = childRow.getByTestId("restore-category-cta").first();
    await expect(childCta).toBeDisabled();
    await expect(childCta).toHaveAttribute(
      "data-disabled-reason",
      "parent-still-removed",
    );
    await expect(
      childRow.getByTestId("restore-disabled-help").first(),
    ).toBeVisible();

    // Click round-trip is short-circuited — the dialog must NOT open.
    await childCta.click({ force: true }).catch(() => {
      // disabled buttons swallow clicks; ignore the implicit error.
    });
    await expect(
      childRow.getByTestId("restore-category-dialog"),
    ).toHaveCount(0);
    expect(await readDeletedAt(child.id)).toBeInstanceOf(Date);
  });
}

test("case 3: restoring the parent re-enables the child's CTA; child round-trips — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — wire-shape coverage, locale-independent",
  );
  test.setTimeout(90_000);
  const parent = await seedCategory({ deletedDaysAgo: 1 });
  const child = await seedCategory({
    parentId: parent.id,
    deletedDaysAgo: 1,
  });
  await signIn(page, "en", OWNER_EMAIL);

  await page.goto(`/en/admin/categories?showRemoved=1`);

  // Restore parent first.
  const parentLink = page
    .locator('[data-testid="category-row-link"]:visible')
    .filter({ hasText: parent.nameEn });
  const parentRow = parentLink.locator(
    'xpath=ancestor::*[@data-testid="category-row"][1]',
  );
  await parentRow.getByTestId("restore-category-cta").first().click();
  await parentRow.getByTestId("restore-category-confirm").first().click();
  await expect(page.getByTestId("restored-category-message")).toBeVisible({
    timeout: 15_000,
  });

  // Reload to refetch the tree; the child's CTA is now enabled.
  await page.goto(`/en/admin/categories?showRemoved=1`);
  const childLink = page
    .locator('[data-testid="category-row-link"]:visible')
    .filter({ hasText: child.nameEn });
  const childRow = childLink.locator(
    'xpath=ancestor::*[@data-testid="category-row"][1]',
  );
  const childCta = childRow.getByTestId("restore-category-cta").first();
  await expect(childCta).toBeEnabled();
  await childCta.click();
  await childRow.getByTestId("restore-category-confirm").first().click();
  await expect(page.getByTestId("restored-category-message")).toBeVisible({
    timeout: 15_000,
  });
  expect(await readDeletedAt(child.id)).toBeNull();
});

test("case 4: slug collision on restore surfaces user-friendly error — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — wire-shape coverage, locale-independent",
  );
  test.setTimeout(60_000);
  const dupSlug = `e2e-rst-dup-${randomUUID().slice(0, 8)}`;
  const removed = await seedCategory({
    slug: dupSlug,
    deletedDaysAgo: 2,
  });
  // While `removed` is removed, create a new live row that takes the slug.
  await seedCategory({ slug: dupSlug });
  await signIn(page, "en", OWNER_EMAIL);

  await page.goto(`/en/admin/categories?showRemoved=1`);
  const link = page
    .locator('[data-testid="category-row-link"]:visible')
    .filter({ hasText: removed.nameEn });
  const row = link.locator(
    'xpath=ancestor::*[@data-testid="category-row"][1]',
  );
  await row.getByTestId("restore-category-cta").first().click();
  await row.getByTestId("restore-category-confirm").first().click();

  // Error surfaces inline on the row.
  const err = row.getByTestId("restore-error-slugTaken").first();
  await expect(err).toBeVisible({ timeout: 15_000 });
  // Row stays removed.
  expect(await readDeletedAt(removed.id)).toBeInstanceOf(Date);
});
