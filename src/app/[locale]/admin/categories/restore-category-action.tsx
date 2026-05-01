/**
 * Client island for the per-row Restore action on the admin categories
 * list (chunk 1a.4.3). Mirrors `restore-product-action.tsx` plus a
 * category-specific disabled state: when this row's parent is also
 * still removed, the button is disabled with helper text. The server
 * surfaces `parentRemoved` from the in-memory tree it already loaded
 * for the list page — no extra round-trip.
 *
 * Click round-trips for parent-still-removed cases are guarded both
 * here (button disabled, click ignored) and at the service layer (the
 * service refuses with BAD_REQUEST `parent_still_removed`).
 */
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { trpc } from "@/lib/trpc/client";

interface Props {
  locale: Locale;
  categoryId: string;
  displayName: string;
  parentRemoved: boolean;
}

type RestoreErrorKind =
  | null
  | "windowExpired"
  | "parentStillRemoved"
  | "slugTaken"
  | "depthExceeded";

export function RestoreCategoryAction({
  locale,
  categoryId,
  displayName,
  parentRemoved,
}: Props) {
  const t = useTranslations("admin.categories.list");
  const [showConfirm, setShowConfirm] = useState(false);
  const [errorKind, setErrorKind] = useState<RestoreErrorKind>(null);

  const mutation = trpc.categories.restore.useMutation({
    onSuccess: () => {
      setShowConfirm(false);
      setErrorKind(null);
      window.location.assign(
        `/${locale}/admin/categories?restoredId=${encodeURIComponent(displayName)}&showRemoved=1`,
      );
    },
    onError: (err) => {
      setShowConfirm(false);
      const code = err.data?.code;
      const message = err.message;
      if (code === "BAD_REQUEST" && message === "restore_expired") {
        setErrorKind("windowExpired");
        return;
      }
      if (code === "BAD_REQUEST" && message === "parent_still_removed") {
        setErrorKind("parentStillRemoved");
        return;
      }
      if (code === "BAD_REQUEST" && message === "category_depth_exceeded") {
        setErrorKind("depthExceeded");
        return;
      }
      if (code === "CONFLICT" && message === "slug_taken") {
        setErrorKind("slugTaken");
        return;
      }
    },
  });

  const errorMessage =
    errorKind === "windowExpired"
      ? t("restoreError.windowExpired")
      : errorKind === "parentStillRemoved"
        ? t("restoreError.parentStillRemoved")
        : errorKind === "slugTaken"
          ? t("restoreError.slugTaken")
          : errorKind === "depthExceeded"
            ? t("restoreError.depthExceeded")
            : null;

  if (parentRemoved) {
    // Disabled state — the operator must restore the parent first. Click
    // round-trip is short-circuited so we never fire the mutation.
    return (
      <>
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-describedby={`restore-disabled-help-${categoryId}`}
          data-testid="restore-category-cta"
          data-disabled-reason="parent-still-removed"
          className="inline-flex min-h-[44px] cursor-not-allowed items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-medium text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-600"
        >
          {t("restoreCta")}
        </button>
        <p
          id={`restore-disabled-help-${categoryId}`}
          data-testid="restore-disabled-help"
          className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
        >
          {t("restoreDisabledHelp")}
        </p>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErrorKind(null);
          setShowConfirm(true);
        }}
        data-testid="restore-category-cta"
        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        {t("restoreCta")}
      </button>
      {errorMessage ? (
        <p
          role="alert"
          data-testid={`restore-error-${errorKind ?? "unknown"}`}
          className="mt-2 text-sm text-red-700 dark:text-red-400"
        >
          {errorMessage}
        </p>
      ) : null}
      {showConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`restore-confirm-title-${categoryId}`}
          aria-describedby={`restore-confirm-body-${categoryId}`}
          data-testid="restore-category-dialog"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
            <h2
              id={`restore-confirm-title-${categoryId}`}
              className="text-base font-semibold"
            >
              {t("restoreDialog.heading", { name: displayName })}
            </h2>
            <p
              id={`restore-confirm-body-${categoryId}`}
              className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t("restoreDialog.body")}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ id: categoryId, confirm: true })
                }
                data-testid="restore-category-confirm"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
              >
                {t("restoreDialog.confirm")}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                data-testid="restore-category-cancel"
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
