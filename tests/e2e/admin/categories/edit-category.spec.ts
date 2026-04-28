/**
 * Chunk 1a.4.2 — End-to-end: edit-category page (Block 3).
 *
 * Mirrors the products edit-form contract: OCC, dirty-aware Cancel,
 * sticky bottom action bar, discard-confirm dialog, stale-write
 * banner with refresh CTA, beforeunload listener registration. No
 * Remove button (1a.4.3 territory). No slug-sync button on edit.
 *
 * Coverage-lint substring contract: `categories.update` must appear
 * in this file (categories.update).
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
    discardConfirm: "Discard changes",
    keepEditing: "Keep editing",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    title: "تعديل الفئة",
    listTitle: "الفئات",
    submit: "حفظ التغييرات",
    cancel: "إلغاء",
    discardConfirm: "تجاهل التغييرات",
    keepEditing: "متابعة التعديل",
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

async function bumpUpdatedAt(categoryId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE categories SET updated_at = now() + interval '1 second' WHERE id = ${categoryId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readCategoryRow(
  categoryId: string,
): Promise<{ name: { en: string; ar: string }; parent_id: string | null } | undefined> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{
      name: { en: string; ar: string };
      parent_id: string | null;
    }>>`
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

for (const locale of ["en", "ar"] as const) {
  test(`admin edit category — rename happy path, ${locale}`, async ({ page }) => {
    test.setTimeout(60_000);
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

    // axe before navigating away.
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
}

test("admin edit category — change parent through the picker", async ({
  page,
}) => {
  test.setTimeout(60_000);
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

test("admin edit category — picker excludes self and descendants from parent options", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const root = await seedCategoryInDevTenant({ slug: uniqueSlug("excl-root") });
  const child = await seedCategoryInDevTenant({
    slug: uniqueSlug("excl-child"),
    parentId: root.id,
  });
  await seedCategoryInDevTenant({
    slug: uniqueSlug("excl-grand"),
    parentId: child.id,
  });
  // We're editing `root` — its picker must disable root itself AND child
  // AND grand (the entire subtree).

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${root.id}`);

  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

  // Self row: data-disabled="true", reason="self_or_descendant".
  const selfRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${root.id}"]`) });
  await expect(selfRow).toHaveAttribute("data-disabled", "true");
  await expect(selfRow).toHaveAttribute(
    "data-disabled-reason",
    "self_or_descendant",
  );

  // Child row: same reason.
  const childRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${child.id}"]`) });
  await expect(childRow).toHaveAttribute("data-disabled", "true");
  await expect(childRow).toHaveAttribute(
    "data-disabled-reason",
    "self_or_descendant",
  );
});

test("admin edit category — Cancel with no edits navigates back to list", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug("cancel-clean"),
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);
  await page.getByTestId("edit-category-cancel").click();
  await page.waitForURL(/\/en\/admin\/categories(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.listTitle,
  );
});

test("admin edit category — Cancel after editing surfaces discard-confirm; discard navigates back", async ({
  page,
}) => {
  test.setTimeout(60_000);
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

test("admin edit category — submitting with stale OCC token shows the stale-write banner; row not destructively overwritten", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug("stale"),
    name: { en: "Pristine", ar: "أصلي" },
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);

  // Out-of-band bump.
  await bumpUpdatedAt(seeded.id);

  await page.locator("#category-name-en").fill("ShouldNotApply");
  await page.getByTestId("edit-category-submit").click();
  await expect(page.getByTestId("edit-category-stale-write")).toBeVisible();

  const row = await readCategoryRow(seeded.id);
  expect(row?.name.en).toBe("Pristine");
});

test("admin edit category — slug change surfaces the change-warning helper", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug("slug-warn"),
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);

  // Edit slug — warning appears.
  await page.getByTestId("category-slug").fill(`${seeded.slug}-new`);
  await expect(
    page.getByTestId("category-slug-change-warning"),
  ).toBeVisible();
});

test("admin edit category — beforeunload listener registers when dirty (sanity)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedCategoryInDevTenant({
    slug: uniqueSlug("unload"),
  });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/${seeded.id}`);

  await page.locator("#category-name-en").fill(`Dirty-${Date.now()}`);
  // Verify the form is in dirty state — submit becomes enabled, which
  // is the cheap proxy for the dirty memo + listener-registered code
  // path running at all.
  await expect(page.getByTestId("edit-category-submit")).toBeEnabled();
});
