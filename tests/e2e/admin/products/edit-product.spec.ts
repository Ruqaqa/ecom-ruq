/**
 * Chunk 1a.2 — End-to-end: admin edits a product.
 *
 * Covers (per consolidated brief §D):
 *   - owner edit happy path × en + ar (mobile project matrix runs each
 *     spec on iPhone 14 + Pixel 7)
 *   - staff edit form: cost-price field NOT in DOM (Tier-B render gate)
 *   - cancel without dirty: navigate; cancel with dirty: confirm modal
 *   - slug-collision inline error
 *   - stale-write banner on OCC race
 *   - no-change save is short-circuited (submit disabled when not dirty)
 *   - anonymous → /signin; customer → /signin?denied=admin
 *   - tap targets ≥44px
 *   - axe a11y on the form
 *   - validation slug canary not in audit (HTTP path coverage)
 *   - ?updatedId banner on the list page after save
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { expectAxeClean } from "../../helpers/axe";
import {
  OWNER_EMAIL,
  STAFF_EMAIL,
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
    listTitle: "Products",
    editTitle: "Edit product",
    submit: "Save changes",
    cancel: "Cancel",
    discardConfirm: "Discard changes",
    keepEditing: "Keep editing",
    emailLabel: "Email",
    passwordLabel: "Password",
    nameEnLabel: "Name (English)",
    statusLabel: "Status",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInSubmit: "تسجيل الدخول",
    listTitle: "المنتجات",
    editTitle: "تعديل المنتج",
    submit: "حفظ التغييرات",
    cancel: "إلغاء",
    discardConfirm: "تجاهل التغييرات",
    keepEditing: "متابعة التعديل",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    nameEnLabel: "الاسم (الإنجليزية)",
    statusLabel: "الحالة",
  },
} as const;

async function signIn(page: Page, locale: "en" | "ar", email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

async function seedProduct(opts?: {
  costPriceMinor?: number | null;
  nameEn?: string;
  nameAr?: string;
}): Promise<{ id: string; slug: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = `e2e-edit-${randomUUID().slice(0, 8)}`;
    const name = {
      en: opts?.nameEn ?? `EditEN-${randomUUID().slice(0, 6)}`,
      ar: opts?.nameAr ?? `EditAR-${randomUUID().slice(0, 6)}`,
    };
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status, cost_price_minor)
      VALUES (
        (SELECT id FROM tenants WHERE primary_domain = 'localhost:5001'),
        ${slug},
        ${sql.json(name)},
        'draft',
        ${opts?.costPriceMinor ?? null}
      )
      RETURNING id::text AS id
    `;
    return { id: rows[0]!.id, slug };
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

async function readProductRow(productId: string): Promise<{ status: string; cost_price_minor: number | null; name: { en: string; ar: string } } | undefined> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ status: string; cost_price_minor: number | null; name: { en: string; ar: string } }>>`
      SELECT status, cost_price_minor, name FROM products WHERE id = ${productId}
    `;
    return rows[0];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`owner edits a product happy path — ${locale}`, async ({ page }) => {
    test.setTimeout(60_000);
    // Seed in halalas (12345 = 123.45 SAR). The form displays riyals;
    // payload converts back to halalas before reaching the service.
    const seeded = await seedProduct({ costPriceMinor: 12345 });
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/products/${seeded.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      expected[locale].editTitle,
    );

    // Form is pre-filled — cost-price field is rendered for owner.
    await expect(page.getByTestId("cost-price-field")).toBeVisible();
    await expect(page.locator("#product-cost-price")).toHaveValue("123.45");

    // Submit button starts disabled (no edits yet).
    const submit = page.getByTestId("edit-product-submit");
    await expect(submit).toBeDisabled();

    // Edit name + status + cost price.
    const newNameEn = `Edited-${Date.now()}`;
    await page.locator("#product-name-en").fill(newNameEn);
    await page
      .locator("#product-status")
      .selectOption({ value: "active" });
    // Type 250.50 SAR; the form converts to 25050 halalas on submit.
    await page.locator("#product-cost-price").fill("250.50");

    await expect(submit).toBeEnabled();
    await expectAxeClean(page);

    await Promise.all([
      page.waitForURL(
        new RegExp(`/${locale}/admin/products\\?updatedId=`),
        { timeout: 15_000 },
      ),
      submit.click(),
    ]);
    await expect(page.getByTestId("updated-product-message")).toBeVisible();

    const row = await readProductRow(seeded.id);
    expect(row?.status).toBe("active");
    expect(row?.cost_price_minor).toBe(25050);
    expect(row?.name.en).toBe(newNameEn);
  });
}

test("staff opens the edit form: cost-price field NOT rendered (Tier-B by-construction)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct({ costPriceMinor: 999 });
  await signIn(page, "en", STAFF_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.editTitle,
  );
  await expect(page.locator("#product-cost-price")).toHaveCount(0);
  await expect(page.getByTestId("cost-price-field")).toHaveCount(0);
});

test("owner cancel with no edits navigates back to list", async ({ page }) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  await page.getByTestId("edit-product-cancel").click();
  await page.waitForURL(/\/en\/admin\/products(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.listTitle,
  );
});

test("owner cancel after editing surfaces discard-confirm dialog; discard navigates back", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  await page.locator("#product-name-en").fill(`Dirty-${Date.now()}`);
  await page.getByTestId("edit-product-cancel").click();
  await expect(page.getByTestId("edit-product-discard-confirm")).toBeVisible();
  await page.getByTestId("edit-product-discard-confirm-yes").click();
  await page.waitForURL(/\/en\/admin\/products(\?|$)/, { timeout: 15_000 });

  const row = await readProductRow(seeded.id);
  // Status didn't change because the user discarded.
  expect(row?.status).toBe("draft");
});

test("owner submitting a slug that's already taken surfaces an inline slug error", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const a = await seedProduct();
  const b = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${b.id}`);
  await page.locator("#product-slug").fill(a.slug);
  await page.getByTestId("edit-product-submit").click();
  // Inline slug error appears, page stays on edit URL.
  await expect(page.locator("#product-slug-error")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/);
});

test("owner submits with stale OCC token: stale-write banner shown; row not destructively overwritten", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct({ nameEn: "Pristine" });
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);

  // Out-of-band: bump updated_at so the form's expectedUpdatedAt is stale.
  await bumpUpdatedAt(seeded.id);

  await page.locator("#product-name-en").fill("ShouldNotApply");
  await page.getByTestId("edit-product-submit").click();
  await expect(page.getByTestId("edit-product-stale-write")).toBeVisible();

  const row = await readProductRow(seeded.id);
  expect(row?.name.en).toBe("Pristine");
});

test("anonymous → /admin/products/[id] redirects to /signin", async ({ page }) => {
  const seeded = await seedProduct();
  await page.goto(`/en/admin/products/${seeded.id}`);
  await page.waitForURL(/\/en\/signin(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    expected.en.signInTitle,
  );
});

test("customer → /admin/products/[id] redirects to /signin?denied=admin", async ({ page }) => {
  const seeded = await seedProduct();
  await signIn(page, "en", CUSTOMER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  await page.waitForURL(/\/en\/signin\?denied=admin/, { timeout: 15_000 });
});

test("owner: tap targets on Save and Cancel are ≥44×44px", async ({ page }) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  const cancel = page.getByTestId("edit-product-cancel");
  const submit = page.getByTestId("edit-product-submit");
  const cancelBox = await cancel.boundingBox();
  const submitBox = await submit.boundingBox();
  expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("owner submits 121-char slug: validation_failed audit row with field-paths only; canary NEVER in audit", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  const sentinel = "secret-slug-do-not-leak-edit-canary";
  const canarySlug = sentinel + "-" + "a".repeat(121 - sentinel.length - 1);
  expect(canarySlug.length).toBe(121);
  await signIn(page, "en", OWNER_EMAIL);

  // Snapshot audit tail.
  const sql = postgres(DATABASE_URL, { max: 1 });
  let tailBefore = "epoch";
  try {
    const rows = await sql<Array<{ ts: string }>>`
      SELECT COALESCE(MAX(al.created_at), 'epoch'::timestamptz)::text AS ts
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = 'localhost:5001'
    `;
    tailBefore = rows[0]?.ts ?? "epoch";
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.goto(`/en/admin/products/${seeded.id}`);
  // Bypass the input's maxLength=120 by setting the value via DOM —
  // we want the SERVER's Zod max(120) to fire so the failure audit
  // row asserts field-paths-only behaviour on the real HTTP path.
  // Then dispatch input event so the React state catches up.
  await page.locator("#product-slug").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, canarySlug);
  await page.getByTestId("edit-product-submit").click();
  // Stays on edit page — Zod rejects.
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/);

  await page.waitForTimeout(200);

  const sql2 = postgres(DATABASE_URL, { max: 1 });
  try {
    const log = await sql2<Array<{ operation: string; outcome: string; error: string | null; correlation_id: string }>>`
      SELECT al.operation, al.outcome, al.error, al.correlation_id::text AS correlation_id
      FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = 'localhost:5001'
        AND al.created_at > ${tailBefore}::timestamptz
    `;
    const validationRow = log.find(
      (r) =>
        r.operation === "products.update" &&
        r.outcome === "failure" &&
        r.error === JSON.stringify({ code: "validation_failed" }),
    );
    expect(validationRow, "validation_failed audit row for products.update must exist").toBeTruthy();
    const payloads = await sql2<Array<{ payload: unknown }>>`
      SELECT ap.payload
      FROM audit_payloads ap JOIN tenants t ON t.id = ap.tenant_id
      WHERE t.primary_domain = 'localhost:5001'
        AND ap.correlation_id = ${validationRow!.correlation_id}::uuid
    `;
    const dump = JSON.stringify(payloads);
    expect(dump).not.toContain("secret-slug-do-not-leak-edit-canary");
  } finally {
    await sql2.end({ timeout: 5 });
  }
});

test("axe a11y on the edit form (en owner)", async ({ page }) => {
  test.setTimeout(60_000);
  const seeded = await seedProduct();
  await signIn(page, "en", OWNER_EMAIL);
  await page.goto(`/en/admin/products/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.en.editTitle);
  await expectAxeClean(page);
});
