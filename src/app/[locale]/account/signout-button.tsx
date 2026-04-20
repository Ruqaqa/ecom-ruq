"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

export function SignoutButton() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  async function onClick() {
    setSubmitting(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      window.location.assign(`/${locale}/signin`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!hydrated || submitting}
      className="flex h-11 w-full items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
    >
      {t("signOut")}
    </button>
  );
}
