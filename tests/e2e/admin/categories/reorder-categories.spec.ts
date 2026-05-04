/**
 * Admin reorders categories with the row arrows — Tier-4 keep per
 * docs/testing.md §3.
 *
 * §3 reason: pointer-activated swap is the operator's only way to change
 * sibling order in the catalog tree. The smoke verifies tap-target
 * activation + post-mutation refetch + visible reorder.
 *
 * Trimmed per the chunk-4 audit:
 *   - Inner `for (locale of [...])` loops dropped — projects pin a locale.
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - First-row-no-up + last-row-no-down deleted — visual edge cases that
 *     don't earn a browser test.
 *   - Multi-tie regression deleted — Tier-2 covered in
 *     tests/unit/services/categories/move-category.test.ts (multi-tie up
 *     and down tests).
 *   - "New categories land at bottom" deleted — Tier-2 covered in
 *     move-category.test.ts (createCategory invariants).
 *   - Two separate tests (up + down) collapsed into one round-trip: tap
 *     up, then tap down on the same row, asserting the row returns to its
 *     original position.
 *
 * Coverage-lint substring contract: `categories.moveUp` and
 * `categories.moveDown` (categories.moveUp, categories.moveDown).
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
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

async function readPositions(ids: string[]): Promise<Map<string, number>> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
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

test("admin categories reorder — tap up then tap down round-trips a middle row", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const s = scopedSlugs(`roundtrip-${locale}`);
  // Seed under a dedicated parent so this run owns the entire sibling
  // group regardless of pre-existing dev-tenant rows.
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

  // Wait for our seeded rows (parent + three children) to appear.
  const visible = page
    .locator('[data-testid="category-row"]:visible')
    .filter({ hasText: s.prefix });
  await expect(visible).toHaveCount(4, { timeout: 15_000 });

  // Tap up on B → B and A swap positions.
  const bUp = page.locator(
    `[data-testid="category-move-up"][data-id="${b.id}"]:visible`,
  );
  await expect(bUp).toBeVisible();
  await bUp.click();

  await expect
    .poll(
      async () => {
        const positions = await readPositions([a.id, b.id, c.id]);
        return positions.get(b.id);
      },
      { timeout: 15_000 },
    )
    .toBe(100);
  const after = await readPositions([a.id, b.id, c.id]);
  expect(after.get(a.id)).toBe(101);
  expect(after.get(b.id)).toBe(100);
  expect(after.get(c.id)).toBe(102);

  // Tap down on B (now in slot 100) → B returns to slot 101.
  const bDown = page.locator(
    `[data-testid="category-move-down"][data-id="${b.id}"]:visible`,
  );
  await expect(bDown).toBeVisible();
  await bDown.click();
  await expect
    .poll(
      async () => {
        const positions = await readPositions([a.id, b.id, c.id]);
        return positions.get(b.id);
      },
      { timeout: 15_000 },
    )
    .toBe(101);
});
