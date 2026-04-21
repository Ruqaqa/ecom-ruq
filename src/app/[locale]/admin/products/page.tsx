import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.products.list" });
  return { title: t("title") };
}

export default async function AdminProductsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ createdId?: string | string[] }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("admin.products.list");

  const rawCreated = sp.createdId;
  const createdId = Array.isArray(rawCreated) ? rawCreated[0] : rawCreated;

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        {createdId ? (
          <p
            role="status"
            data-testid="created-product-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("createdMessage", { id: createdId })}
          </p>
        ) : null}
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
