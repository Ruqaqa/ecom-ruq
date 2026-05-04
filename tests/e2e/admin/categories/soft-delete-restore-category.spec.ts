/**
 * Admin removes + restores a category — Tier-4 keep per docs/testing.md §3.
 *
 * Mirrors `soft-delete-product.spec.ts` after the chunk-2 audit:
 *   - Inner `for (locale of [...])` loops dropped — projects pin a locale.
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - Cascade content (case 2: warning text + parent-removal flips subtree)
 *     deleted — Tier-2 covers cascade in
 *     tests/unit/services/categories/delete-category.test.ts (root + mid-tree
 *     cascade tests). The cascade-warning string itself is UI copy, not a
 *     load-bearing user journey.
 *   - Picker-disappearance after soft-delete (case 3) deleted — overlaps
 *     with chunk-3's product-categories territory and is Tier-2 covered in
 *     list-categories.test.ts (excludes deleted by default).
 *   - Stale-write on remove (case 4) deleted — §3 explicitly: "stale-write
 *     OCC banners on every form — one test on one form covers the pattern."
 *     edit-product covers it.
 *   - Restore: parent-still-removed disabled CTA, restore-after-parent-restore,
 *     and slug-collision-on-restore all deleted — covered at Tier 2 in
 *     restore-category.test.ts (parent_still_removed, restore-after-parent,
 *     slug-collision tests).
 *
 * References tRPC mutations `categories.delete` and `categories.restore`
 * so check:e2e-coverage finds them (also at Tier 2 — categories.delete,
 * categories.restore — the substring lookup is satisfied at any tier per
 * docs/testing.md §7).
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
    editTitle: "Edit category",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    editTitle: "تعديل الفئة",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: {
  project: { metadata?: { locale?: string } };
}): Locale {
  return testInfo.project.metadata?.locale === "ar" ? "ar" : "en";
}

async function signIn(
  page: Page,
  locale: Locale,
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
  deletedDaysAgo?: number;
  nameEn?: string;
  nameAr?: string;
}

async function seedCategory(
  opts: SeedOpts = {},
): Promise<{ id: string; slug: string; nameEn: string; nameAr: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = opts.slug ?? `e2e-cat-sdr-${randomUUID().slice(0, 8)}`;
    const en = `${opts.nameEn ?? "RemovableCat"}-${randomUUID().slice(0, 6)}`;
    const ar = `${opts.nameAr ?? "فئة-قابلة-للحذف"}-${randomUUID().slice(0, 6)}`;
    const days = opts.deletedDaysAgo;
    if (typeof days === "number") {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO categories (tenant_id, slug, name, deleted_at)
        VALUES (
          (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
          ${slug},
          ${sql.json({ en, ar })},
          now() - (${days}::int || ' days')::interval
        )
        RETURNING id::text AS id
      `;
      return { id: rows[0]!.id, slug, nameEn: en, nameAr: ar };
    }
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en, ar })}
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

test("owner removes a leaf category from the edit page; row hides from default list", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const seeded = await seedCategory();
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/categories/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected[locale].editTitle,
  );

  await page.getByTestId("remove-category-cta").click();
  const dialog = page.getByTestId("remove-category-dialog");
  await expect(dialog).toBeVisible();
  // ICU MessageFormat substitution sanity — the heading must show the
  // seeded name, not an un-substituted `{name}` token.
  const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
  await expect(dialog).toContainText(seededName);
  await expect(dialog).not.toContainText("{name}");

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/categories\\?removedId=`),
      { timeout: 15_000 },
    ),
    page.getByTestId("remove-category-confirm").click(),
  ]);
  await expect(page.getByTestId("removed-category-message")).toBeVisible();

  // DB confirms soft-delete.
  expect(await readDeletedAt(seeded.id)).toBeInstanceOf(Date);

  // Default list does NOT include the removed row.
  const links = page.getByTestId("category-row-link");
  const hrefs = await links.evaluateAll((els) =>
    els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
  );
  expect(
    hrefs.every((h) => !h.endsWith(`/admin/categories/${seeded.id}`)),
  ).toBe(true);
});

test("show-removed toggle reveals removed rows and restore round-trips", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const seeded = await seedCategory({ deletedDaysAgo: 1 });
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/categories?showRemoved=1`);

  const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
  const rowLink = page
    .locator('[data-testid="category-row-link"]:visible')
    .filter({ hasText: seededName });
  await expect(rowLink).toHaveCount(1, { timeout: 15_000 });
  const row = rowLink.locator(
    'xpath=ancestor::*[@data-testid="category-row"][1]',
  );
  await expect(row).toHaveAttribute("data-removed", "true");

  // Single axe scan for the /admin/categories list page (§4.2 — once per
  // page, once per locale via the project matrix).
  await expectAxeClean(page);

  const restoreCta = row.getByTestId("restore-category-cta").first();
  await expect(restoreCta).toBeEnabled();
  await restoreCta.click();
  const restoreDialog = row.getByTestId("restore-category-dialog").first();
  await expect(restoreDialog).toBeVisible();
  await expect(restoreDialog).toContainText(seededName);
  await expect(restoreDialog).not.toContainText("{name}");

  await row.getByTestId("restore-category-confirm").first().click();
  await expect(page.getByTestId("restored-category-message")).toBeVisible({
    timeout: 15_000,
  });
  expect(await readDeletedAt(seeded.id)).toBeNull();
});
