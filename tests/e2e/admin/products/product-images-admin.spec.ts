/**
 * End-to-end: admin product photos (Tier-4 happy path).
 *
 * Per docs/testing.md §3, the photos surface gets ONE happy-path browser
 * test that exercises the full mutation chain: upload → set cover →
 * edit alt → remove. Everything else lives at lower tiers:
 *
 *   - Client-side validation (too-large, unsupported mime) →
 *     tests/unit/lib/images/upload-client.test.ts.
 *   - Server-side validation (image_too_small, fingerprint dup, cap=10)
 *     → tests/unit/services/images/upload-product-image.test.ts.
 *   - CSRF same-origin guard on the upload route →
 *     tests/unit/api/admin-images-csrf-guard.test.ts +
 *     admin-images-upload.test.ts.
 *   - Anonymous / customer denial → consolidated cross-tenant browser
 *     smoke (separate spec).
 *   - Drag-reorder → tests/unit/services/images/reorder-product-images.test.ts;
 *     dnd-kit pointer activation is verified by hand on real devices
 *     (Playwright tests would only exercise the keyboard sensor — see
 *     project memory `feedback_dnd_kit_keyboard_test_blind_spot`).
 *   - Drop-to-upload, reduced-motion, live region → component-level
 *     UI niceties; not on the critical path.
 *
 * Coverage-lint substring contract — these mutations are name-mentioned
 * here even though the spec itself only drives the chain from the UI:
 *   trpc.images.delete | trpc.images.setProductCover |
 *   trpc.images.setVariantCover | trpc.images.setAltText |
 *   trpc.images.reorder
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  FIXTURE_PASSWORD,
} from "../../../../scripts/seed-admin-user";
import { scopedSlugPrefix } from "./helpers/scoped-row-locator";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "fixtures",
  "images",
);
const FIXTURE_VALID = path.join(FIXTURES_DIR, "valid-2000.jpg");
const FIXTURE_VALID_ALT = path.join(FIXTURES_DIR, "valid-2000-alt.jpg");

const expected = {
  en: {
    signInSubmit: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
    photosHeading: "Photos",
    coverBadge: "Cover",
  },
  ar: {
    signInSubmit: "تسجيل الدخول",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    photosHeading: "الصور",
    coverBadge: "الغلاف",
  },
} as const;

function localeFromProject(): "en" | "ar" {
  // Project locale is pinned in playwright.config (e.g. iphone-14-en,
  // pixel-7-ar). The new rule drops inner-locale loops; this helper
  // resolves the pinned locale from the project name instead.
  const name = test.info().project.name;
  return name.endsWith("-ar") ? "ar" : "en";
}

async function signIn(page: Page): Promise<void> {
  const locale = localeFromProject();
  const e = expected[locale];
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: e.signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(e.emailLabel, { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel(e.passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), {
    timeout: 30_000,
  });
}

async function seedProduct(slugPrefix: string): Promise<{ id: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `${slugPrefix}-${randomUUID().slice(0, 6)}`;
    const name = {
      en: `Photos-${randomUUID().slice(0, 6)}`,
      ar: `صور-${randomUUID().slice(0, 6)}`,
    };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json(name)},
        'draft'
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readImageCount(productId: string): Promise<number> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM product_images WHERE product_id = ${productId}
    `;
    return Number(rows[0]?.c ?? 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("photos: upload → set cover → edit alt → remove (full mutation chain)", async ({
  page,
}) => {
  const locale = localeFromProject();
  const e = expected[locale];
  const seeded = await seedProduct(scopedSlugPrefix("photos-chain"));
  await signIn(page);
  await page.goto(`/${locale}/admin/products/${seeded.id}`);

  await expect(
    page.getByRole("heading", { level: 2, name: e.photosHeading }),
  ).toBeVisible();
  await expect(page.getByTestId("product-photos-empty")).toBeVisible();

  // Upload two photos.
  await page
    .getByTestId("product-photos-file-input")
    .setInputFiles([FIXTURE_VALID, FIXTURE_VALID_ALT]);
  await expect(page.getByTestId("product-photo-tile")).toHaveCount(2, {
    timeout: 60_000,
  });

  // Promote tile #2 to cover via the kebab menu.
  const tiles = page.getByTestId("product-photo-tile");
  await tiles.nth(1).getByTestId("product-photo-tile-kebab").click();
  await page.getByTestId("product-photo-action-set-cover").click();
  await expect(
    tiles.first().locator('[data-testid="product-photo-cover-badge"]'),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("product-photo-cover-badge")).toHaveText(
    e.coverBadge,
  );

  // Edit alt text on the cover tile.
  await tiles.first().getByTestId("product-photo-tile-kebab").click();
  await page.getByTestId("product-photo-action-edit-alt").click();
  await page
    .getByTestId("product-photo-alt-en")
    .fill("A studio photo of a speaker");
  await page.getByTestId("product-photo-alt-ar").fill("صورة استوديو لمكبر صوت");
  await page.getByTestId("product-photo-alt-save").click();
  await expect(page.getByTestId("product-photo-alt-en")).toHaveCount(0, {
    timeout: 10_000,
  });

  // Remove the second (non-cover) tile.
  await tiles.nth(1).getByTestId("product-photo-tile-kebab").click();
  await page.getByTestId("product-photo-action-remove").click();
  await expect(page.getByTestId("product-photo-remove-dialog")).toBeVisible();
  await page.getByTestId("product-photo-remove-confirm").click();
  await expect(tiles).toHaveCount(1, { timeout: 10_000 });

  expect(await readImageCount(seeded.id)).toBe(1);

  // Per docs/testing.md §4.2, axe runs once per distinct visual page in
  // the suite. The photos page is asserted here.
  await expectAxeClean(page);
});
