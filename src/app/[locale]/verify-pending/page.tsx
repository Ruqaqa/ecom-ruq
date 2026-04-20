import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export default async function VerifyPendingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("verifyPendingTitle")}</h1>
        <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">{t("verifyPendingBody")}</p>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
