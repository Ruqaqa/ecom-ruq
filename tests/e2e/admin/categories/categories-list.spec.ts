/**
 * Chunk 1a.4.2 — End-to-end: admin categories list page.
 *
 * Mirrors `list-products.spec.ts` shape:
 *   - Owner happy path × en+ar mobile (axe clean, 44px tap targets,
 *     CTA navigates to the new-category form).
 *   - Tree-indent rendering: rows carry `data-depth="1|2|3"`.
 *   - Sort: parent NULLS FIRST → position → name (asserted by reading
 *     row order from a per-spec slug-prefix scoped Locator).
 *   - Show-removed toggle: existing toggle and URL param round-trip
 *     (no removed rows in 1a.4.2 — Restore action ships in 1a.4.3).
 *   - Anonymous → /signin; customer → /signin?denied=admin.
 *   - Tenant isolation: rows from another tenant don't appear here.
 *
 * Coverage-lint substring contract: `categories.list` (the existing
 * tRPC read) must appear somewhere in this file so
 * `pnpm check:e2e-coverage` ties the read path to a Playwright
 * reference. The substring is in this comment block (categories.list)
 * to satisfy the lint without polluting test code.
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  CUSTOMER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const expected = {
  en: {
    signInTitle: "Sign in",
    signInSubmit: "Sign in",
    listTitle: "Categories",
    createCta: "Create category",
    showRemoved: "Show removed",
    showingRemoved: "Showing removed",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInSubmit: "تسجيل الدخول",
    listTitle: "الفئات",
    createCta: "إنشاء فئة",
    showRemoved: "عرض المحذوفة",
    showingRemoved: "عرض المحذوفة الحالي",
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

interface SeedCategoryOpts {
  slug: string;
  parentId?: string | null;
  position?: number;
  name?: { en: string; ar: string };
  deletedAt?: Date | null;
}

async function seedCategoryInDevTenant(
  opts: SeedCategoryOpts,
): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const name = opts.name ?? {
      en: opts.slug,
      ar: opts.slug,
    };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name, parent_id, position, deleted_at)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${opts.slug},
        ${sql.json(name)},
        ${opts.parentId ?? null},
        ${opts.position ?? 0},
        ${opts.deletedAt ? opts.deletedAt.toISOString() : null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug: opts.slug };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedIsolatedTenantCategory(): Promise<{
  tenantId: string;
  slug: string;
  canary: string;
}> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenantId = randomUUID();
    const slug = `iso-${tenantId.slice(0, 8)}`;
    const host = `${slug}.iso.test`;
    const canary = `ISOCAT-${randomUUID().slice(0, 8)}`;
    await sql`
      INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
      VALUES (${tenantId}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
        ${sql.json({ en: "Iso", ar: "ع" })}, 'active')
    `;
    await sql`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (${tenantId}, ${`isocat-${randomUUID().slice(0, 8)}`},
        ${sql.json({ en: canary, ar: canary })})
    `;
    return { tenantId, slug, canary };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Per-spec slug-prefix scoping (mirrors the products spec helper).
 * Returns a function that builds slugs for this spec run, and a
 * Locator-builder that selects only this run's rows from the DOM.
 */
function scopedSlugs(tag: string): {
  prefix: string;
  slug: (suffix: string) => string;
  rows: (page: Page) => ReturnType<Page["getByTestId"]>;
} {
  const prefix = `e2e-cat-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    prefix,
    slug: (suffix: string) => `${prefix}-${suffix}`,
    rows: (page) =>
      page
        .getByTestId("category-row")
        .filter({ hasText: prefix }) as unknown as ReturnType<
        Page["getByTestId"]
      >,
  };
}

for (const locale of ["en", "ar"] as const) {
  test(`admin categories list — happy path with tree indent + CTA, ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const s = scopedSlugs(`happy-${locale}`);
    const root = await seedCategoryInDevTenant({
      slug: s.slug("root"),
      position: 0,
    });
    const child = await seedCategoryInDevTenant({
      slug: s.slug("child"),
      parentId: root.id,
      position: 0,
    });
    await seedCategoryInDevTenant({
      slug: s.slug("grand"),
      parentId: child.id,
      position: 0,
    });

    await signIn(page, locale, OWNER_EMAIL);
    await page.goto(`/${locale}/admin/categories`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].listTitle,
    );
    const cta = page.getByTestId("create-category-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(expected[locale].createCta);
    const ctaBox = await cta.boundingBox();
    expect(ctaBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Three depth-1/2/3 rows from this spec are visible somewhere on the
    // page. The page renders BOTH a mobile card list AND a desktop table
    // (one is hidden via CSS at the md breakpoint). Filter to :visible
    // so the assertion picks whichever layout the current project's
    // viewport rendered.
    const visibleScoped = page
      .locator('[data-testid="category-row"]:visible')
      .filter({ hasText: s.prefix });
    await expect(visibleScoped.first()).toBeVisible({ timeout: 15_000 });

    const depths = await visibleScoped.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getAttribute("data-depth") ?? ""),
    );
    expect(depths.sort()).toEqual(["1", "2", "3"]);

    await expectAxeClean(page);

    // CTA navigates to the create form.
    await cta.click();
    await page.waitForURL(
      new RegExp(`/${locale}/admin/categories/new`),
      { timeout: 15_000 },
    );
  });
}

