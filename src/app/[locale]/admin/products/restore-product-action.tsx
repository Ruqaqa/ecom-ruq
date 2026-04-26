/**
 * Client island for the per-row Restore action on the admin products
 * list. Lives next to the RSC page to keep the JS bundle minimal — the
 * server renders the full list; this component only mounts on rows
 * with `deletedAt !== null`.
 */
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { trpc } from "@/lib/trpc/client";

interface Props {
  locale: Locale;
  productId: string;
  displayName: string;
}

export function RestoreProductAction({ locale, productId, displayName }: Props) {
  const t = useTranslations("admin.products.list");
  const [showConfirm, setShowConfirm] = useState(false);
  const [windowExpired, setWindowExpired] = useState(false);

  const mutation = trpc.products.restore.useMutation({
    onSuccess: () => {
      setShowConfirm(false);
      setWindowExpired(false);
      // Hard navigate so RSC fetches fresh data + the URL change is
      // unambiguous. `router.push` + `router.refresh` raced under
      // parallel test load.
      window.location.assign(
        `/${locale}/admin/products?restoredId=${encodeURIComponent(displayName)}&showRemoved=1`,
      );
    },
    onError: (err) => {
      setShowConfirm(false);
      if (err.data?.code === "BAD_REQUEST" && err.message === "restore_expired") {
        setWindowExpired(true);
      }
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setWindowExpired(false);
          setShowConfirm(true);
        }}
        data-testid="restore-product-cta"
        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        {t("restoreCta")}
      </button>
      {windowExpired ? (
        <p
          role="alert"
          data-testid="restore-error-window-expired"
          className="mt-2 text-sm text-red-700 dark:text-red-400"
        >
          {t("restoreError.windowExpired")}
        </p>
      ) : null}
      {showConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`restore-confirm-title-${productId}`}
          aria-describedby={`restore-confirm-body-${productId}`}
          data-testid="restore-product-dialog"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
            <h2
              id={`restore-confirm-title-${productId}`}
              className="text-base font-semibold"
            >
              {t("restoreDialog.heading", { name: displayName })}
            </h2>
            <p
              id={`restore-confirm-body-${productId}`}
              className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t("restoreDialog.body")}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ id: productId, confirm: true })
                }
                data-testid="restore-product-confirm"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
              >
                {t("restoreDialog.confirm")}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                data-testid="restore-product-cancel"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {t("restoreDialog.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
