import { test, expect, type Page } from "@playwright/test";

/**
 * Password-manager compatibility invariant.
 *
 * 1Password, Chrome's built-in manager, Safari Keychain and Firefox's manager
 * all decide whether to offer "save password" by watching the page for:
 *
 *   - a real `<form>` element
 *   - containing `input[autocomplete=email|username]` + a password input with
 *     `autocomplete=new-password` (signup) or `autocomplete=current-password`
 *     (signin), in the SAME form
 *   - submitted via a real `submit` event (not a synthetic click handler that
 *     swallows the submission)
 *
 * If any of those are missing, the manager silently never offers to save —
 * which is exactly what happened when chunk 5 shipped `<div>`-based "forms"
 * to work around a WebKit double-fire. Playwright cannot open 1Password, but
 * it CAN assert the DOM shape and the real `submit` event fires, which is
 * the closest machine-checkable proxy for password-manager eligibility.
 *
 * The form's `onSubmit` handler calls `e.preventDefault()` so the browser
 * does not GET-navigate; we assert `event.defaultPrevented === true` below.
 * Password managers observe the submit BEFORE preventDefault runs, so
 * prevented submits still trigger save prompts.
 */

const signupLabels = {
  en: { email: "Email", password: "Password", submit: "Create account" },
  ar: { email: "البريد الإلكتروني", password: "كلمة المرور", submit: "إنشاء الحساب" },
} as const;

const signinLabels = {
  en: { email: "Email", password: "Password", submit: "Sign in", magic: "Email me a link" },
  ar: { email: "البريد الإلكتروني", password: "كلمة المرور", submit: "تسجيل الدخول", magic: "أرسل رابط الدخول" },
} as const;

async function waitForHydration(page: Page, buttonName: string): Promise<void> {
  await expect(page.getByRole("button", { name: buttonName })).toBeEnabled({ timeout: 30_000 });
}

