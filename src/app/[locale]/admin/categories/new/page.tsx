/**
 * Admin: new category page (chunk 1a.4.2 Block 2).
 *
 * RSC loads the live category tree once, flattens to `CategoryOption[]`
 * with full-path strings, and passes to the client form. The picker on
 * the form reuses the same options.
 *
 * Tree depth is bounded at 3 — total category count stays small enough
 * that no pagination is needed for the picker.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb, withTenant } from "@/server/db";
import {
  buildAuthedTenantContext,
  isWriteRole,
} from "@/server/tenant/context";
import { listCategories } from "@/server/services/categories/list-categories";
import {
  buildCategoryOptions,
  type CategoryOption,
} from "@/lib/categories/build-category-options";
import { CreateCategoryForm } from "./create-category-form";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "admin.categories.create",
  });
  return { title: t("title") };
}

export default async function NewCategoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.categories.create");
  const locale = (rawLocale === "ar" ? "ar" : "en") as Locale;

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

  let categoryOptions: CategoryOption[] = [];
  if (appDb) {
    const authedCtx = buildAuthedTenantContext(
      { id: tenant.id },
      { userId: identity.userId, actorType: "user", tokenId: null, role },
    );
    try {
      const tree = await withTenant(appDb, authedCtx, (tx) =>
        listCategories(
          tx,
          { id: tenant.id, defaultLocale: tenant.defaultLocale },
          role,
          { includeDeleted: false },
        ),
      );
      categoryOptions = buildCategoryOptions(tree.items);
    } catch {
      // Tree-load failure leaves the picker empty; the empty-state
      // affordance still renders. The form itself stays functional.
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-4xl">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <div className="mt-6">
          <CreateCategoryForm locale={locale} categoryOptions={categoryOptions} />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