test("admin categories list — sort: parent NULLS FIRST → position → name", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = scopedSlugs("sort");
  // Two roots with different positions → position-2 root must render
  // before position-3 root within the prefix scope.
  const rootEarly = await seedCategoryInDevTenant({
    slug: s.slug("rootB"),
    name: { en: "B-Root", ar: "ب" },
    position: 2,
  });
  const rootLate = await seedCategoryInDevTenant({
    slug: s.slug("rootA"),
    name: { en: "A-Root", ar: "أ" },
    position: 3,
  });
  // Child of the early root → must come AFTER both roots (parent NULLS FIRST).
  await seedCategoryInDevTenant({
    slug: s.slug("childOfEarly"),
    parentId: rootEarly.id,
    position: 0,
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);

  const visibleScoped = page
    .locator('[data-testid="category-row"]:visible')
    .filter({ hasText: s.prefix });
  await expect(visibleScoped).toHaveCount(3, { timeout: 15_000 });

  // Read row order via the data-id attribute on each scoped row.
  const orderedIds = await visibleScoped.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getAttribute("data-id") ?? ""),
  );
  // Expected order: rootEarly (pos 2), rootLate (pos 3), childOfEarly.
  expect(orderedIds).toEqual([rootEarly.id, rootLate.id, expect.any(String)]);
  // The third must be the child of rootEarly, not a different row.
  expect(orderedIds[2]).not.toBe(rootEarly.id);
  expect(orderedIds[2]).not.toBe(rootLate.id);
});

test("admin categories list — Show removed toggle round-trips via URL param", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);

  const toggle = page.getByTestId("show-removed-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-state", "off");
  await expect(toggle).toHaveText(expected.en.showRemoved);

  // Click toggle → URL flips to ?showRemoved=1 and label flips.
  await toggle.click();
  await expect(page).toHaveURL(/[?&]showRemoved=1/, { timeout: 5_000 });
  await expect(page.getByTestId("show-removed-toggle")).toHaveAttribute(
    "data-state",
    "on",
  );
  await expect(page.getByTestId("show-removed-toggle")).toHaveText(
    expected.en.showingRemoved,
  );
});

test("admin categories list — anonymous redirects to /signin", async ({
  page,
}) => {
  await page.goto(`/en/admin/categories`);
  await page.waitForURL(/\/en\/signin(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.signInTitle,
  );
});

test("admin categories list — customer redirected to /signin?denied=admin", async ({
  page,
}) => {
  await signIn(page, "en", CUSTOMER_EMAIL);
  await page.goto(`/en/admin/categories`);
  await page.waitForURL(/\/en\/signin\?denied=admin/, { timeout: 15_000 });
});

test("admin categories list — tenant isolation: another tenant's categories don't surface", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { canary } = await seedIsolatedTenantCategory();
  const s = scopedSlugs("isolation");
  await seedCategoryInDevTenant({
    slug: s.slug("anchor"),
    name: { en: `IsolProbe-${Date.now()}`, ar: `اختبار-${Date.now()}` },
  });

  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/categories`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.listTitle,
  );
  // Canary from the isolated tenant must NEVER appear here.
  await expect(page.getByText(canary)).toHaveCount(0);
});