for (const locale of ["en", "ar"] as const) {
  test(`signup form is a real <form> with password-manager-compatible semantics — ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/signup`);
    await waitForHydration(page, signupLabels[locale].submit);

    // Exactly one <form> on the signup page.
    await expect(page.locator("form")).toHaveCount(1);

    // Email + new-password inputs live inside that form.
    const form = page.locator("form").first();
    await expect(form.locator("input[autocomplete=email]")).toHaveCount(1);
    await expect(form.locator("input[autocomplete=new-password]")).toHaveCount(1);

    // The submit button is a nested button[type=submit] — not a bare button
    // outside the form or a div masquerading as a button.
    await expect(form.locator("button[type=submit]")).toHaveCount(1);

    // Install a submit listener BEFORE submission so we can assert the event
    // really fired and was defaultPrevented (i.e., the handler intercepted
    // it instead of letting the browser GET-navigate).
    await page.evaluate(() => {
      const f = document.querySelector("form");
      if (!f) throw new Error("form not found");
      (window as unknown as { __submitEvents: Array<{ defaultPrevented: boolean }> }).__submitEvents = [];
      f.addEventListener(
        "submit",
        (e) => {
          (window as unknown as { __submitEvents: Array<{ defaultPrevented: boolean }> }).__submitEvents.push({
            defaultPrevented: e.defaultPrevented,
          });
          // Wait a microtask so React's onSubmit runs and calls preventDefault.
          queueMicrotask(() => {
            (window as unknown as { __submitEventsAfter: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter = [
              { defaultPrevented: e.defaultPrevented },
            ];
          });
        },
        { capture: true },
      );
    });

    // Fill required fields so the browser's implicit submit event can fire
    // (HTML5 validation blocks submit if required fields are empty).
    await page.getByLabel(signupLabels[locale].email, { exact: true }).fill("pm-test@example.com");
    await page.getByLabel(signupLabels[locale].password, { exact: true }).fill("CorrectHorseBatteryStaple-9183");

    // Programmatic requestSubmit() fires the real submit event path — the
    // same path Enter-key and button-click take.
    await page.evaluate(() => {
      const f = document.querySelector("form") as HTMLFormElement | null;
      if (!f) throw new Error("form not found");
      // Abort the fetch so we don't actually sign up; we only care about
      // the submit event semantics.
      const origFetch = window.fetch;
      window.fetch = () => {
        window.fetch = origFetch;
        return Promise.reject(new Error("aborted-for-test"));
      };
      f.requestSubmit();
    });

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __submitEventsAfter?: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter
                ?.length ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const prevented = await page.evaluate(
      () =>
        (window as unknown as { __submitEventsAfter?: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter?.[0]
          ?.defaultPrevented ?? false,
    );
    expect(prevented, "onSubmit must call e.preventDefault() to stop GET-navigation").toBe(true);
  });

  test(`signup Enter-key in email input fires the native form submit — ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/signup`);
    await waitForHydration(page, signupLabels[locale].submit);

    await page.evaluate(() => {
      const f = document.querySelector("form");
      if (!f) throw new Error("form not found");
      (window as unknown as { __enterSubmitFired: boolean }).__enterSubmitFired = false;
      f.addEventListener("submit", () => {
        (window as unknown as { __enterSubmitFired: boolean }).__enterSubmitFired = true;
      });
    });

    await page.getByLabel(signupLabels[locale].email, { exact: true }).fill("pm-enter@example.com");
    await page.getByLabel(signupLabels[locale].password, { exact: true }).fill("CorrectHorseBatteryStaple-9183");
    // Block the fetch so the handler doesn't actually submit upstream.
    await page.evaluate(() => {
      window.fetch = () => Promise.reject(new Error("aborted-for-test"));
    });
    await page.getByLabel(signupLabels[locale].email, { exact: true }).press("Enter");

    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __enterSubmitFired: boolean }).__enterSubmitFired),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  test(`signin password form is a real <form> with current-password + magic-link button OUTSIDE it — ${locale}`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/signin`);
    await waitForHydration(page, signinLabels[locale].submit);

    // Exactly one <form> — the password form. The magic-link button must
    // not be inside it (different endpoint, different action).
    await expect(page.locator("form")).toHaveCount(1);
    const form = page.locator("form").first();
    await expect(form.locator("input[autocomplete=email]")).toHaveCount(1);
    await expect(form.locator("input[autocomplete=current-password]")).toHaveCount(1);
    await expect(form.locator("button[type=submit]")).toHaveCount(1);

    const magicButton = page.getByRole("button", { name: signinLabels[locale].magic });
    await expect(magicButton).toBeVisible();
    // The magic-link button is NOT a descendant of the password form.
    const magicInsideForm = await form.locator(`button:has-text("${signinLabels[locale].magic}")`).count();
    expect(magicInsideForm).toBe(0);

    // Install a submit listener and prove the signin form fires a
    // defaultPrevented submit event.
    await page.evaluate(() => {
      const f = document.querySelector("form");
      if (!f) throw new Error("form not found");
      (window as unknown as { __submitEventsAfter: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter = [];
      f.addEventListener(
        "submit",
        (e) => {
          queueMicrotask(() => {
            (window as unknown as { __submitEventsAfter: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter.push(
              { defaultPrevented: e.defaultPrevented },
            );
          });
        },
        { capture: true },
      );
    });

    await page.getByLabel(signinLabels[locale].email, { exact: true }).fill("pm-signin@example.com");
    await page.getByLabel(signinLabels[locale].password, { exact: true }).fill("anything-10-chars");

    await page.evaluate(() => {
      const f = document.querySelector("form") as HTMLFormElement | null;
      if (!f) throw new Error("form not found");
      window.fetch = () => Promise.reject(new Error("aborted-for-test"));
      f.requestSubmit();
    });

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __submitEventsAfter?: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter
                ?.length ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const prevented = await page.evaluate(
      () =>
        (window as unknown as { __submitEventsAfter?: Array<{ defaultPrevented: boolean }> }).__submitEventsAfter?.[0]
          ?.defaultPrevented ?? false,
    );
    expect(prevented).toBe(true);
  });

  test(`interactive buttons show pointer cursor — ${locale}`, async ({ page }) => {
    // Native <button> defaults to the arrow cursor; we override globally in
    // globals.css. This guard prevents a silent regression where a future
    // CSS change strips the override and buttons start feeling dead on hover.
    // Disabled buttons intentionally keep the default cursor — that's why we
    // fill the email first (the magic-link button disables itself when empty).
    await page.goto(`/${locale}/signin`);
    await waitForHydration(page, signinLabels[locale].submit);
    await page.getByLabel(signinLabels[locale].email, { exact: true }).fill("cursor@example.com");

    const submit = page.getByRole("button", { name: signinLabels[locale].submit });
    const magic = page.getByRole("button", { name: signinLabels[locale].magic });
    await expect(magic).toBeEnabled();

    const submitCursor = await submit.evaluate((el) => getComputedStyle(el).cursor);
    const magicCursor = await magic.evaluate((el) => getComputedStyle(el).cursor);

    expect(submitCursor).toBe("pointer");
    expect(magicCursor).toBe("pointer");
  });
}
