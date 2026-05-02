/**
 * `<RemoveOptionDialog>` — confirm dialog for removing an option type
 * with a cascade-warning body that previews the count of variant rows
 * that will be hard-deleted (chunk 1a.5.3).
 *
 * Mirrors the shape of the existing `remove-product-dialog` /
 * `remove-category-dialog`. Modal, role="dialog" aria-modal="true",
 * default focus on Cancel (destructive — the operator must reach for
 * the confirm button), Escape closes via the cancel callback.
 *
 * The cascade count is computed client-side from the operator's current
 * draft of `variantRows` × the option's value-ids about to be removed.
 * The server is the source of truth — see security spec §3.
 */
"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

interface Props {
  open: boolean;
  /** Localized name to display inside the heading (caller picks locale). */
  optionName: string;
  /** Number of variant rows that will be hard-deleted by removing this option. */
  cascadeCount: number;
  /** True when removing this option will collapse the product to flat single-variant mode. */
  isLastOption: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RemoveOptionDialog({
  open,
  optionName,
  cascadeCount,
  isLastOption,
  onConfirm,
  onCancel,
}: Props) {
  const t = useTranslations("admin.products.edit.options.removeOptionDialog");
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => cancelRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-option-dialog-title"
      data-testid="remove-option-dialog"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
        <h2
          id="remove-option-dialog-title"
          className="text-base font-semibold"
        >
          {t("heading", { name: optionName })}
        </h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {t("body")}
        </p>
        <p
          data-testid="remove-option-cascade-warning"
          className="mt-2 text-sm font-medium text-red-700 dark:text-red-400"
        >
          {t("cascadeWarning", { count: cascadeCount })}
        </p>
        {isLastOption ? (
          <p
            data-testid="remove-option-collapse-preview"
            className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
          >
            {t("collapsePreview")}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onConfirm}
            data-testid="remove-option-confirm"
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700"
          >
            {t("confirm")}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid="remove-option-cancel"
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
