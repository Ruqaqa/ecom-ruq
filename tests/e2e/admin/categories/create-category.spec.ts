/**
 * Admin creates a category — Tier-4 keep per docs/testing.md §3.
 *
 * §3 reason: full integration of routing + form + slug auto-derive +
 * parent picker + post-mutation redirect. Trimmed per the chunk-4 audit:
 *   - Inner `for (locale of [...])` loops dropped — projects pin a locale.
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - Slug-shape inline error (Bad Slug!) deleted — Zod-shape validation
 *     covered at Tier 2 in
 *     tests/unit/services/categories/create-category.test.ts.
 *   - Slug-collision deleted — Tier-2 covered (slug_taken case in
 *     create-category.test.ts).
 *   - Picker Cancel-no-op + Escape + backdrop deleted — these are dialog
 *     mechanics not category-specific behavior; §3 explicitly excludes
 *     "validation paths that have a Tier-2 equivalent" and dialog UX is
 *     not on the keep list.
 *
 * Coverage-lint substring contract: `categories.create` (categories.create).
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
    nameEnLabel: "Name (English)",
    nameArLabel: "Name (Arabic)",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    title: "فئة جديدة",
    submit: "إنشاء الفئة",
    nameEnLabel: "الاسم (بالإنجليزية)",
    nameArLabel: "الاسم (بالعربية)",
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

function uniqueSlug(tag: string): string {
  return `e2e-cc-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test("admin create category — root happy path: auto-derive slug, sync, submit", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await signIn(page, locale, OWNER_EMAIL);
  await page.goto(`/${locale}/admin/categories/new`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected[locale].title,
  );

  const slugInput = page.getByTestId("category-slug");
  const submit = page.getByTestId("create-category-submit");

  // Auto-derive: typing in the English name flows into the slug.
  const tag = `Root-${Date.now()}`;
  await page.locator("#category-name-en").fill(tag);
  await expect(slugInput).toHaveValue(/^root-\d+/i);

  // Edit slug → slugDirty fires → typing in name no longer overwrites.
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

  await submit.click();
  await page.waitForURL(
    new RegExp(`/${locale}/admin/categories\\?createdId=`),
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("created-category-message")).toBeVisible();
});

test("admin create category — child happy path uses parent picker; depth-3 row is disabled", async ({
  page,
}) => {
  // Single-project — wire-shape coverage, locale-independent.
  // (axe scan on this surface is covered by the parent-picker-search test.)
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

// Regression test for `searchable={false}` having been wired in by mistake.
// The picker filters rows by the active locale's name (or the Latin slug),
// so each project asserts using its own localized query.
test("admin create category — parent-picker search filters by name and slug", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  // Three seeds with both-locale names + Latin slugs. The decoy must NOT
  // appear when we filter for one of the others.
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
  // Locale-appropriate query for "books"-equivalent.
  const booksQuery = locale === "ar" ? "دفاتر" : "Notebooks";

  await signIn(page, locale, OWNER_EMAIL);
  await page.goto(`/${locale}/admin/categories/new`);
  await page.getByTestId("category-parent-trigger").click();
  await expect(page.getByTestId("category-picker-sheet")).toBeVisible();

  // The search input must be rendered.
  const search = page.getByTestId("category-picker-search");
  await expect(search).toBeVisible();

  // Single axe scan for the picker-sheet surface (§4.2 — once per
  // distinct visual surface across the suite).
  await expectAxeClean(page);

  const pensRow = page.locator(
    `[data-testid="category-picker-row"][data-id="${pens.id}"]`,
  );
  const booksRow = page.locator(
    `[data-testid="category-picker-row"][data-id="${books.id}"]`,
  );
  const decoyRow = page.locator(
    `[data-testid="category-picker-row"][data-id="${decoy.id}"]`,
  );

  // Filter by localized name → only that row stays.
  await search.fill(booksQuery);
  await expect(booksRow).toBeVisible();
  await expect(pensRow).toHaveCount(0);
  await expect(decoyRow).toHaveCount(0);

  // Latin slug substring works regardless of locale.
  await search.fill(slugDecoy);
  await expect(decoyRow).toBeVisible();
  await expect(pensRow).toHaveCount(0);
  await expect(booksRow).toHaveCount(0);

  // Garbage query → no results message renders.
  await search.fill("zzz-no-such-category-zzz");
  await expect(page.getByTestId("category-picker-no-results")).toBeVisible();
});
