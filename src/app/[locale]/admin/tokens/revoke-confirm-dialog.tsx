/**
 * RevokeConfirmDialog — destructive-op confirmation modal.
 *
 * Uses a native <dialog> + `showModal()` for focus trap, ESC-to-close,
 * and OS-level modality. Backdrop click does NOT dismiss — per
 * CLAUDE.md §6 destructive-op discipline, confirming revocation should
 * require deliberate intent.
 *
 * Cancel focused on open; Confirm is secondary visual prominence but
 * not primary focus (mis-click prevention).
 */
"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

interface Props {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RevokeConfirmDialog({ name, onConfirm, onCancel }: Props) {
  const t = useTranslations("admin.tokens.revoke");
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
    cancelBtnRef.current?.focus();

    // ESC fires a `cancel` event on <dialog>. Default closes the dialog
    // (fine). We then translate into the React `onCancel` callback so
    // the parent clears its revokeTarget state.
    const onDialogCancel = (e: Event): void => {
      // Do NOT preventDefault — ESC should close. We DO block the
      // backdrop-click path separately via a click-listener below.
      e.stopPropagation();
      onCancel();
    };
    d.addEventListener("cancel", onDialogCancel);

    // Intercept backdrop clicks — <dialog> surfaces them as click events
    // whose target IS the dialog element (not a child). Do NOT close on
    // that path (destructive-op discipline).
    const onDialogClick = (e: MouseEvent): void => {
      if (e.target === d) {
        // Refuse the backdrop click: no close, no onCancel.
        e.preventDefault();
      }
    };
    d.addEventListener("click", onDialogClick);

    return () => {
      d.removeEventListener("cancel", onDialogCancel);
      d.removeEventListener("click", onDialogClick);
      if (d.open) d.close();
    };
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="revoke-dialog-title"
      className="rounded-md p-0 backdrop:bg-black/40"
    >
      <div className="w-[min(90vw,28rem)] bg-white p-5 dark:bg-neutral-900">
        <h2 id="revoke-dialog-title" className="text-lg font-semibold">
          {t("dialogTitle")}
        </h2>
        <p className="mt-2 text-sm">{t("dialogBody", { name })}</p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onConfirm}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md bg-red-700 px-4 text-base font-medium text-white"
          >
            {t("confirmButton")}
          </button>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("cancelButton")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
