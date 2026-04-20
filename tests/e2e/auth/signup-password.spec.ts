import { test, expect, type Page } from "@playwright/test";
import { expectAxeClean } from "../helpers/axe";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

const expected = {
  en: {
    signupTitle: "Create your account",
    verifyPendingTitle: "Check your email",
    accountTitle: "Your account",
    emailLabel: "Email",
    passwordLabel: "Password",
    submitButton: "Create account",
  },
  ar: {
    signupTitle: "إنشاء حساب",
    verifyPendingTitle: "راجع بريدك الإلكتروني",
    accountTitle: "حسابك",
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    submitButton: "إنشاء الحساب",
  },
} as const;

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
  // Confirm the button's disabled-until-hydrated state has flipped. This
  // is what gates field fills too — React's controlled inputs only react
  // after hydration, so a fill before this point can be lost.
  await expect(page.getByRole("button", { name: buttonName })).toBeEnabled({ timeout: 30_000 });
}

for (const locale of ["en", "ar"] as const) {
  test(`signup (password) happy path — ${locale}`, async ({ page }) => {
    const email = uniqueEmail(`happy-${locale}`);
    const password = "CorrectHorseBatteryStaple-9183";

    await page.goto(`/${locale}/signup`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].signupTitle);
    await expectAxeClean(page);

    await waitForHydration(page, expected[locale].submitButton);
    await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
    await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill(password);
    await clickHydratedButton(page, expected[locale].submitButton);

    // Landing: /{locale}/verify-pending
    await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.url()).toContain("/verify-pending");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].verifyPendingTitle);

    const message = await waitForEmailTo(email, {
      subjectIncludes: locale === "ar" ? "تأكيد" : "Verify",
    });
    expect(message.HTML).toContain("localhost:5001");
    const rawLink = extractFirstLink(
      message.HTML,
      (href) => href.includes("/api/auth/verify-email"),
    );
    const link = rawLink.replace(/&amp;/g, "&");

    await page.goto(link);

    // Verify lands us on /{locale}/account with a live session.
    await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected[locale].accountTitle);
    await expectAxeClean(page);
  });

  test(`signup (password) rejects a breached password — ${locale}`, async ({ page }) => {
    const email = uniqueEmail(`breach-${locale}`);
    await page.goto(`/${locale}/signup`);
    await waitForHydration(page, expected[locale].submitButton);
    await page.getByLabel(expected[locale].emailLabel, { exact: true }).fill(email);
    await page.getByLabel(expected[locale].passwordLabel, { exact: true }).fill("password123");
    await clickHydratedButton(page, expected[locale].submitButton);

    // Narrow the match to our <p role="alert"> — getByRole('alert')
    // resolves both that element and Next.js's route announcer div.
    await expect(page.locator("p[role=alert]")).toBeVisible();
    // Still on the signup page; no redirect on failure.
    await expect(page).toHaveURL(new RegExp(`/${locale}/signup(/|$)`));
  });
}
