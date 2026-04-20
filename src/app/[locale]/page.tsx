import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getTenant } from "@/server/tenant";
import { routing, type Locale } from "@/i18n/routing";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const tenant = await getTenant();
  const otherLocale: Locale = locale === "ar" ? "en" : "ar";

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{t("tagline")}</p>

        <dl className="mt-8 grid grid-cols-2 gap-3 text-sm">
          <dt className="text-neutral-500 dark:text-neutral-400">{t("tenantLabel")}</dt>
          <dd className="font-mono text-neutral-900 dark:text-neutral-100">{tenant.id}</dd>
          <dt className="text-neutral-500 dark:text-neutral-400">{t("localeLabel")}</dt>
          <dd className="font-mono text-neutral-900 dark:text-neutral-100">{locale}</dd>
        </dl>

        <Link
          href="/"
          locale={otherLocale}
          className="mt-8 inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {t("switchLocale")}
        </Link>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
