/**
 * Chunk 1a.4.2 follow-up — End-to-end: category reorder arrows on the
 * admin list page. Replaces the leaky operator-facing "Position" form
 * field.
 *
 * Coverage:
 *   - Tap the up arrow on a middle row → that row trades positions with
 *     its predecessor; the new order persists in the DB.
 *   - Tap the down arrow on a middle row → trades with successor.
 *   - First row in a sibling group: up arrow not rendered (visual edge).
 *   - Last row in a sibling group: down arrow not rendered (visual edge).
 *   - Mobile viewport, both locales, axe-clean.
 *
 * Coverage-lint substring contract: `categories.moveUp` and
 * `categories.moveDown` (the two new tRPC mutations) must appear in this
 * file (categories.moveUp, categories.moveDown).
 *
 * Per-spec slug-prefix scoping (mirrors the categories-list spec helper)
 * keeps cross-run rows out of the assertions.
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
    listTitle: "Categories",
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    listTitle: "الفئات",
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
  slug: string;
  position: number;
  name?: { en: string; ar: string };
  parentId?: string | null;
}

async function seedCategoryInDevTenant(
  opts: SeedOpts,
): Promise<{ id: string; slug: string }> {
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
        ${opts.position}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug: opts.slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readPositions(
  ids: string[],
): Promise<Map<string, number>> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    // postgres.js: pass a JS array as a single tagged-template
    // parameter to bind it as a postgres array. The cast to uuid[]
    // is required for the IN/ANY comparison against uuid columns.
    const rows = await sql<Array<{ id: string; position: number }>>`
      SELECT id::text AS id, position
      FROM categories
      WHERE id = ANY (${ids}::uuid[])
    `;
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.id, r.position);
    return out;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function scopedSlugs(tag: string): {
  prefix: string;
  slug: (suffix: string) => string;
} {
  const prefix = `e2e-cat-reorder-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    prefix,
    slug: (suffix: string) => `${prefix}-${suffix}`,
  };
}

for (const locale of ["en", "ar"] as const) {
  test(`admin categories reorder — tap up swaps with predecessor, ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const s = scopedSlugs(`up-${locale}`);
    // Seed under a dedicated test-only parent so this run owns the
    // entire sibling group. The dev tenant has many other root-level
    // rows that share the root sibling group; nesting under a unique
    // parent gives unambiguous "first / middle / last" semantics.
    const parent = await seedCategoryInDevTenant({
      slug: s.slug("parent"),
      name: { en: "Reord-Parent", ar: "ر-أب" },
      position: 0,
    });
    const a = await seedCategoryInDevTenant({
      slug: s.slug("aaa"),
      name: { en: "Reord-A", ar: "ر-أ" },
      parentId: parent.id,
      position: 100,
    });
    const b = await seedCategoryInDevTenant({
      slug: s.slug("bbb"),
      name: { en: "Reord-B", ar: "ر-ب" },
      parentId: parent.id,
      position: 101,
    });
    const c = await seedCategoryInDevTenant({
      slug: s.slug("ccc"),
      name: { en: "Reord-C", ar: "ر-س" },
      parentId: parent.id,
      position: 102,
    });

    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/categories`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].listTitle,
    );

    // Wait for our seeded rows to appear (parent + three children).
    const visible = page
      .locator('[data-testid="category-row"]:visible')
      .filter({ hasText: s.prefix });
    await expect(visible).toHaveCount(4, { timeout: 15_000 });

    // axe before tapping (the static page).
    await expectAxeClean(page);

    // Tap the up arrow on the middle (B) row's currently-visible buttons.
    // The row may render in mobile-card OR desktop-table layout depending
    // on viewport — :visible filters to whichever is on-screen.
    const bUpButton = page.locator(
      `[data-testid="category-move-up"][data-id="${b.id}"]:visible`,
    );
    await expect(bUpButton).toBeVisible();
    // Tap target ≥ 44px.
    const bbox = await bUpButton.boundingBox();
    expect(bbox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(bbox?.width ?? 0).toBeGreaterThanOrEqual(44);

    await bUpButton.click();

    // Persisted swap: A and B's positions traded; C unchanged.
    await expect
      .poll(async () => {
        const positions = await readPositions([a.id, b.id, c.id]);
        return positions.get(b.id);
      }, { timeout: 15_000 })
      .toBe(100);
    const after = await readPositions([a.id, b.id, c.id]);
    expect(after.get(a.id)).toBe(101);
    expect(after.get(b.id)).toBe(100);
    expect(after.get(c.id)).toBe(102);
  });
}

test("admin categories reorder — tap down swaps with successor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = scopedSlugs("down");
  const parent = await seedCategoryInDevTenant({
    slug: s.slug("parent"),
    name: { en: "Down-Parent", ar: "د-أب" },
    position: 0,
  });
  const a = await seedCategoryInDevTenant({
    slug: s.slug("aaa"),
    name: { en: "Down-A", ar: "د-أ" },
    parentId: parent.id,
    position: 200,
  });
  const b = await seedCategoryInDevTenant({
    slug: s.slug("bbb"),
    name: { en: "Down-B", ar: "د-ب" },
    parentId: parent.id,
    position: 201,
  });
  const c = await seedCategoryInDevTenant({
    slug: s.slug("ccc"),
    name: { en: "Down-C", ar: "د-س" },
    parentId: parent.id,
    position: 202,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);

  const visible = page
    .locator('[data-testid="category-row"]:visible')
    .filter({ hasText: s.prefix });
  await expect(visible).toHaveCount(4, { timeout: 15_000 });

  const bDownButton = page.locator(
    `[data-testid="category-move-down"][data-id="${b.id}"]:visible`,
  );
  await expect(bDownButton).toBeVisible();
  await bDownButton.click();

  await expect
    .poll(async () => {
      const positions = await readPositions([a.id, b.id, c.id]);
      return positions.get(b.id);
    }, { timeout: 15_000 })
    .toBe(202);
  const after = await readPositions([a.id, b.id, c.id]);
  expect(after.get(a.id)).toBe(200);
  expect(after.get(b.id)).toBe(202);
  expect(after.get(c.id)).toBe(201);
});

test("admin categories reorder — first row's up arrow is not rendered", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = scopedSlugs("first-edge");
  // Seed under a dedicated parent so the first child of THIS group is
  // unambiguous regardless of pre-existing dev-tenant rows.
  const parent = await seedCategoryInDevTenant({
    slug: s.slug("parent"),
    name: { en: "Edge-Parent", ar: "ح-أب" },
    position: 0,
  });
  const first = await seedCategoryInDevTenant({
    slug: s.slug("aaa"),
    name: { en: "Edge-First", ar: "ح-أ" },
    parentId: parent.id,
    position: 300,
  });
  await seedCategoryInDevTenant({
    slug: s.slug("bbb"),
    name: { en: "Edge-Second", ar: "ح-ب" },
    parentId: parent.id,
    position: 301,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);

  // The first row's up button is absent; spacer is present in its place
  // (so layout stays consistent across rows).
  await expect(
    page.locator(
      `[data-testid="category-move-up"][data-id="${first.id}"]:visible`,
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      `[data-testid="category-row"][data-id="${first.id}"]:visible [data-testid="category-move-up-spacer"]`,
    ),
  ).toHaveCount(1);
});

test("admin categories reorder — last row's down arrow is not rendered", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = scopedSlugs("last-edge");
  const parent = await seedCategoryInDevTenant({
    slug: s.slug("parent"),
    name: { en: "Last-Parent", ar: "ل-أب" },
    position: 0,
  });
  await seedCategoryInDevTenant({
    slug: s.slug("aaa"),
    name: { en: "Last-A", ar: "ل-أ" },
    parentId: parent.id,
    position: 400,
  });
  const last = await seedCategoryInDevTenant({
    slug: s.slug("bbb"),
    name: { en: "Last-B", ar: "ل-ب" },
    parentId: parent.id,
    position: 401,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);

  await expect(
    page.locator(
      `[data-testid="category-move-down"][data-id="${last.id}"]:visible`,
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(
      `[data-testid="category-row"][data-id="${last.id}"]:visible [data-testid="category-move-down-spacer"]`,
    ),
  ).toHaveCount(1);
});

test("admin categories reorder — new categories created without explicit position land at the bottom of their parent group", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = scopedSlugs("create-default");
  // Seed two existing roots at low positions to anchor the comparison.
  await seedCategoryInDevTenant({
    slug: s.slug("anchor-a"),
    name: { en: "Anchor-A", ar: "م-أ" },
    position: 0,
  });
  await seedCategoryInDevTenant({
    slug: s.slug("anchor-b"),
    name: { en: "Anchor-B", ar: "م-ب" },
    position: 1,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories/new`);

  const newcomerSlug = s.slug("newcomer");
  await page.locator("#category-name-en").fill("Newcomer");
  await page.locator("#category-name-ar").fill("ج");
  await page.getByTestId("category-slug").fill(newcomerSlug);
  await page.getByTestId("create-category-submit").click();
  await page.waitForURL(/\/en\/admin\/categories\?createdId=/, {
    timeout: 15_000,
  });

  // Newcomer's position must be > the highest existing root in the
  // tenant. We don't assert an exact value because the dev tenant may
  // already have manually-seeded data; the contract is "lands at the
  // bottom" relative to the existing live siblings.
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ position: number; max_other: number }>>`
      SELECT
        c.position,
        COALESCE((
          SELECT MAX(position) FROM categories
          WHERE tenant_id = c.tenant_id
            AND parent_id IS NULL
            AND id <> c.id
            AND deleted_at IS NULL
        ), -1) AS max_other
      FROM categories c
      WHERE slug = ${newcomerSlug}
    `;
    const row = rows[0]!;
    expect(row.position).toBeGreaterThan(row.max_other);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
