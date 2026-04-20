"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";

interface Props {
  locale: Locale;
  defaultEmail?: string;
}

/**
 * Password form is a real <form> (see signup-form.tsx for the rationale).
 *
 * The magic-link button is deliberately OUTSIDE the <form>: it hits a
 * different endpoint and must never submit the password form. Placing it
 * inside would also confuse password managers — they'd see two competing
 * submit-like controls and suppress the save prompt.
 */
export function SigninForm({ locale, defaultEmail }: Props) {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const [email, setEmail] = useState(defaultEmail ?? "");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [magicSending, setMagicSending] = useState(false);
  const [magicError, setMagicError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "accept-language": locale },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.assign(`/${locale}/account`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (data.code === "EMAIL_NOT_VERIFIED") setError(t("errorUnverified"));
      else if (res.status === 429) setError(t("errorRateLimited"));
      else setError(data.message ?? t("errorInvalid"));
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  async function requestMagicLink() {
    setMagicError(null);
    setMagicSending(true);
    try {
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "accept-language": locale },
        body: JSON.stringify({ email, callbackURL: `/${locale}/account` }),
      });
      if (res.ok) {
        setMagicSent(true);
        return;
      }
      setMagicError(t("magicLinkFailed"));
    } catch {
      setMagicError(t("magicLinkFailed"));
    } finally {
      setMagicSending(false);
    }
  }

  return (
    <div>
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div>
          <label htmlFor="signin-email" className="block text-sm font-medium">
            {tc("email")}
          </label>
          <input
            id="signin-email"
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
          <label htmlFor="signin-password" className="block text-sm font-medium">
            {tc("password")}
          </label>
          <input
            id="signin-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
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
          {t("signInSubmit")}
        </button>
      </form>

      <section aria-labelledby="magic-link-heading" className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <h2 id="magic-link-heading" className="text-sm font-medium">
          {t("magicLinkTitle")}
        </h2>
        {magicSent ? (
          <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-400">
            {t("magicLinkSent")}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={requestMagicLink}
              disabled={!hydrated || magicSending || email.length === 0}
              className="mt-3 flex h-11 w-full items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
            >
              {t("magicLinkSubmit")}
            </button>
            {magicError ? (
              <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
                {magicError}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
