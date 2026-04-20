import { test, expect, type Page } from "@playwright/test";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

const expected = {
  en: {
    emailLabel: "Email",
    passwordLabel: "Password",
    signUpButton: "Create account",
    accountTitle: "Your account",
    signOutButton: "Sign out",
    signInTitle: "Sign in",
  },
  ar: {
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    signUpButton: "إنشاء الحساب",
    accountTitle: "حسابك",
    signOutButton: "تسجيل الخروج",
    signInTitle: "تسجيل الدخول",
  },
} as const;

function uniqueEmail(tag: string): string {
  return `pw-logout-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

for (const locale of ["en", "ar"] as const) {
  test(`logout clears the session and redirects from /account — ${locale}`, async ({ page }) => {
    const email = uniqueEmail(locale);
    const password = "CorrectHorseBatteryStaple-9183";

    await page.goto(`/${locale}/signup`);
    await expect(page.getByRole("button", { name: expected[locale].signUpButton })).toBeEnabled({ timeout: 30_000 });
    await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
    await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(password);
    await clickHydratedButton(page, expected[locale].signUpButton);
    await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000 });

    const msg = await waitForEmailTo(email, {
      subjectIncludes: locale === "ar" ? "تأكيد" : "Verify",
    });
    const rawLink = extractFirstLink(msg.HTML, (href) => href.includes("/api/auth/verify-email"));
    const verifyLink = rawLink.replace(/&amp;/g, "&");
    await page.goto(verifyLink);
    await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });

    await clickHydratedButton(page, expected[locale].signOutButton);
    await page.waitForURL(new RegExp(`/${locale}/signin(/|$)`), { timeout: 15_000 });

    // Hitting /account while logged out should bounce back to /signin.
    await page.goto(`/${locale}/account`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/signin(/|$)`));
  });
}
