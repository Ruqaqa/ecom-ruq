/**
 * Shared Playwright helper for admin-products specs that exercise
 * removed/restored state on the shared dev tenant.
 *
 * Why this exists:
 *   The E2E suite runs in parallel against ONE admin tenant on
 *   localhost:5001. Specs that seed products and then look at the
 *   rendered admin list collide in two ways:
 *     1. xpath-row-scoping: another worker's row sits between MY
 *        seeded rows in the DOM, so a `.first()` selector resolves
 *        to the wrong row.
 *     2. page-1-monopoly: the default list shows 20 rows; if many
 *        workers have just-deleted rows, MY seeded rows can be paged
 *        off entirely.
 *
 *   Both shapes resolve when each test stamps its rows with a unique
 *   slug PREFIX and asserts only on rows whose href contains that
 *   prefix. Other workers' rows fall outside the prefix and are
 *   ignored by the locator — pagination noise stops mattering.
 *
 * Pattern (in a spec):
 *
 *   const prefix = scopedSlugPrefix("case-2");
 *   await seedProduct({ slug: scopedSlug(prefix) });
 *   ...
 *   const rows = scopedProductRows(page, prefix);
 *   await expect(rows).toHaveCount(2);
 *
 *   // Order assertions: read hrefs from the scoped Locator.
 *   const orderedIds = await rows.evaluateAll((els) =>
 *     els
 *       .map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
 *       .map((href) => href.split("/").pop() ?? ""),
 *   );
 *
 * The slug prefix is per-TEST (not per-worker) so two test bodies in
 * the same spec file get different scopes. The token mixes a tag,
 * timestamp, and random suffix — same shape as `testTokenName`.
 */
import type { Locator, Page } from "@playwright/test";

/**
 * Mints a slug prefix unique to a single test run. Pass the tag
 * descriptive of the test (`"case-2"`, `"case-8"`) so the underlying
 * slug is grep-able in DB if a test leaves rows behind.
 */
export function scopedSlugPrefix(tag: string): string {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 1e6);
  // The prefix lands inside `e2e-del-${prefix}-${randomUUID()}` (or
  // similar) when the spec composes it via `scopedSlug`. Lowercase
  // hyphens only — matches the slug regex.
  return `e2e-${tag}-${ts}-${rnd}`;
}

/**
 * Returns a slug that contains `prefix` as a substring. Spec passes
 * the result to its `seedProduct` helper. The trailing `Math.random`
 * segment makes seeded rows unique within one test run.
 */
export function scopedSlug(prefix: string): string {
  return `${prefix}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Returns a Locator narrowed to product-row anchors whose containing
 * row's text contains the slug prefix. Resolves to whichever layout
 * (mobile cards or desktop table) is rendered in the current viewport.
 */
export function scopedProductRows(page: Page, slugPrefix: string): Locator {
  return page
    .getByTestId("product-row")
    .filter({ hasText: slugPrefix })
    .locator('[data-testid="product-row-link"]:visible');
}

/**
 * Walks list pages forward (via the existing pagination-next link)
 * until at least `expectedCount` rows in the prefix-scoped set are
 * present, or the cap is reached. Required because the shared dev
 * tenant's list view is monopolized by parallel-test rows on page 1
 * — without paging, a prefix-scoped query may resolve to 0 even
 * though the rows exist.
 *
 * Returns the prefix-scoped Locator pointed at the page where the
 * rows landed. On cap-reached without finding enough rows, the test
 * assertion that follows (`toHaveCount`) will fail with the actual
 * count, which is the right diagnostic.
 */
export async function pageUntilPrefixHasCount(
  page: Page,
  slugPrefix: string,
  expectedCount: number,
  capPages = 30,
): Promise<Locator> {
  for (let i = 0; i < capPages; i++) {
    const rows = scopedProductRows(page, slugPrefix);
    const count = await rows.count();
    if (count >= expectedCount) return rows;
    // Pagination-next is a Link in the existing list page. If it
    // isn't present we're at the end.
    const next = page.getByTestId("pagination-next");
    if ((await next.count()) === 0) return rows;
    await next.click();
    // Wait for the URL to change (cursor= flips per click).
    await page.waitForURL(/[?&]cursor=/, { timeout: 5_000 });
  }
  return scopedProductRows(page, slugPrefix);
}
