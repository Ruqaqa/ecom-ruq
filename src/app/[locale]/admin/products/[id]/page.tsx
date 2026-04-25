import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext, isWriteRole } from "@/server/tenant/context";
import { getProduct } from "@/server/services/products/get-product";
import type { ProductOwner, ProductPublic } from "@/server/services/products/create-product";
import { EditProductForm } from "./edit-product-form";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.products.edit" });
  return { title: t("title") };
}

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.products.edit");
  const locale = (rawLocale === "ar" ? "ar" : "en") as Locale;

  if (!UUID_RE.test(id)) notFound();

  const h = await headers();
  const host = h.get("host");
  const tenant = await resolveTenant(host);
  if (!tenant) redirect(`/${rawLocale}`);
  const identity = await resolveRequestIdentity(h, tenant);
  if (identity.type === "anonymous") redirect(`/${rawLocale}/signin`);
  const membership = await resolveMembership(identity.userId, tenant.id);
  const role = membership?.role;
  if (!role || !isWriteRole(role)) {
    redirect(`/${rawLocale}/signin?denied=admin`);
  }

  let product: ProductOwner | ProductPublic | null = null;
  let loadError = false;
  if (appDb) {
    const authedCtx = buildAuthedTenantContext(
      { id: tenant.id },
      { userId: identity.userId, actorType: "user", tokenId: null, role },
    );
    try {
      product = await withTenant(appDb, authedCtx, (tx) =>
        getProduct(tx, { id: tenant.id }, role, { id }),
      );
    } catch {
      loadError = true;
    }
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen items-start justify-center p-6 pt-12">
        <div className="w-full max-w-4xl">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p
            role="alert"
            data-testid="edit-product-load-error"
            className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {t("loadError")}
          </p>
        </div>
      </main>
    );
  }

  if (!product) {
    return (
      <main className="flex min-h-screen items-start justify-center p-6 pt-12">
        <div className="w-full max-w-4xl">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-6 text-sm text-neutral-700 dark:text-neutral-300">
            {t("notFound")}
          </p>
          <Link
            href={`/${rawLocale}/admin/products`}
            data-testid="edit-product-not-found-cta"
            className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
          >
            {t("notFoundCta")}
          </Link>
        </div>
      </main>
    );
  }

  // Tier-B prop only present when the role-gated DTO exposes it. The
  // form renders the cost-price field iff this prop has a value, so the
  // staff "no Tier-B field rendered" invariant is by-construction (not
  // CSS-hide).
  const initialCostPriceMinor =
    "costPriceMinor" in product
      ? (product as ProductOwner).costPriceMinor
      : undefined;

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pb-32 pt-12">
      <div className="w-full max-w-4xl">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <div className="mt-6">
          <EditProductForm
            locale={locale}
            initial={{
              id: product.id,
              slug: product.slug,
              nameEn: product.name.en,
              nameAr: product.name.ar,
              descriptionEn: product.description?.en ?? "",
              descriptionAr: product.description?.ar ?? "",
              status: product.status,
              expectedUpdatedAt: product.updatedAt.toISOString(),
              ...(initialCostPriceMinor !== undefined
                ? { costPriceMinor: initialCostPriceMinor }
                : {}),
            }}
          />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
