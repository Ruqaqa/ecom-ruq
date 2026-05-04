// Pagination is cursor-based and forward-only. The URL carries
// `?cursor=<opaque>`; the browser back button returns to the previous
// cursor URL, so there is no dedicated "Previous" control. Garbage
// cursors silently fall back to the first page (handled in the service).

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
  listProducts,
  type ListProductsOutput,
} from "@/server/services/products/list-products";
import { pickLocalizedName } from "@/lib/i18n/pick-localized-name";
import { RestoreProductAction } from "./restore-product-action";

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
  searchParams: Promise<{
    updatedId?: string | string[];
    removedId?: string | string[];
    restoredId?: string | string[];
    cursor?: string | string[];
    showRemoved?: string | string[];
  }>;
}) {
  const { locale: rawLocale } = await params;
  const sp = await searchParams;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.products.list");
  const format = await getFormatter();
  const locale: "en" | "ar" = rawLocale === "ar" ? "ar" : "en";

  const rawUpdated = sp.updatedId;
  const updatedId = Array.isArray(rawUpdated) ? rawUpdated[0] : rawUpdated;
  const rawRemoved = sp.removedId;
  const removedId = Array.isArray(rawRemoved) ? rawRemoved[0] : rawRemoved;
  const rawRestored = sp.restoredId;
  const restoredId = Array.isArray(rawRestored) ? rawRestored[0] : rawRestored;
  const rawCursor = sp.cursor;
  const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  const rawShowRemoved = sp.showRemoved;
  const showRemovedRaw = Array.isArray(rawShowRemoved)
    ? rawShowRemoved[0]
    : rawShowRemoved;
  const showRemoved = showRemovedRaw === "1";

  // Parent layout already gated anonymous/customer. Re-resolve here only
  // to obtain ctx for the DB query.
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

  let page: ListProductsOutput = {
    items: [],
    nextCursor: null,
    hasMore: false,
  };
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
      // Owner sees the owner-shape envelope (cost_price_minor included);
      // staff sees the public-shape envelope (column stripped per
      // chunk-1a.2 alignment with prd §6.5). The list UI doesn't render
      // cost-price either way, so the type union is the only thing that
      // changes.
      page = await withTenant(appDb, authedCtx, (tx) =>
        listProducts(tx, { id: tenant.id }, role, {
          cursor,
          includeDeleted: showRemoved,
        }),
      );
    } catch {
      loadError = true;
    }
  }

  const newProductHref = `/${rawLocale}/admin/products/new`;
  function buildListHref(opts: { cursor?: string } = {}): string {
    const qs = new URLSearchParams();
    if (showRemoved) qs.set("showRemoved", "1");
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const s = qs.toString();
    return `/${rawLocale}/admin/products${s ? `?${s}` : ""}`;
  }
  const hasItems = page.items.length > 0;
  const dateOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  } as const;

  return (
    <main className="min-h-screen p-4 pb-20 sm:p-6 sm:pt-12">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <div className="flex flex-wrap items-center gap-3">
            {/* Show-removed toggle is a Link (not a JS toggle) so it
                survives no-JS / RSC contract. Click flips the URL. */}
            <Link
              href={
                showRemoved
                  ? `/${rawLocale}/admin/products`
                  : `/${rawLocale}/admin/products?showRemoved=1`
              }
              data-testid="show-removed-toggle"
              data-state={showRemoved ? "on" : "off"}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            >
              {showRemoved ? t("showingRemoved") : t("showRemoved")}
            </Link>
            <Link
              href={newProductHref}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
              data-testid="create-product-cta"
            >
              {t("createCta")}
            </Link>
          </div>
        </header>

        {updatedId ? (
          <p
            role="status"
            data-testid="updated-product-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("updatedMessage", { name: updatedId })}
          </p>
        ) : null}

        {removedId ? (
          <p
            role="status"
            data-testid="removed-product-message"
            className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {t("removedFlash", { name: removedId })}
          </p>
        ) : null}

        {restoredId ? (
          <p
            role="status"
            data-testid="restored-product-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("restoredFlash", { name: restoredId })}
          </p>
        ) : null}

        {loadError ? (
          <p
            role="alert"
            data-testid="product-list-error"
            className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {t("error")}
          </p>
        ) : !hasItems ? (
          <section
            data-testid="product-list-empty"
            className="mt-10 rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700"
          >
            <h2 className="text-lg font-semibold">{t("empty.heading")}</h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {t("empty.body")}
            </p>
            <Link
              href={newProductHref}
              className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
              data-testid="empty-state-cta"
            >
              {t("empty.cta")}
            </Link>
          </section>
        ) : (
          <>
            <ul
              data-testid="product-list-cards"
              className="mt-6 space-y-3 md:hidden"
            >
              {page.items.map((p) => {
                const picked = pickLocalizedName(p.name, locale);
                const displayName = picked.text ?? t("noName");
                const isRemoved = p.deletedAt !== null;
                return (
                  <li
                    key={p.id}
                    data-testid="product-row"
                    data-removed={isRemoved ? "true" : "false"}
                    className={
                      isRemoved
                        ? "rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/40"
                        : "rounded-lg border border-neutral-200 dark:border-neutral-800"
                    }
                  >
                    <Link
                      href={`/${rawLocale}/admin/products/${p.id}`}
                      data-testid="product-row-link"
                      className="flex min-h-[44px] flex-col gap-2 rounded-lg p-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
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
                            {format.dateTime(p.updatedAt, dateOptions)} · {p.slug}
                          </p>
                        </div>
                        <StatusPill
                          status={p.status}
                          isRemoved={isRemoved}
                          labels={{
                            draft: t("status.draft"),
                            active: t("status.active"),
                            removed: t("status.removed"),
                          }}
                        />
                      </div>
                      {picked.isFallback ? (
                        <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                          {t("translationMissing")}
                        </span>
                      ) : null}
                      {isRemoved && p.deletedAt ? (
                        <span
                          data-testid="removed-badge"
                          className="inline-block rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                        >
                          {t("removedBadge", {
                            relative: format.relativeTime(p.deletedAt),
                          })}
                        </span>
                      ) : null}
                    </Link>
                    {isRemoved ? (
                      <div className="border-t border-neutral-200 p-4 dark:border-neutral-800">
                        <RestoreProductAction
                          locale={locale}
                          productId={p.id}
                          displayName={displayName}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="mt-6 hidden overflow-hidden rounded-lg border border-neutral-200 md:block dark:border-neutral-800">
              <table
                data-testid="product-list-table"
                className="w-full table-fixed text-start text-sm"
              >
                <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-start">{t("columns.name")}</th>
                    <th scope="col" className="px-6 py-3 text-start">{t("columns.status")}</th>
                    <th scope="col" className="px-6 py-3 text-start">{t("columns.slug")}</th>
                    <th scope="col" className="px-6 py-3 text-start">{t("columns.updated")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {page.items.map((p) => {
                    const picked = pickLocalizedName(p.name, locale);
                    const displayName = picked.text ?? t("noName");
                    const isRemoved = p.deletedAt !== null;
                    return (
                      <tr
                        key={p.id}
                        data-testid="product-row"
                        data-removed={isRemoved ? "true" : "false"}
                        className={
                          isRemoved ? "bg-neutral-50 dark:bg-neutral-900/40" : ""
                        }
                      >
                        <td className="px-6 py-3">
                          <Link
                            href={`/${rawLocale}/admin/products/${p.id}`}
                            data-testid="product-row-link"
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
                          {isRemoved && p.deletedAt ? (
                            <span
                              data-testid="removed-badge"
                              className="ms-2 inline-block rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                            >
                              {t("removedBadge", {
                                relative: format.relativeTime(p.deletedAt),
                              })}
                            </span>
                          ) : null}
                          {isRemoved ? (
                            <div className="mt-2">
                              <RestoreProductAction
                                locale={locale}
                                productId={p.id}
                                displayName={displayName}
                              />
                            </div>
                          ) : null}
                        </td>
                        <td className="px-6 py-3">
                          <StatusPill
                            status={p.status}
                            isRemoved={isRemoved}
                            labels={{
                              draft: t("status.draft"),
                              active: t("status.active"),
                              removed: t("status.removed"),
                            }}
                          />
                        </td>
                        <td className="px-6 py-3 font-mono text-xs text-neutral-600 dark:text-neutral-400">
                          <span className="block truncate">{p.slug}</span>
                        </td>
                        <td className="px-6 py-3 text-neutral-600 dark:text-neutral-400">
                          {format.dateTime(p.updatedAt, dateOptions)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <nav
              aria-label="Pagination"
              className="mt-6 flex items-center justify-between gap-3 text-sm"
            >
              {cursor ? (
                <Link
                  href={buildListHref()}
                  className="inline-flex min-h-[44px] items-center rounded-md px-3 text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                  data-testid="pagination-back-to-first"
                >
                  {t("pagination.backToFirst")}
                </Link>
              ) : (
                <span />
              )}
              {page.hasMore && page.nextCursor ? (
                <Link
                  href={buildListHref({ cursor: page.nextCursor })}
                  className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center rounded-md border border-neutral-300 px-4 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  data-testid="pagination-next"
                >
                  {t("pagination.next")}
                </Link>
              ) : null}
            </nav>
          </>
        )}
      </div>
    </main>
  );
}

function StatusPill({
  status,
  isRemoved,
  labels,
}: {
  status: "draft" | "active";
  isRemoved?: boolean;
  labels: { draft: string; active: string; removed: string };
}) {
  const label = isRemoved
    ? labels.removed
    : status === "active"
      ? labels.active
      : labels.draft;
  const dot = isRemoved
    ? "bg-neutral-400 dark:bg-neutral-500"
    : status === "active"
      ? "bg-green-500"
      : "bg-neutral-400 dark:bg-neutral-500";
  const ring = isRemoved
    ? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
    : status === "active"
      ? "bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-300"
      : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      data-testid="status-pill"
      data-status={isRemoved ? "removed" : status}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${ring}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
