/**
 * Admin removes + restores a product — Tier-4 keep per docs/testing.md §3.
 *
 * Per chunk-2 audit:
 *   - Inner `for (locale of [...])` loops dropped — Playwright projects
 *     pin one locale per profile.
 *   - Per-feature touch-target asserts removed (§4.2).
 *   - Case 3 (default list excludes removed rows) and case 8 (sort order
 *     under ?showRemoved=1) deleted — fully covered by Tier 2
 *     (tests/unit/services/products/list-products.test.ts: includeDeleted
 *     matrix + bucketed-sort tests).
 *   - Case 4 (stale-write on delete) deleted — the OCC stale-write
 *     pattern is covered once at the form level by edit-product.spec.ts;
 *     §3 explicitly says "stale-write OCC banners on every form — one
 *     test on one form covers the pattern."
 *
 * References the tRPC mutations `products.delete` and `products.restore`
 * so check:e2e-coverage finds them (also covered at Tier 2 in
 * tests/unit/trpc/routers/products-soft-delete.test.ts; the substring
 * lookup is satisfied by either tier per docs/testing.md §7).
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";
import {
  pageUntilPrefixHasCount,
  scopedProductRows,
  scopedSlug,
  scopedSlugPrefix,
} from "./helpers/scoped-row-locator";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const expected = {
  en: {
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
    editTitle: "Edit product",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    editTitle: "تعديل المنتج",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  return testInfo.project.metadata?.locale === "ar" ? "ar" : "en";
}

async function signIn(page: Page, locale: Locale, email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

async function seedProduct(
  opts: { nameEn?: string; nameAr?: string; slug?: string } = {},
): Promise<{ id: string; slug: string; nameEn: string; nameAr: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = opts.slug ?? `e2e-del-${randomUUID().slice(0, 8)}`;
    const en = `${opts.nameEn ?? "Removable"}-${randomUUID().slice(0, 6)}`;
    const ar = `${opts.nameAr ?? "قابل للحذف"}-${randomUUID().slice(0, 6)}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json({ en, ar })},
        'draft'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug, nameEn: en, nameAr: ar };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function softDeleteProductDirect(productId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE products SET deleted_at = now() WHERE id = ${productId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readProductDeletedAt(productId: string): Promise<Date | null> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ deleted_at: Date | null }>>`
      SELECT deleted_at FROM products WHERE id = ${productId}
    `;
    return rows[0]?.deleted_at ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("owner removes a product from the edit page; row disappears from default list", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const seeded = await seedProduct();
  await signIn(page, locale, OWNER_EMAIL);

  await page.goto(`/${locale}/admin/products/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected[locale].editTitle,
  );

  const removeCta = page.getByTestId("remove-product-cta");
  await expect(removeCta).toBeVisible();
  await removeCta.click();

  const dialog = page.getByTestId("remove-product-dialog");
  await expect(dialog).toBeVisible();
  // Heading must substitute the product name into the placeholder —
  // ICU MessageFormat treats single-quoted text as literal, so a catalog
  // like "Remove '{name}'?" silently fails substitution.
  const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
  await expect(dialog).toContainText(seededName);
  await expect(dialog).not.toContainText("{name}");

  await Promise.all([
    page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?removedId=`),
      { timeout: 15_000 },
    ),
    page.getByTestId("remove-product-confirm").click(),
  ]);

  await expect(page.getByTestId("removed-product-message")).toBeVisible();

  // Deleted row is NOT in the default list.
  const productLinks = page.getByTestId("product-row-link");
  const allHrefs = await productLinks.evaluateAll((els) =>
    els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
  );
  expect(allHrefs.every((h) => !h.endsWith(`/admin/products/${seeded.id}`))).toBe(true);

  // DB confirms soft-delete.
  expect(await readProductDeletedAt(seeded.id)).toBeInstanceOf(Date);
});

test("show-removed toggle reveals removed rows and restore round-trips", async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  // Per-test slug prefix scopes every assertion to THIS test's seeded
  // rows, regardless of how many parallel-test rows the shared dev
  // tenant carries.
  const prefix = scopedSlugPrefix(`restore-${locale}`);
  const seeded = await seedProduct({ slug: scopedSlug(prefix) });
  await softDeleteProductDirect(seeded.id);
  await signIn(page, locale, OWNER_EMAIL);

  // Default list does NOT include the deleted row (scoped to my prefix).
  await page.goto(`/${locale}/admin/products`);
  await expect(scopedProductRows(page, prefix)).toHaveCount(0);

  // Toggle show-removed.
  await page.getByTestId("show-removed-toggle").click();
  await page.waitForURL(/\?showRemoved=1/, { timeout: 15_000 });

  // Page-walk through the bucket until the row lands.
  const seededRowLink = await pageUntilPrefixHasCount(page, prefix, 1);
  await expect(seededRowLink).toHaveCount(1);
  const seededRow = seededRowLink.locator(
    'xpath=ancestor::*[@data-testid="product-row"][1]',
  );

  await expect(seededRow.getByTestId("removed-badge")).not.toHaveCount(0);
  // Single axe scan for the /admin/products list page (§4.2 — once per
  // page, once per locale via the project matrix). The default state
  // (no removed rows) renders the same surface; the toggle adds the
  // badge but no new layout.
  await expectAxeClean(page);

  // Restore round-trip. Dialog testids are scoped to the row.
  await seededRow
    .getByTestId("restore-product-cta")
    .locator("visible=true")
    .first()
    .click();
  const restoreDialog = seededRow
    .getByTestId("restore-product-dialog")
    .locator("visible=true")
    .first();
  await expect(restoreDialog).toBeVisible();
  const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
  await expect(restoreDialog).toContainText(seededName);
  await expect(restoreDialog).not.toContainText("{name}");
  await seededRow
    .getByTestId("restore-product-confirm")
    .locator("visible=true")
    .first()
    .click();

  await expect(page.getByTestId("restored-product-message")).toBeVisible({
    timeout: 15_000,
  });
});
