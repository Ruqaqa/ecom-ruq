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
  type ListProductsOutputOwner,
} from "@/server/services/products/list-products";
import { pickLocalizedName } from "@/lib/i18n/pick-localized-name";

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
    createdId?: string | string[];
    cursor?: string | string[];
  }>;
}) {
  const { locale: rawLocale } = await params;
  const sp = await searchParams;
  setRequestLocale(rawLocale);
  const t = await getTranslations("admin.products.list");
  const format = await getFormatter();
  const locale: "en" | "ar" = rawLocale === "ar" ? "ar" : "en";

  const rawCreated = sp.createdId;
  const createdId = Array.isArray(rawCreated) ? rawCreated[0] : rawCreated;
  const rawCursor = sp.cursor;
  const cursor = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;

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

  let page: ListProductsOutputOwner = {
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
      // Role gated to owner/staff above, so the service returns the owner
      // shape — safe cast.
      page = (await withTenant(appDb, authedCtx, (tx) =>
        listProducts(tx, { id: tenant.id }, role, { cursor }),
      )) as ListProductsOutputOwner;
    } catch {
      loadError = true;
    }
  }

  const newProductHref = `/${rawLocale}/admin/products/new`;
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
          <Link
            href={newProductHref}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
            data-testid="create-product-cta"
          >
            {t("createCta")}
          </Link>
        </header>

        {createdId ? (
          <p
            role="status"
            data-testid="created-product-message"
            className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
          >
            {t("createdMessage", { id: createdId })}
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
                return (
                  <li
                    key={p.id}
                    data-testid="product-row"
                    className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-medium">
                          {displayName}
                        </p>
                        <p className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {format.dateTime(p.updatedAt, dateOptions)} · {p.slug}
                        </p>
                      </div>
                      <StatusPill
                        status={p.status}
                        labels={{
                          draft: t("status.draft"),
                          active: t("status.active"),
                        }}
                      />
                    </div>
                    {picked.isFallback ? (
                      <p className="mt-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                        {t("translationMissing")}
                      </p>
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
                    <th scope="col" className="px-4 py-3 text-start">{t("columns.name")}</th>
                    <th scope="col" className="px-4 py-3 text-start">{t("columns.status")}</th>
                    <th scope="col" className="px-4 py-3 text-start">{t("columns.slug")}</th>
                    <th scope="col" className="px-4 py-3 text-start">{t("columns.updated")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {page.items.map((p) => {
                    const picked = pickLocalizedName(p.name, locale);
                    const displayName = picked.text ?? t("noName");
                    return (
                      <tr key={p.id} data-testid="product-row">
                        <td className="px-4 py-3">
                          <span className="block truncate">{displayName}</span>
                          {picked.isFallback ? (
                            <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                              {t("translationMissing")}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill
                            status={p.status}
                            labels={{
                              draft: t("status.draft"),
                              active: t("status.active"),
                            }}
                          />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-600 dark:text-neutral-400">
                          <span className="block truncate">{p.slug}</span>
                        </td>
                        <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">
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
                  href={`/${rawLocale}/admin/products`}
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
                  href={`/${rawLocale}/admin/products?cursor=${encodeURIComponent(page.nextCursor)}`}
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
  labels,
}: {
  status: "draft" | "active";
  labels: { draft: string; active: string };
}) {
  const label = status === "active" ? labels.active : labels.draft;
  const dot =
    status === "active"
      ? "bg-green-500"
      : "bg-neutral-400 dark:bg-neutral-500";
  const ring =
    status === "active"
      ? "bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-300"
      : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      data-testid="status-pill"
      data-status={status}
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
