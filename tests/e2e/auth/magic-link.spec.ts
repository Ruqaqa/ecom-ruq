import { test, expect, type Page } from "@playwright/test";
import { expectAxeClean } from "../helpers/axe";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

/**
 * Magic-link flow.
 *
 * Full round-trip:
 *   1. Sign up + verify a user via the email/password flow (magic-link only
 *      works for existing, verified users when `disableSignUp: false` is
 *      set but we keep behaviour predictable by pre-verifying).
 *   2. Request a magic link from the sign-in page.
 *   3. Poll Mailpit for the delivered message.
 *   4. Click the link → should land on /{locale}/account signed in.
 *
 * We DO NOT stub sendMagicLink. If the send fails in dev, the test fails —
 * that is the point of CLAUDE.md §1.
 */

const expected = {
  en: {
    signInTitle: "Sign in",
    magicSubmit: "Email me a link",
    magicSent: "Check your email for a sign-in link.",
    accountTitle: "Your account",
    emailLabel: "Email",
    passwordLabel: "Password",
    signUpButton: "Create account",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    magicSubmit: "أرسل رابط الدخول",
    magicSent: "تحقق من بريدك الإلكتروني لرابط تسجيل الدخول.",
    accountTitle: "حسابك",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    signUpButton: "إنشاء الحساب",
  },
} as const;

function uniqueEmail(tag: string): string {
  return `pw-magic-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

async function seedVerifiedUser(page: Page, email: string, locale: "en" | "ar"): Promise<void> {
  const password = "CorrectHorseBatteryStaple-9183";
  await page.goto(`/${locale}/signup`);
  await expect(page.getByRole("button", { name: expected[locale].signUpButton })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(password);
  await clickHydratedButton(page, expected[locale].signUpButton);
  await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000 });

  const verifyMsg = await waitForEmailTo(email, {
    subjectIncludes: locale === "ar" ? "تأكيد" : "Verify",
  });
  const rawLink = extractFirstLink(verifyMsg.HTML, (href) => href.includes("/api/auth/verify-email"));
  const verifyLink = rawLink.replace(/&amp;/g, "&");
  await page.goto(verifyLink);
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });

  // Clear the cookie so the magic-link run is a clean sign-in, not a
  // cookie-reuse.
  await page.context().clearCookies();
}

for (const locale of ["en", "ar"] as const) {
  test(`magic-link happy path — ${locale}`, async ({ page }) => {
    const email = uniqueEmail(`happy-${locale}`);
    await seedVerifiedUser(page, email, locale);

    await page.goto(`/${locale}/signin`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].signInTitle);
    await expectAxeClean(page);

    await expect(page.getByRole("button", { name: expected[locale].magicSubmit })).toBeVisible();
    await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
    await clickHydratedButton(page, expected[locale].magicSubmit);
    await expect(page.getByRole("status")).toContainText(expected[locale].magicSent);

    const magicMsg = await waitForEmailTo(email, {
      subjectIncludes: locale === "ar" ? "رابط الدخول" : "sign-in link",
    });
    expect(magicMsg.HTML).toContain("localhost:5001");
    const rawLink = extractFirstLink(magicMsg.HTML, (href) => href.includes("/api/auth/magic-link/verify"));
    const magicLink = rawLink.replace(/&amp;/g, "&");

    await page.goto(magicLink);
    await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].accountTitle);
  });
}
