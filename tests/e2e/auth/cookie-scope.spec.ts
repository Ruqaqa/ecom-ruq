import { test, expect, type Page } from "@playwright/test";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

/**
 * Cookie-scope guard (R2 from the chunk 5 plan).
 *
 * BA session cookies MUST be host-only — no `Domain` attribute — because
 * tenants live on distinct eTLDs. A Domain cookie on one tenant's
 * domain would either not apply on the other tenant's domain (best
 * case) or leak across them (worst case, if sloppy config shared a
 * parent). This test inspects the cookie BA actually sets and asserts
 * `domain` matches the host exactly, with no leading dot.
 */

const emailLabel = { en: "Email", ar: "البريد الإلكتروني" } as const;
const passwordLabel = { en: "Password", ar: "كلمة المرور" } as const;
const signUpButton = { en: "Create account", ar: "إنشاء الحساب" } as const;

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

for (const locale of ["en", "ar"] as const) {
  test(`BA session cookie is host-only (no Domain attribute) — ${locale}`, async ({ page, context }) => {
    const email = `pw-cookie-${locale}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "CorrectHorseBatteryStaple-9183";

    await page.goto(`/${locale}/signup`);
    // Wait for hydration before filling — otherwise iPhone WebKit can race
    // and POST an empty body, which fails Zod validation.
    await expect(page.getByRole("button", { name: signUpButton[locale] })).toBeEnabled({ timeout: 30_000 });
    await page.getByLabel(emailLabel[locale], { exact: true }).fill(email);
    await page.getByLabel(passwordLabel[locale], { exact: true }).fill(password);
    await clickHydratedButton(page, signUpButton[locale]);
    await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000 });

    const msg = await waitForEmailTo(email, {
      subjectIncludes: locale === "ar" ? "تأكيد" : "Verify",
    });
    const rawLink = extractFirstLink(msg.HTML, (href) => href.includes("/api/auth/verify-email"));
    await page.goto(rawLink.replace(/&amp;/g, "&"));
    await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.endsWith("session_token"));
    expect(session, "session cookie must be set after verification").toBeDefined();
    if (!session) return;
    // Playwright reports the cookie domain. For a host-only cookie the
    // domain equals the exact host ("localhost" here) — no leading dot.
    expect(session.domain.startsWith(".")).toBe(false);
    expect(session.domain).toBe("localhost");
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toMatch(/^Lax$/i);
    expect(session.path).toBe("/");
  });
}
