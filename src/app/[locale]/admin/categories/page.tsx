/**
 * Admin categories list — chunk 1a.4.2 (Block 1).
 *
 * Mirrors `/admin/products/page.tsx` 1:1 except:
 *   - No Status column (categories are not draft/active).
 *   - Tree indent: each row's anchor carries `data-depth="1|2|3"` and a
 *     logical `ps-` / `ms-` step. Depth comes from the service's
 *     `computed depth` field.
 *   - No pagination — the depth-3 cap means a tenant has a few hundred
 *     categories at most; the whole tree is one response.
 *   - All four flash banners (`createdId`, `updatedId`, `removedId`,
 *     `restoredId`) are wired so 1a.4.3 doesn't have to touch this
 *     file when the soft-delete UX lands.
 *
 * "Show removed" toggle: identical Link-toggle pattern to products.
 *   - data-state="on|off", data-testid="show-removed-toggle".
 *   - Removed rows render with the line-through + grey styling. The
 *     row-level Restore action is 1a.4.3 territory; we render the row
 *     and the badge today, no action affordance.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { routing } from "@/i18n/routing";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb, withTenant } from "@/server/db";
import {
  buildAuthedTenantContext,
  isWriteRole,
} from "@/server/tenant/context";
import {
  listCategories,
  type ListCategoriesOutput,
} from "@/server/services/categories/list-categories";
import { pickLocalizedName } from "@/lib/i18n/pick-localized-name";
import { CategoryReorderButtons } from "./category-reorder-buttons";
import { RestoreCategoryAction } from "./restore-category-action";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "admin.categories.list",
  });
  return { title: t("title") };
}

export default async function AdminCategoriesListPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    createdId?: string | string[];
    updatedId?: string | string[];
    removedId?: string | string[];
    restoredId?: string | string[];
    showRemoved?: string | string[];
  }>;
}) {
  const { locale: rawLocale } = await params;
  const sp = await searchParams;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.categories.list");
  const format = await getFormatter();
  const locale: "en" | "ar" = rawLocale === "ar" ? "ar" : "en";

  const rawCreated = sp.createdId;
  const createdId = Array.isArray(rawCreated) ? rawCreated[0] : rawCreated;
  const rawUpdated = sp.updatedId;
  const updatedId = Array.isArray(rawUpdated) ? rawUpdated[0] : rawUpdated;
  const rawRemoved = sp.removedId;
  const removedId = Array.isArray(rawRemoved) ? rawRemoved[0] : rawRemoved;
  const rawRestored = sp.restoredId;
  const restoredId = Array.isArray(rawRestored) ? rawRestored[0] : rawRestored;
  const rawShowRemoved = sp.showRemoved;
  const showRemovedRaw = Array.isArray(rawShowRemoved)
    ? rawShowRemoved[0]
    : rawShowRemoved;
  const showRemoved = showRemovedRaw === "1";

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

  let page: ListCategoriesOutput = { items: [] };
  let loadError = false;
  if (appDb) {
    const authedCtx = buildAuthedTenantContext(
      { id: tenant.id },
      {
        userId: identity.userId,
        actorType: "user",
        tokenId: null,
        role,
      },
    );
    try {
      page = await withTenant(appDb, authedCtx, (tx) =>
        listCategories(
          tx,
          { id: tenant.id, defaultLocale: tenant.defaultLocale },
          role,
          { includeDeleted: showRemoved },
        ),
      );
    } catch {
      loadError = true;
    }
  }

  const newCategoryHref = `/${rawLocale}/admin/categories/new`;
  const hasItems = page.items.length > 0;
  const dateOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  } as const;

  // For each LIVE row, decide whether the up arrow / down arrow render.
  // Hidden on the first / last live sibling in the same parent group.
  // Soft-deleted rows never get arrows (they sit in the "removed" bucket
  // ahead of the live tree under "Show removed" and are not reorderable).
  // The list is already sorted in sibling order by `listCategories` so a
  // single pass over `page.items` is sufficient.
  const reorderFlags = new Map<string, { showUp: boolean; showDown: boolean }>();
  {
    // Group live items by parent_id while preserving render order.
    const groups = new Map<string, string[]>();
    for (const c of page.items) {
      if (c.deletedAt !== null) continue;
      const key = c.parentId ?? "__root__";
      const arr = groups.get(key);
      if (arr) arr.push(c.id);
      else groups.set(key, [c.id]);
    }
    for (const ids of groups.values()) {
      ids.forEach((id, idx) => {
        reorderFlags.set(id, {
          showUp: idx > 0,
          showDown: idx < ids.length - 1,
        });
      });
    }
  }

  // For each REMOVED row, decide whether its immediate parent is still
  // removed. The Restore button is disabled on a removed row whose
  // parent is also still removed — the operator restores the parent
  // first. Roots (parentId=null) cannot be parent-blocked.
  const itemsById = new Map<string, (typeof page.items)[number]>();
  for (const c of page.items) itemsById.set(c.id, c);
  function parentIsRemoved(parentId: string | null): boolean {
    if (parentId === null) return false;
    const parent = itemsById.get(parentId);
    if (!parent) return false;
    return parent.deletedAt !== null;
  }

  return (
    <main className="min-h-screen p-4 pb-20 sm:p-6 sm:pt-12">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={
                showRemoved
                  ? `/${rawLocale}/admin/categories`
                  : `/${rawLocale}/admin/categories?showRemoved=1`
              }
              data-testid="show-removed-toggle"
              data-state={showRemoved ? "on" : "off"}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            >
              {showRemoved ? t("showingRemoved") : t("showRemoved")}
            </Link>
            <Link
              href={newCategoryHref}
              data-testid="create-category-cta"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
            >
              {t("createCta")}
            </Link>
          </div>
        </header>

        {createdId ? (
          <p
            role="status"
            data-testid="created-category-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("createdMessage", { name: createdId })}
          </p>
        ) : null}

        {updatedId ? (
          <p
            role="status"
            data-testid="updated-category-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("updatedMessage", { name: updatedId })}
          </p>
        ) : null}

        {removedId ? (
          <p
            role="status"
            data-testid="removed-category-message"
            className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {t("removedFlash", { name: removedId })}
          </p>
        ) : null}

        {restoredId ? (
          <p
            role="status"
            data-testid="restored-category-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("restoredFlash", { name: restoredId })}
          </p>
        ) : null}

        {loadError ? (
          <p
            role="alert"
            data-testid="category-list-error"
            className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {t("error")}
          </p>
        ) : !hasItems ? (
          <section
            data-testid="category-list-empty"
            className="mt-10 rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700"
          >
            <h2 className="text-lg font-semibold">{t("empty.heading")}</h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {t("empty.body")}
            </p>
            <Link
              href={newCategoryHref}
              className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
              data-testid="empty-state-cta"
            >
              {t("empty.cta")}
            </Link>
          </section>
        ) : (
          <>
            {/* Mobile cards. */}
            <ul
              data-testid="category-list-cards"
              className="mt-6 space-y-3 md:hidden"
            >
              {page.items.map((c) => {
                const picked = pickLocalizedName(c.name, locale);
                const displayName = picked.text ?? t("noName");
                const isRemoved = c.deletedAt !== null;
                const indent =
                  c.depth === 3 ? "ms-8" : c.depth === 2 ? "ms-4" : "ms-0";
                const flags = reorderFlags.get(c.id) ?? {
                  showUp: false,
                  showDown: false,
                };
                return (
                  <li
                    key={c.id}
                    data-testid="category-row"
                    data-id={c.id}
                    data-depth={c.depth}
                    data-removed={isRemoved ? "true" : "false"}
                    className={
                      isRemoved
                        ? `${indent} rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/40`
                        : `${indent} rounded-lg border border-neutral-200 dark:border-neutral-800`
                    }
                  >
                    <div className="flex flex-col gap-2 p-2">
                      <Link
                        href={`/${rawLocale}/admin/categories/${c.id}`}
                        data-testid="category-row-link"
                        className="flex min-h-[44px] flex-col gap-2 rounded-lg p-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p
                              className={
                                isRemoved
                                  ? "truncate text-base font-medium text-neutral-500 line-through dark:text-neutral-500"
                                  : "truncate text-base font-medium"
                              }
                            >
                              {displayName}
                            </p>
                            <p className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                              {format.dateTime(c.updatedAt, dateOptions)} ·{" "}
                              {c.slug}
                            </p>
                          </div>
                        </div>
                        {picked.isFallback ? (
                          <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                            {t("translationMissing")}
                          </span>
                        ) : null}
                        {isRemoved && c.deletedAt ? (
                          <span
                            data-testid="removed-badge"
                            className="inline-block rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                          >
                            {t("removedBadge", {
                              relative: format.relativeTime(c.deletedAt),
                            })}
                          </span>
                        ) : null}
                      </Link>
                      {!isRemoved ? (
                        <div className="flex justify-end px-2 pb-1">
                          <CategoryReorderButtons
                            categoryId={c.id}
                            displayName={displayName}
                            showUp={flags.showUp}
                            showDown={flags.showDown}
                          />
                        </div>
                      ) : (
                        <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
                          <RestoreCategoryAction
                            locale={locale}
                            categoryId={c.id}
                            displayName={displayName}
                            parentRemoved={parentIsRemoved(c.parentId)}
                          />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Desktop table. */}
            <div className="mt-6 hidden overflow-hidden rounded-lg border border-neutral-200 md:block dark:border-neutral-800">
              <table
                data-testid="category-list-table"
                className="w-full table-fixed text-start text-sm"
              >
                <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-start">
                      {t("columns.name")}
                    </th>
                    <th scope="col" className="px-6 py-3 text-start">
                      {t("columns.slug")}
                    </th>
                    <th scope="col" className="px-6 py-3 text-start">
                      {t("columns.updated")}
                    </th>
                    <th scope="col" className="px-6 py-3 text-start">
                      {t("columns.order")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {page.items.map((c) => {
                    const picked = pickLocalizedName(c.name, locale);
                    const displayName = picked.text ?? t("noName");
                    const isRemoved = c.deletedAt !== null;
                    const indent =
                      c.depth === 3
                        ? "ps-[4.5rem]"
                        : c.depth === 2
                          ? "ps-12"
                          : "";
                    const flags = reorderFlags.get(c.id) ?? {
                      showUp: false,
                      showDown: false,
                    };
                    return (
                      <tr
                        key={c.id}
                        data-testid="category-row"
                        data-id={c.id}
                        data-depth={c.depth}
                        data-removed={isRemoved ? "true" : "false"}
                        className={
                          isRemoved ? "bg-neutral-50 dark:bg-neutral-900/40" : ""
                        }
                      >
                        <td className={`px-6 py-3 ${indent}`}>
                          <Link
                            href={`/${rawLocale}/admin/categories/${c.id}`}
                            data-testid="category-row-link"
                            className={
                              isRemoved
                                ? "block truncate text-neutral-500 line-through underline-offset-2 hover:underline dark:text-neutral-500"
                                : "block truncate underline-offset-2 hover:underline"
                            }
                          >
                            {displayName}
                          </Link>
                          {picked.isFallback ? (
                            <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                              {t("translationMissing")}
                            </span>
                          ) : null}
                          {isRemoved && c.deletedAt ? (
                            <span
                              data-testid="removed-badge"
                              className="ms-2 inline-block rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                            >
                              {t("removedBadge", {
                                relative: format.relativeTime(c.deletedAt),
                              })}
                            </span>
                          ) : null}
                          {isRemoved ? (
                            <div className="mt-2">
                              <RestoreCategoryAction
                                locale={locale}
                                categoryId={c.id}
                                displayName={displayName}
                                parentRemoved={parentIsRemoved(c.parentId)}
                              />
                            </div>
                          ) : null}
                        </td>
                        <td className="px-6 py-3 font-mono text-xs text-neutral-600 dark:text-neutral-400">
                          <span className="block truncate">{c.slug}</span>
                        </td>
                        <td className="px-6 py-3 text-neutral-600 dark:text-neutral-400">
                          {format.dateTime(c.updatedAt, dateOptions)}
                        </td>
                        <td className="px-6 py-3">
                          {!isRemoved ? (
                            <CategoryReorderButtons
                              categoryId={c.id}
                              displayName={displayName}
                              showUp={flags.showUp}
                              showDown={flags.showDown}
                            />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
