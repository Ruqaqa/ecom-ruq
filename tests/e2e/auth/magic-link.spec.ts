import { test, expect, type Page } from "@playwright/test";
import { expectAxeClean } from "../helpers/axe";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

/**
 * Magic-link round-trip via Mailpit.
 *
 * Full chain:
 *   1. Sign up + verify a user via the email/password flow (magic-link
 *      only works for existing, verified users when `disableSignUp:false`
 *      is set; we keep behaviour predictable by pre-verifying).
 *   2. Request a magic link from the sign-in page.
 *   3. Poll Mailpit for the delivered message.
 *   4. Click the link → land on /{locale}/account signed in.
 *
 * We do NOT stub `sendMagicLink`. If the send fails in dev, the test
 * fails — that is the point of CLAUDE.md §1.
 *
 * §4.2: the sign-in page's axe scan lives here (one per distinct page
 * across the suite). The signup page's axe scan lives in
 * signup-password.spec.ts; the account page's axe scan lives in the
 * signup happy-path landing assertion.
 *
 * One locale per project; no inner locale loop.
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
    verifySubject: "Verify",
    magicSubject: "sign-in link",
  },
  ar: {
    signInTitle: "تسجيل الدخول",
    magicSubmit: "أرسل رابط الدخول",
    magicSent: "تحقق من بريدك الإلكتروني لرابط تسجيل الدخول.",
    accountTitle: "حسابك",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    signUpButton: "إنشاء الحساب",
    verifySubject: "تأكيد",
    magicSubject: "رابط الدخول",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  const l = testInfo.project.metadata?.locale;
  return l === "ar" ? "ar" : "en";
}

function uniqueEmail(tag: string): string {
  return `pw-magic-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

async function seedVerifiedUser(page: Page, email: string, locale: Locale): Promise<void> {
  const password = "CorrectHorseBatteryStaple-9183";
  await page.goto(`/${locale}/signup`);
  await expect(page.getByRole("button", { name: expected[locale].signUpButton })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
  await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(password);
  await clickHydratedButton(page, expected[locale].signUpButton);
  await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000 });

  const verifyMsg = await waitForEmailTo(email, { subjectIncludes: expected[locale].verifySubject });
  const rawLink = extractFirstLink(verifyMsg.HTML, (href) => href.includes("/api/auth/verify-email"));
  const verifyLink = rawLink.replace(/&amp;/g, "&");
  await page.goto(verifyLink);
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });

  // Clear the cookie so the magic-link run is a clean sign-in, not a
  // cookie-reuse.
  await page.context().clearCookies();
}

test("magic-link happy path", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const labels = expected[locale];
  const email = uniqueEmail(`happy-${locale}`);
  await seedVerifiedUser(page, email, locale);

  await page.goto(`/${locale}/signin`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(labels.signInTitle);
  // One axe scan per distinct page (sign-in lives here).
  await expectAxeClean(page);

  await expect(page.getByRole("button", { name: labels.magicSubmit })).toBeVisible();
  await page.getByLabel(labels.emailLabel, { exact: true }).fill(email);
  await clickHydratedButton(page, labels.magicSubmit);
  await expect(page.getByRole("status")).toContainText(labels.magicSent);

  const magicMsg = await waitForEmailTo(email, { subjectIncludes: labels.magicSubject });
  expect(magicMsg.HTML).toContain("localhost:5001");
  const rawLink = extractFirstLink(magicMsg.HTML, (href) => href.includes("/api/auth/magic-link/verify"));
  const magicLink = rawLink.replace(/&amp;/g, "&");

  await page.goto(magicLink);
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(labels.accountTitle);
});
