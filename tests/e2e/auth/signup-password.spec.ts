import { test, expect, type Page } from "@playwright/test";
import { expectAxeClean } from "../helpers/axe";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

/**
 * Sign-up (email/password) — happy path + breached-password reject.
 *
 * One of the small list of journeys §3 of docs/testing.md keeps at Tier 4:
 * a real human types into a real form, the verify-email round-trip
 * crosses the network, and the post-verify session lands the user on
 * /account. Tier 2 cannot meaningfully cover the full chain (form
 * hydration → POST → email send → verify GET → session cookie → page
 * render).
 *
 * The Playwright config pins one locale per project (iPhone 14 / EN,
 * Pixel 7 / AR + the desktop project). That gives us the diagonal
 * matrix described in §4 — no inner `for (locale of ...)` loop here.
 *
 * Per-locale UI strings come from the `locale` test-info; we read it
 * once at the top of each test rather than enumerating both languages.
 */

const expected = {
  en: {
    signupTitle: "Create your account",
    verifyPendingTitle: "Check your email",
    accountTitle: "Your account",
    emailLabel: "Email",
    passwordLabel: "Password",
    submitButton: "Create account",
    verifySubject: "Verify",
  },
  ar: {
    signupTitle: "إنشاء حساب",
    verifyPendingTitle: "راجع بريدك الإلكتروني",
    accountTitle: "حسابك",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    submitButton: "إنشاء الحساب",
    verifySubject: "تأكيد",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  const l = testInfo.project.metadata?.locale;
  return l === "ar" ? "ar" : "en";
}

function uniqueEmail(tag: string): string {
  return `pw-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  // Button starts disabled until the Client Component hydrates. Waiting
  // for enabled state confirms React has taken over event handling;
  // without this, mobile WebKit can race the native form submit.
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

async function waitForHydration(page: Page, buttonName: string): Promise<void> {
  await expect(page.getByRole("button", { name: buttonName })).toBeEnabled({ timeout: 30_000 });
}

test("signup (password) happy path", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const labels = expected[locale];
  const email = uniqueEmail(`happy-${locale}`);
  const password = "CorrectHorseBatteryStaple-9183";

  await page.goto(`/${locale}/signup`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(labels.signupTitle);
  // §4.2: one axe scan per distinct visual page across the suite.
  // The signup page's accessibility budget is exercised here once
  // (per project — i.e. once per locale).
  await expectAxeClean(page);

  await waitForHydration(page, labels.submitButton);
  await page.getByLabel(labels.emailLabel, { exact: true }).fill(email);
  await page.getByLabel(labels.passwordLabel, { exact: true }).fill(password);
  await clickHydratedButton(page, labels.submitButton);

  await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle");
  await expect(page.url()).toContain("/verify-pending");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(labels.verifyPendingTitle);

  const message = await waitForEmailTo(email, { subjectIncludes: labels.verifySubject });
  expect(message.HTML).toContain("localhost:5001");
  const rawLink = extractFirstLink(message.HTML, (href) => href.includes("/api/auth/verify-email"));
  const link = rawLink.replace(/&amp;/g, "&");

  await page.goto(link);
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(labels.accountTitle);
});

test("signup (password) rejects a breached password", async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const labels = expected[locale];
  const email = uniqueEmail(`breach-${locale}`);

  await page.goto(`/${locale}/signup`);
  await waitForHydration(page, labels.submitButton);
  await page.getByLabel(labels.emailLabel, { exact: true }).fill(email);
  await page.getByLabel(labels.passwordLabel, { exact: true }).fill("password123");
  await clickHydratedButton(page, labels.submitButton);

  // Narrow the match to our <p role="alert"> — getByRole('alert')
  // resolves both that element and Next.js's route announcer div.
  await expect(page.locator("p[role=alert]")).toBeVisible();
  // Still on the signup page; no redirect on failure.
  await expect(page).toHaveURL(new RegExp(`/${locale}/signup(/|$)`));
});
