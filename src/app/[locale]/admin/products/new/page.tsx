import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { CreateProductForm } from "./create-product-form";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.products.create" });
  return { title: t("title") };
}

export default async function NewProductPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("admin.products.create");

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <div className="mt-6">
          <CreateProductForm locale={locale as Locale} />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
