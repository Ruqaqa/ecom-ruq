/**
 * Admin edits a category — Tier-4 keep per docs/testing.md §3.
 *
 * §3 reason: rename + re-parent through the picker is the operator's
 * golden-path edit journey. Trimmed per the chunk-4 audit:
 *   - Inner `for (locale of [...])` loops dropped — projects pin a locale.
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - Stale-write OCC banner deleted — §3 explicitly: "stale-write OCC
 *     banners on every form — one test on one form covers the pattern."
 *     edit-product.spec.ts covers it.
 *   - Picker excludes self/descendants deleted — Tier-2 covered as cycle
 *     rejections in tests/unit/services/categories/update-category.test.ts.
 *   - Cancel-with-no-edits navigates back deleted — trivial routing.
 *   - Slug change-warning helper deleted — UI helper text, not a load-bearing
 *     behavior at Tier 4.
 *   - beforeunload sanity deleted — proxy assertion (button-enabled).
 *   - Parent-picker search filter deleted — covered in create-category spec.
 *   - Single axe scan for the /admin/categories/[id] surface (§4.2 — once
 *     per distinct visual page across the suite).
 *
 * Coverage-lint substring contract: `categories.update` (categories.update).
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
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
    title: "Edit category",
    listTitle: "Categories",
    submit: "Save changes",
    cancel: "Cancel",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    title: "تعديل الفئة",
    listTitle: "الفئات",
    submit: "حفظ التغييرات",
    cancel: "إلغاء",
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
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

async function seedCategoryInDevTenant(opts: {
  slug: string;
  parentId?: string | null;
  name?: { en: string; ar: string };
  position?: number;
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const name = opts.name ?? { en: opts.slug, ar: opts.slug };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name, parent_id, position)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${opts.slug},
        ${sql.json(name)},
        ${opts.parentId ?? null},
        ${opts.position ?? 0}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug: opts.slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readCategoryRow(
  categoryId: string,
): Promise<
  | { name: { en: string; ar: string }; parent_id: string | null }
  | undefined
> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<
      Array<{ name: { en: string; ar: string }; parent_id: string | null }>
    >`
      SELECT name, parent_id::text AS parent_id FROM categories WHERE id = ${categoryId}
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function uniqueSlug(tag: string): string {
  return `e2e-ec-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test("admin edit category — rename happy path", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug(`rename-${locale}`),
    name: { en: "Pristine", ar: "أصلي" },
  });
  await signIn(page, locale, OWNER_EMAIL);
  await page.goto(`/${locale}/admin/categories/${seeded.id}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected[locale].title,
  );

  // Submit starts disabled — no edits yet.
  const submit = page.getByTestId("edit-category-submit");
  await expect(submit).toBeDisabled();

  const newNameEn = `Edited-${Date.now()}`;
  await page.locator("#category-name-en").fill(newNameEn);
  await expect(submit).toBeEnabled();

  // Single axe scan for the /admin/categories/[id] surface (§4.2).
  await expectAxeClean(page);

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/categories\\?updatedId=`),
      { timeout: 15_000 },
    ),
    submit.click(),
  ]);
  await expect(page.getByTestId("updated-category-message")).toBeVisible();

  const row = await readCategoryRow(seeded.id);
  expect(row?.name.en).toBe(newNameEn);
});

test("admin edit category — change parent through the picker", async ({
  page,
}) => {
  const newParent = await seedCategoryInDevTenant({
    slug: uniqueSlug("parent-target"),
  });
  const target = await seedCategoryInDevTenant({
    slug: uniqueSlug("reparent-me"),
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${target.id}`);

  // Open picker, pick the new parent, apply, save.
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  const parentRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${newParent.id}"]`) });
  await parentRow.locator('[data-testid="category-picker-radio"]').check();
  await page.getByTestId("category-picker-apply").click();
  await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);

  await page.getByTestId("edit-category-submit").click();
  await page.waitForURL(/\/en\/admin\/categories\?updatedId=/, {
    timeout: 15_000,
  });

  const row = await readCategoryRow(target.id);
  expect(row?.parent_id).toBe(newParent.id);
});

test("admin edit category — Cancel after edits surfaces discard-confirm; discard navigates back without saving", async ({
  page,
}) => {
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug("cancel-dirty"),
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);

  await page.locator("#category-name-en").fill(`Dirty-${Date.now()}`);
  await page.getByTestId("edit-category-cancel").click();
  await expect(
    page.getByTestId("edit-category-discard-confirm"),
  ).toBeVisible();
  await page.getByTestId("edit-category-discard-confirm-yes").click();
  await page.waitForURL(/\/en\/admin\/categories(\?|$)/, { timeout: 15_000 });

  // Name unchanged (discarded).
  const row = await readCategoryRow(seeded.id);
  expect(row?.name.en).toBe(seeded.slug);
});
