/**
 * Admin: edit-category page (chunk 1a.4.2 Block 3).
 *
 * RSC loads the live tree once, finds the row by id, builds:
 *   - `categoryOptions` for the picker
 *   - `excludeIds = [self.id, ...descendantIds]` so the picker disables
 *     self + every node in the moving subtree (cycle prevention at the
 *     UX layer; the service still validates server-side via the
 *     advisory-locked tree-walk in 1a.4.1).
 *
 * No remove or restore affordances — soft-delete UX lands in 1a.4.3.
 */
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
import {
  buildAuthedTenantContext,
  isWriteRole,
} from "@/server/tenant/context";
import { listCategories } from "@/server/services/categories/list-categories";
import {
  buildCategoryOptions,
  collectSelfAndDescendantIds,
  type CategoryOption,
} from "@/lib/categories/build-category-options";
import { EditCategoryForm } from "./edit-category-form";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "admin.categories.edit",
  });
  return { title: t("title") };
}

export default async function EditCategoryPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: rawLocale, id } = await params;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.categories.edit");
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

  let category: import("@/server/services/categories/create-category").Category | null = null;
  let categoryOptions: CategoryOption[] = [];
  let excludeIds: string[] = [];
  let loadError = false;
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
      excludeIds = collectSelfAndDescendantIds(tree.items, id);
      category = tree.items.find((c) => c.id === id) ?? null;
    } catch {
      loadError = true;
    }
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen items-start justify-center p-6 pt-12">
        <div className="w-full max-w-4xl">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p
            role="alert"
            data-testid="edit-category-load-error"
            className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {t("loadError")}
          </p>
        </div>
      </main>
    );
  }

  if (!category) {
    return (
      <main className="flex min-h-screen items-start justify-center p-6 pt-12">
        <div className="w-full max-w-4xl">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-6 text-sm text-neutral-700 dark:text-neutral-300">
            {t("notFound")}
          </p>
          <Link
            href={`/${rawLocale}/admin/categories`}
            data-testid="edit-category-not-found-cta"
            className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
          >
            {t("notFoundCta")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pb-32 pt-12">
      <div className="w-full max-w-4xl">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <div className="mt-6">
          <EditCategoryForm
            locale={locale}
            initial={{
              id: category.id,
              slug: category.slug,
              nameEn: category.name.en,
              nameAr: category.name.ar,
              descriptionEn: category.description?.en ?? "",
              descriptionAr: category.description?.ar ?? "",
              parentId: category.parentId,
              position: category.position,
              expectedUpdatedAt: category.updatedAt.toISOString(),
            }}
            categoryOptions={categoryOptions}
            excludeIds={excludeIds}
          />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
