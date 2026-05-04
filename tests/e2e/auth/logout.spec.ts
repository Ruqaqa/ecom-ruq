import { test, expect, type Page } from "@playwright/test";
import { waitForEmailTo, extractFirstLink } from "../helpers/mailpit";

/**
 * Logout + cookie-scope smoke (one item in §3 of docs/testing.md).
 *
 * Two assertions on a single signed-up + verified user:
 *   1. The session cookie is host-only — no Domain attribute, lax
 *      same-site, http-only, path "/". Tenants live on distinct hosts;
 *      a Domain cookie would either fail to apply on the other tenant
 *      (best case) or leak across them (worst case, sloppy parent
 *      domain config).
 *   2. Sign-out clears the session and routes back to /signin; hitting
 *      /account afterwards bounces.
 *
 * Previously two specs (`cookie-scope.spec.ts` + `logout.spec.ts`); folded
 * into one because §3 lists "logout + cookie scope smoke" as one item and
 * the setup (signup + verify) is identical.
 *
 * One locale per project; no inner locale loop.
 */

const expected = {
  en: {
    emailLabel: "Email",
    passwordLabel: "Password",
    signUpButton: "Create account",
    accountTitle: "Your account",
    signOutButton: "Sign out",
    signInTitle: "Sign in",
    verifySubject: "Verify",
  },
  ar: {
    emailLabel: "البريد الإلكتروني",
    passwordLabel: "كلمة المرور",
    signUpButton: "إنشاء الحساب",
    accountTitle: "حسابك",
    signOutButton: "تسجيل الخروج",
    signInTitle: "تسجيل الدخول",
    verifySubject: "تأكيد",
  },
} as const;

type Locale = keyof typeof expected;

function projectLocale(testInfo: { project: { metadata?: { locale?: string } } }): Locale {
  const l = testInfo.project.metadata?.locale;
  return l === "ar" ? "ar" : "en";
}

function uniqueEmail(tag: string): string {
  return `pw-logout-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function clickHydratedButton(page: Page, name: string): Promise<void> {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeEnabled({ timeout: 30_000 });
  await btn.click();
}

test("logout clears the session, redirects from /account, session cookie is host-only", async ({
  page,
  context,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const labels = expected[locale];
  const email = uniqueEmail(locale);
  const password = "CorrectHorseBatteryStaple-9183";

  // 1. Sign up + verify.
  await page.goto(`/${locale}/signup`);
  await expect(page.getByRole("button", { name: labels.signUpButton })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel(labels.emailLabel, { exact: true }).fill(email);
  await page.getByLabel(labels.passwordLabel, { exact: true }).fill(password);
  await clickHydratedButton(page, labels.signUpButton);
  await page.waitForURL(new RegExp(`/${locale}/verify-pending(/|$)`), { timeout: 30_000 });

  const msg = await waitForEmailTo(email, { subjectIncludes: labels.verifySubject });
  const rawLink = extractFirstLink(msg.HTML, (href) => href.includes("/api/auth/verify-email"));
  const verifyLink = rawLink.replace(/&amp;/g, "&");
  await page.goto(verifyLink);
  await page.waitForURL(new RegExp(`/${locale}/account(/|\\?|$)`), { timeout: 15_000 });

  // 2. Cookie-scope assertion (R2 from the chunk-5 plan): the session
  // cookie must be host-only — no Domain, lax same-site, http-only,
  // path "/". Playwright reports `domain` as the exact host for a
  // host-only cookie.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name.endsWith("session_token"));
  expect(session, "session cookie must be set after verification").toBeDefined();
  if (session) {
    expect(session.domain.startsWith("."), "session cookie must not be Domain-scoped").toBe(false);
    expect(session.domain).toBe("localhost");
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toMatch(/^Lax$/i);
    expect(session.path).toBe("/");
  }

  // 3. Sign out → bounce to /signin.
  await clickHydratedButton(page, labels.signOutButton);
  await page.waitForURL(new RegExp(`/${locale}/signin(/|$)`), { timeout: 15_000 });

  // 4. Hitting /account while logged out should bounce back to /signin.
  await page.goto(`/${locale}/account`);
  await expect(page).toHaveURL(new RegExp(`/${locale}/signin(/|$)`));
});
