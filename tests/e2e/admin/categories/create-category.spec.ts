/**
 * Chunk 1a.4.2 — End-to-end: create-category page.
 *
 * Covers Block 2 of the master brief AND exercises the shared
 * `<CategoryPickerSheet>` (sliced forward into Block 2 because the
 * parent picker depends on it). Block 4's product-form integration
 * spec is a separate file.
 *
 * Coverage-lint substring contract: `categories.create` must appear
 * in this file (categories.create).
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
    title: "New category",
    submit: "Create category",
    listTitle: "Categories",
    nameEnLabel: "Name (English)",
    nameArLabel: "Name (Arabic)",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    title: "فئة جديدة",
    submit: "إنشاء الفئة",
    listTitle: "الفئات",
    nameEnLabel: "الاسم (بالإنجليزية)",
    nameArLabel: "الاسم (بالعربية)",
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

function uniqueSlug(tag: string): string {
  return `e2e-cc-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

for (const locale of ["en", "ar"] as const) {
  test(`admin create category — root happy path, ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/categories/new`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].title,
    );

    const slugInput = page.getByTestId("category-slug");
    const submit = page.getByTestId("create-category-submit");

    // Tap targets ≥ 44px on the primary CTA.
    const submitBox = await submit.boundingBox();
    expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Auto-derive: typing in the English name flows into the slug.
    const tag = `Root-${Date.now()}`;
    await page.locator("#category-name-en").fill(tag);
    await expect(slugInput).toHaveValue(/^root-\d+/i);

    // Edit the slug → slugDirty fires → typing in name no longer overwrites.
    await slugInput.fill("dirty-slug");
    await page.locator("#category-name-en").fill(`${tag}-Plus`);
    await expect(slugInput).toHaveValue("dirty-slug");

    // Sync button reverts dirty + re-derives from name.
    await page.getByTestId("category-slug-sync").click();
    await expect(slugInput).toHaveValue(/^root-\d+-plus/i);

    // Provide a fresh unique slug (so we don't collide with prior runs).
    const finalSlug = uniqueSlug(`root-${locale}`);
    await slugInput.fill(finalSlug);
    await page.locator("#category-name-ar").fill("جذر");

    // axe with picker closed.
    await expectAxeClean(page);

    await submit.click();
    await page.waitForURL(
      new RegExp(`/${locale}/admin/categories\\?createdId=`),
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("created-category-message")).toBeVisible();
  });
}

test("admin create category — slug shape errors render inline (live)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  // Manually type a bad slug.
  await page.getByTestId("category-slug").fill("Bad Slug!");
  await expect(page.locator("#category-slug-error")).toBeVisible();
});

test("admin create category — slug-taken collision surfaces inline error", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Seed a category whose slug we'll collide with.
  const dup = uniqueSlug("dup");
  await seedCategoryInDevTenant({ slug: dup });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  await page.locator("#category-name-en").fill("Collide");
  await page.locator("#category-name-ar").fill("تصادم");
  await page.getByTestId("category-slug").fill(dup);
  await page.getByTestId("create-category-submit").click();

  // The form stays on the page with an inline slug error.
  await expect(page.locator("#category-slug-error")).toBeVisible();
  await expect(page).toHaveURL(/\/en\/admin\/categories\/new$/);
});

test("admin create category — child happy path uses parent picker; depth-3 row is disabled", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Seed a 3-level chain so the picker has a depth-3 row to disable.
  const root = await seedCategoryInDevTenant({ slug: uniqueSlug("p-root") });
  const child = await seedCategoryInDevTenant({
    slug: uniqueSlug("p-child"),
    parentId: root.id,
  });
  const grand = await seedCategoryInDevTenant({
    slug: uniqueSlug("p-grand"),
    parentId: child.id,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  await page.locator("#category-name-en").fill(`Child-${Date.now()}`);
  await page.locator("#category-name-ar").fill("فرع");
  const targetSlug = uniqueSlug("childpicked");
  await page.getByTestId("category-slug").fill(targetSlug);

  // Open picker.
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

  // axe with picker open.
  await expectAxeClean(page);

  // Depth-3 row is disabled with the depth_cap reason.
  const grandRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${grand.id}"]`) });
  await expect(grandRow).toHaveAttribute("data-disabled", "true");
  await expect(grandRow).toHaveAttribute("data-disabled-reason", "depth_cap");

  // Pick the depth-2 (child) row as parent.
  const childRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${child.id}"]`) });
  await expect(childRow).toHaveAttribute("data-depth", "2");
  await childRow.locator('[data-testid="category-picker-radio"]').check();

  // Apply commits.
  await page.getByTestId("category-picker-apply").click();
  await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);

  // Submit and verify the new category landed under the picked parent.
  await page.getByTestId("create-category-submit").click();
  await page.waitForURL(/\/en\/admin\/categories\?createdId=/, {
    timeout: 15_000,
  });

  // Verify in the DB that the parentId matches `child.id`.
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ parent_id: string | null }>>`
      SELECT parent_id::text AS parent_id FROM categories WHERE slug = ${targetSlug}
    `;
    expect(rows[0]?.parent_id).toBe(child.id);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("admin create category — picker Cancel is a true no-op", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const root = await seedCategoryInDevTenant({ slug: uniqueSlug("cancel-root") });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  // Initial display is "(top-level)".
  const display = page.getByTestId("category-parent-display");
  await expect(display).toHaveText("(top-level)");

  // Open picker, click a row, then Cancel — display unchanged.
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  const rootRow = page
    .getByTestId("category-picker-row")
    .filter({ has: page.locator(`[data-id="${root.id}"]`) });
  await rootRow.locator('[data-testid="category-picker-radio"]').check();
  await page.getByTestId("category-picker-cancel").click();
  await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);
  await expect(display).toHaveText("(top-level)");
});

test("admin create category — Escape closes picker; backdrop closes picker", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  // Escape.
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);

  // Backdrop click. The backdrop is an absolutely-positioned button
  // sitting under the centered sheet section — clicking the geometric
  // center of the backdrop hits the section instead. Click the
  // top-left corner where the section doesn't reach. force:true
  // dispatches without re-targeting.
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();
  await page
    .getByTestId("category-picker-backdrop")
    .click({ force: true, position: { x: 5, y: 5 } });
  await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);
});

// 1a.4.2 follow-up: the parent picker on the create-category page must
// expose its search input and typing into it must filter rows. Both
// localized name and slug are matched (case-insensitive). Regression
// test for `searchable={false}` having been wired in by mistake.
for (const locale of ["en", "ar"] as const) {
  test(`admin create category — parent-picker search filters rows on typing, ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // Two distinct seeds: localized names per locale, plus a Latin slug
    // we can match independently. The third (a "decoy") must NOT appear
    // when we filter for one of the others.
    const tagPens = locale === "en" ? "Pens" : "أقلام";
    const tagBooks = locale === "en" ? "Notebooks" : "دفاتر";
    const tagDecoy = locale === "en" ? "Erasers" : "محايات";
    const slugPens = uniqueSlug("search-pens");
    const slugBooks = uniqueSlug("search-books");
    const slugDecoy = uniqueSlug("search-decoy");
    const pens = await seedCategoryInDevTenant({
      slug: slugPens,
      name: { en: "Pens", ar: "أقلام" },
    });
    const books = await seedCategoryInDevTenant({
      slug: slugBooks,
      name: { en: "Notebooks", ar: "دفاتر" },
    });
    const decoy = await seedCategoryInDevTenant({
      slug: slugDecoy,
      name: { en: "Erasers", ar: "محايات" },
    });

    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/categories/new`);
    await page.getByTestId("category-parent-trigger").click();
    await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

    // The search input must be rendered.
    const search = page.getByTestId("category-picker-search");
    await expect(search).toBeVisible();

    // axe with picker open and search visible.
    await expectAxeClean(page);

    // All three seeded rows present before any filtering.
    const pensRow = page.locator(
      `[data-testid="category-picker-row"][data-id="${pens.id}"]`,
    );
    const booksRow = page.locator(
      `[data-testid="category-picker-row"][data-id="${books.id}"]`,
    );
    const decoyRow = page.locator(
      `[data-testid="category-picker-row"][data-id="${decoy.id}"]`,
    );
    await expect(pensRow).toBeVisible();
    await expect(booksRow).toBeVisible();
    await expect(decoyRow).toBeVisible();

    // Filter by localized name — only the matching row stays visible.
    await search.fill(tagPens);
    await expect(pensRow).toBeVisible();
    await expect(booksRow).toHaveCount(0);
    await expect(decoyRow).toHaveCount(0);

    // Switch the query — different match, again only the matching row.
    await search.fill(tagBooks);
    await expect(booksRow).toBeVisible();
    await expect(pensRow).toHaveCount(0);
    await expect(decoyRow).toHaveCount(0);

    // Slug match works too — a Latin substring of the books slug must
    // surface that row regardless of locale.
    await search.fill(slugBooks);
    await expect(booksRow).toBeVisible();
    await expect(pensRow).toHaveCount(0);
    await expect(decoyRow).toHaveCount(0);

    // Garbage query — no rows; the no-results message renders instead.
    await search.fill("zzz-no-such-category-zzz");
    await expect(
      page.getByTestId("category-picker-no-results"),
    ).toBeVisible();

    // Clearing the search restores all rows.
    await search.fill("");
    await expect(pensRow).toBeVisible();
    await expect(booksRow).toBeVisible();
    await expect(decoyRow).toBeVisible();

    // Picking a row after a filter still works end-to-end (Apply commits
    // the visible row's id to the parent display).
    await search.fill(tagDecoy);
    await expect(decoyRow).toBeVisible();
    await decoyRow.locator('[data-testid="category-picker-radio"]').check();
    await page.getByTestId("category-picker-apply").click();
    await expect(page.getByTestId("category-picker-sheet")).toHaveCount(0);
    const decoyDisplayName = locale === "en" ? "Erasers" : "محايات";
    await expect(
      page.getByTestId("category-parent-display"),
    ).toContainText(decoyDisplayName);
  });
}

