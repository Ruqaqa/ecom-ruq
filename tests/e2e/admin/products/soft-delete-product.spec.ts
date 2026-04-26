/**
 * Chunk 1a.3 — End-to-end: admin removes + restores a product.
 *
 * Covers (per architect brief Block 11 cases 1–4):
 *   1. Owner removes a product from the edit page → row disappears
 *      from the default list, removed-flash visible.
 *   2. Show-removed toggle reveals removed rows + restore round-trip.
 *   3. Default list excludes removed products.
 *   4. Stale-write on delete: edit-form's expectedUpdatedAt is stale →
 *      stale-write banner; row stays visible on list refresh.
 *
 * All cases run on the mobile + locale project matrix (mobile is
 * default; en + ar). axe a11y assertions on the touched pages.
 *
 * References the new tRPC mutations `products.delete` and
 * `products.restore` so check:e2e-coverage finds them.
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
    listTitle: "Products",
    editTitle: "Edit product",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    listTitle: "المنتجات",
    editTitle: "تعديل المنتج",
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
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page
    .getByLabel(expected[locale].passwordLabel, { exact: true })
    .fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), {
    timeout: 30_000,
  });
}

async function seedProduct(
  opts: {
    nameEn?: string;
    nameAr?: string;
    slug?: string;
  } = {},
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
  // Direct SQL bypasses the service so we can construct the
  // deleted-row scenario without driving the UI.
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

async function bumpUpdatedAt(productId: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`UPDATE products SET updated_at = now() + interval '1 second' WHERE id = ${productId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`case 1: owner removes a product from the edit page; row disappears from default list — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const seeded = await seedProduct();
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/products/${seeded.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].editTitle,
    );

    // Click the destructive Remove CTA → confirm dialog → confirm.
    const removeCta = page.getByTestId("remove-product-cta");
    await expect(removeCta).toBeVisible();
    // ≥ 44×44 mobile-first guard.
    const ctaBox = await removeCta.boundingBox();
    expect(ctaBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectAxeClean(page);
    await removeCta.click();

    const dialog = page.getByTestId("remove-product-dialog");
    await expect(dialog).toBeVisible();
    // Heading must substitute the product name into the placeholder —
    // ICU MessageFormat treats single-quoted text as literal, so a
    // catalog like "Remove '{name}'?" silently fails substitution.
    const seededName = locale === "ar" ? seeded.nameAr : seeded.nameEn;
    await expect(dialog).toContainText(seededName);
    await expect(dialog).not.toContainText("{name}");
    const confirmBtn = page.getByTestId("remove-product-confirm");
    const confirmBox = await confirmBtn.boundingBox();
    expect(confirmBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?removedId=`),
        { timeout: 15_000 },
      ),
      confirmBtn.click(),
    ]);

    // Removed flash appears.
    await expect(page.getByTestId("removed-product-message")).toBeVisible();
    // The deleted row is NOT visible on the default list.
    const productLinks = page.getByTestId("product-row-link");
    const allHrefs = await productLinks.evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    expect(allHrefs.every((h) => !h.endsWith(`/admin/products/${seeded.id}`))).toBe(
      true,
    );

    // DB confirms soft-delete: deleted_at set.
    expect(await readProductDeletedAt(seeded.id)).toBeInstanceOf(Date);
  });
}

for (const locale of ["en", "ar"] as const) {
  test(`case 2: show-removed toggle reveals removed rows + restore round-trip — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Per-test slug prefix scopes every page assertion to THIS test's
    // seeded rows, regardless of how many parallel-test rows the
    // shared dev tenant carries (see scoped-row-locator.ts).
    const prefix = scopedSlugPrefix(`case-2-${locale}`);
    const seeded = await seedProduct({ slug: scopedSlug(prefix) });
    // Construct the deleted state directly so this test doesn't depend
    // on case 1 ordering.
    await softDeleteProductDirect(seeded.id);
    await signIn(page, locale, OWNER_EMAIL);

    // Default list does NOT include the deleted row — assertion is
    // scoped to my prefix so other workers' live rows don't matter.
    await page.goto(`/${locale}/admin/products`);
    await expect(scopedProductRows(page, prefix)).toHaveCount(0);

    // Click the Show-removed toggle (it's a Link).
    const toggle = page.getByTestId("show-removed-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await page.waitForURL(/\?showRemoved=1/, { timeout: 15_000 });

    // The seeded row appears in the prefix-scoped set. Page-walk
    // through the bucket until the row lands — the shared dev tenant
    // can push my row off page 1 under heavy parallel-test load. The
    // enclosing [data-testid="product-row"] gives us a row-scoped
    // Locator for the dialog buttons that follow.
    const seededRowLink = await pageUntilPrefixHasCount(page, prefix, 1);
    await expect(seededRowLink).toHaveCount(1);
    const seededRow = seededRowLink.locator(
      'xpath=ancestor::*[@data-testid="product-row"][1]',
    );

    await expect(seededRow.getByTestId("removed-badge")).not.toHaveCount(0);
    await expectAxeClean(page);

    // Restore round-trip. The dialog testids are scoped to the row
    // (the action component renders ITS OWN dialog inside the row's
    // DOM subtree).
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

    // After restore the flash appears. The URL also flips to carry
    // `restoredId=` but the flash is the user-visible signal.
    await expect(page.getByTestId("restored-product-message")).toBeVisible({
      timeout: 15_000,
    });
    // The row returns to Draft styling on the page (status pill flips
    // from "Removed" back to "Draft"). The MCP integration test in
    // tests/e2e/mcp/delete-product.spec.ts asserts the DB-side state
    // independently — duplicating it here would race the parallel
    // test pool.
  });
}

test("case 3: default list excludes removed products — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — DB-constructed scenario is locale-independent",
  );
  test.setTimeout(60_000);
  const live = await seedProduct({ nameEn: "LiveOnly" });
  const removed = await seedProduct({ nameEn: "RemovedOne" });
  await softDeleteProductDirect(removed.id);
  await signIn(page, "en", OWNER_EMAIL);

  await page.goto(`/en/admin/products`);
  const links = await page
    .getByTestId("product-row-link")
    .evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
  expect(links.some((h) => h.endsWith(`/admin/products/${live.id}`))).toBe(true);
  expect(links.some((h) => h.endsWith(`/admin/products/${removed.id}`))).toBe(
    false,
  );
});

test("case 4: stale-write on delete shows stale-write banner; row not deleted — single project", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-14-en",
    "single-project — stale-write race is wire-shape coverage, locale-independent",
  );
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);

  // Out-of-band: bump updated_at so the form's expectedUpdatedAt is stale.
  await bumpUpdatedAt(seeded.id);

  await page.getByTestId("remove-product-cta").click();
  await page.getByTestId("remove-product-confirm").click();

  // Stale-write banner from the existing edit-form pattern.
  await expect(page.getByTestId("edit-product-stale-write")).toBeVisible();
  // Row is NOT deleted in DB.
  expect(await readProductDeletedAt(seeded.id)).toBeNull();
});

// chunk 1a.3 follow-up — case 8: removed-on-top sort under ?showRemoved=1.
// Runs the full default mobile matrix × en + ar. The slug prefix
// scopes every assertion to THIS test's two seeded rows, so the shared
// dev tenant's other parallel-test rows don't matter (whether they
// monopolize page 1 or sit between mine in the DOM).
for (const locale of ["en", "ar"] as const) {
  test(`case 8: show-removed lists most-recently-removed product first — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const prefix = scopedSlugPrefix(`case-8-${locale}`);
    const olderRemoved = await seedProduct({
      slug: scopedSlug(prefix),
      nameEn: "OlderRemoved",
    });
    // Soft-delete olderRemoved first; pause briefly so the second
    // seed's deletedAt is unambiguously later (the bucket sort is
    // deletedAt DESC).
    await softDeleteProductDirect(olderRemoved.id);
    await new Promise((r) => setTimeout(r, 50));
    const recentlyRemoved = await seedProduct({
      slug: scopedSlug(prefix),
      nameEn: "RecentlyRemoved",
    });
    await softDeleteProductDirect(recentlyRemoved.id);
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/products?showRemoved=1`);

    // Page-walk until BOTH seeded rows are in the prefix-scoped set;
    // the shared dev tenant's bucket can push them off page 1.
    const rows = await pageUntilPrefixHasCount(page, prefix, 2);
    const orderedSeededIds = await rows.evaluateAll((els) =>
      els
        .map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
        .map((href) => href.split("/").pop() ?? ""),
    );
    expect(orderedSeededIds).toEqual([recentlyRemoved.id, olderRemoved.id]);

    await expectAxeClean(page);
  });
}
