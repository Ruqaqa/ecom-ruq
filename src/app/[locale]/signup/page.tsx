import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { SignupForm } from "./signup-form";

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">{t("signUpTitle")}</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{t("signUpHint")}</p>
        <div className="mt-6">
          <SignupForm locale={locale as Locale} />
        </div>
        <p className="mt-6 text-center text-sm">
          <Link href="/signin" className="underline">
            {t("haveAccount")}
          </Link>
        </p>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
