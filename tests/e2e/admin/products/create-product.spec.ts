/**
 * Block 8c — End-to-end: admin creates a product.
 *
 * Covers:
 *   - happy path (owner, bilingual × iPhone14/Pixel7 × en/ar)
 *   - unauthenticated → redirect to signin (server-side admin guard)
 *   - customer → redirect to /signin?denied=admin (server-side admin guard)
 *   - Zod validation on the wire (121-char slug) → inline error, no DB row
 *   - adapter body-size cap (>64KB POST → 413, no DB row)
 *
 * Reads `products` table directly for post-mutation assertions.
 * Uses the seeded fixtures from `scripts/seed-admin-user.ts` — the
 * `OWNER_EMAIL` / `CUSTOMER_EMAIL` / `FIXTURE_PASSWORD` constants are
 * imported from there so spec and seeder stay in lockstep.
 */
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
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
    formTitle: "New product",
    submit: "Create product",
    emailLabel: "Email",
    passwordLabel: "Password",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    signInSubmit: "تسجيل الدخول",
    formTitle: "منتج جديد",
    submit: "إنشاء المنتج",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
  },
} as const;

function unique(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function signIn(page: Page, locale: "en" | "ar", email: string): Promise<void> {
  await page.goto(`/${locale}/signin`);
  const submit = page.getByRole("button", { name: expected[locale].signInSubmit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(FIXTURE_PASSWORD);
  await submit.click();
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 30_000 });
}

async function readProductsForTenant(tenantDomain: string, slug: string): Promise<
  Array<{ id: string; tenant_id: string }>
> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await sql<Array<{ id: string; tenant_id: string }>>`
      SELECT p.id, p.tenant_id::text AS tenant_id
      FROM products p
      JOIN tenants t ON t.id = p.tenant_id
      WHERE t.primary_domain = ${tenantDomain}
        AND p.slug = ${slug}
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

for (const locale of ["en", "ar"] as const) {
  test(`admin creates a product — happy path, ${locale}`, async ({ page }) => {
    test.setTimeout(45_000);
    // Latin-only slug, unique-per-run so parallel projects don't
    // collide against the `products_tenant_slug_unique` index.
    const slug = unique(`admin-${locale}`).toLowerCase();
    await signIn(page, locale, OWNER_EMAIL);

    await page.goto(`/${locale}/admin/products/new`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].formTitle);
    const submit = page.getByRole("button", { name: expected[locale].submit });
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await expectAxeClean(page);

    await page.locator("#product-slug").fill(slug);
    await page.locator("#product-name-en").fill("Sony A7 IV");
    await page.locator("#product-name-ar").fill("سوني");
    await submit.click();

    await page.waitForURL(
      new RegExp(`/${locale}/admin/products\\?createdId=[^&]+`),
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("created-product-message")).toBeVisible();

    // Persistence + tenant-id wiring check via raw SQL.
    const rows = await readProductsForTenant("localhost:5001", slug);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).toBeTruthy();

    // Axe on the success page: wait for the client-side navigation's
    // metadata to settle before analyzing (App Router updates <title>
    // after hydration; axe runs against live DOM).
    await expect(page).toHaveTitle(/.+/, { timeout: 5_000 });
    await expectAxeClean(page);
  });
}

test("admin new-product page redirects anonymous to signin", async ({ page }) => {
  await page.goto(`/en/admin/products/new`);
  await page.waitForURL(/\/en\/signin(\?|$)/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected.en.signInTitle);
});

test("customer → admin redirected to signin with denied=admin", async ({ page }) => {
  await signIn(page, "en", CUSTOMER_EMAIL);
  await page.goto(`/en/admin/products/new`);
  await page.waitForURL(/\/en\/signin\?denied=admin/, { timeout: 15_000 });
});

test("owner + invalid slug (121 chars) shows inline error and creates no row", async ({ page }) => {
  test.setTimeout(45_000);
  // Distinctive prefix so a grep over audit rows unambiguously detects
  // leakage of the caller-supplied slug value (CP8 opportunistic catch).
  const canarySlug = "SECRET_SLUG_DO_NOT_LEAK_E2E_" + "x".repeat(93);
  expect(canarySlug.length).toBe(121);
  await signIn(page, "en", OWNER_EMAIL);

  // Snapshot audit tail so we can scope post-submit assertion to THIS
  // test's window.
  const { default: postgres } = await import("postgres");
  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

  async function tail(): Promise<string> {
    const sql = postgres(DATABASE_URL, { max: 1 });
    try {
      const rows = await sql<Array<{ ts: string }>>`
        SELECT COALESCE(MAX(al.created_at), 'epoch'::timestamptz)::text AS ts
        FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
        WHERE t.primary_domain = 'localhost:5001'
      `;
      return rows[0]?.ts ?? "epoch";
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  async function readNew(sinceTs: string): Promise<{ log: Array<{ operation: string; outcome: string; error: string | null }>; payloads: unknown[] }> {
    const sql = postgres(DATABASE_URL, { max: 1 });
    try {
      const log = await sql<Array<{ operation: string; outcome: string; error: string | null }>>`
        SELECT al.operation, al.outcome, al.error
        FROM audit_log al JOIN tenants t ON t.id = al.tenant_id
        WHERE t.primary_domain = 'localhost:5001'
          AND al.created_at > ${sinceTs}::timestamptz
      `;
      const payloads = await sql<Array<{ payload: unknown }>>`
        SELECT ap.payload
        FROM audit_payloads ap JOIN tenants t ON t.id = ap.tenant_id
        WHERE t.primary_domain = 'localhost:5001'
          AND ap.correlation_id IN (
            SELECT al.correlation_id FROM audit_log al JOIN tenants t2 ON t2.id = al.tenant_id
            WHERE t2.primary_domain = 'localhost:5001'
              AND al.created_at > ${sinceTs}::timestamptz
          )
      `;
      return { log: [...log], payloads: payloads.map((p) => p.payload) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const tailBefore = await tail();

  await page.goto(`/en/admin/products/new`);
  const submit = page.getByRole("button", { name: expected.en.submit });
  await expect(submit).toBeEnabled({ timeout: 30_000 });

  await page.locator("#product-slug").fill(canarySlug);
  await page.locator("#product-name-en").fill("n");
  await page.locator("#product-name-ar").fill("ن");
  await submit.click();

  // Stay on the form page; inline error surfaces.
  await expect(page).toHaveURL(/\/admin\/products\/new/);
  await expect(page.locator("#product-slug-error")).toBeVisible();

  // No row in DB.
  const rows = await readProductsForTenant("localhost:5001", canarySlug);
  expect(rows.length).toBe(0);

  // CP8 slug-canary: the validation_failed audit should exist AND
  // neither audit_log nor audit_payloads should contain the canary
  // slug value (block-2 High-01 invariant on the real HTTP path).
  await page.waitForTimeout(200);
  const bundle = await readNew(tailBefore);
  const validationRow = bundle.log.find(
    (r) =>
      r.operation === "products.create" &&
      r.outcome === "failure" &&
      r.error === JSON.stringify({ code: "validation_failed" }),
  );
  expect(validationRow, "validation_failed audit row for products.create must exist").toBeTruthy();
  const dump = JSON.stringify(bundle);
  expect(dump).not.toContain("SECRET_SLUG_DO_NOT_LEAK_E2E");
});

test("tRPC POST body >64KB is rejected with 413 at the adapter", async ({ request }) => {
  const huge = "a".repeat(128 * 1024);
  const res = await request.post("/api/trpc/products.create", {
    headers: { "content-type": "application/json" },
    data: { blob: huge },
  });
  expect(res.status()).toBe(413);
  const body = await res.json().catch(() => ({}));
  expect(JSON.stringify(body)).toMatch(/too large/i);

  const rows = await readProductsForTenant("localhost:5001", "products.create");
  expect(rows.length).toBe(0);
});
