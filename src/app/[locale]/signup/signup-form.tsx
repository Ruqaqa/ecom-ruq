"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";

/**
 * Why a real <form> with onSubmit-only (no button onClick):
 *
 * Password managers (1Password, Chrome, Safari Keychain, Firefox) decide
 * whether to offer "save password" by watching for a real <form> element
 * dispatching a real `submit` event that contains recognisable
 * `autocomplete=email` + `autocomplete=new-password` inputs. A <div>
 * "form" submits via click only and managers silently never offer to
 * save, killing conversion.
 *
 * Why onSubmit-only and no `onClick` on the submit button: a `type=submit`
 * button inside a form fires BOTH the button's `onClick` AND the form's
 * `submit` handler on a single click. On mobile WebKit this manifested as
 * a double-fired request — the previous TDD "fixed" it by downgrading
 * to <div>, which is wrong. The correct fix is exactly one handler:
 * `onSubmit` on the form, no `onClick` on the button.
 */
export function SignupForm({ locale }: { locale: Locale }) {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    // preventDefault BEFORE any await — if a password manager captured the
    // submit it already has what it needs; this only stops the browser's
    // GET-navigation default.
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", "accept-language": locale },
        body: JSON.stringify({ email, password, name: email }),
      });
      if (res.ok) {
        window.location.assign(`/${locale}/verify-pending`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (data.code === "PASSWORD_COMPROMISED") setError(t("errorBreached"));
      else if (res.status === 429) setError(t("errorRateLimited"));
      else if (data.code === "PASSWORD_TOO_SHORT") setError(t("errorTooShort"));
      else setError(data.message ?? t("errorGeneric"));
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
      <div>
        <label htmlFor="signup-email" className="block text-sm font-medium">
          {tc("email")}
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div>
        <label htmlFor="signup-password" className="block text-sm font-medium">
          {tc("password")}
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!hydrated || submitting}
        className="flex h-11 w-full items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        {t("signUpSubmit")}
      </button>
    </form>
  );
}
