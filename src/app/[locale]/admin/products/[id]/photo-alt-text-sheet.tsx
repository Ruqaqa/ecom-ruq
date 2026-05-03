/**
 * `<PhotoAltTextSheet>` — bilingual `{ en, ar }` alt-text editor for a
 * single product image. Wraps the shared `<BottomSheet>` primitive.
 *
 * The English input is forced LTR; the Arabic input is forced RTL.
 * Both are plain `<input type="text">` — no rich-text affordances, no
 * `dangerouslySetInnerHTML`. React's default JSX escaping is the only
 * sanitisation needed for a plain-text field, and adding DOMPurify
 * here would falsely imply HTML safety on a string we always render
 * through `<p>{value}</p>` / `<input value={value}>`.
 *
 * Save commits both sides at once. Empty strings are valid (the user
 * may want to clear an alt-text). Trimming is the caller's
 * responsibility — we pass through verbatim so trailing spaces in
 * Arabic text are not silently mangled.
 */
"use client";

import { useEffect, useState, type JSX } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet } from "@/components/admin/bottom-sheet";

interface Props {
  open: boolean;
  initialEn: string;
  initialAr: string;
  /** True while the underlying mutation is pending; disables Save. */
  saving: boolean;
  onSave: (next: { en: string; ar: string }) => void;
  onCancel: () => void;
}

export function PhotoAltTextSheet({
  open,
  initialEn,
  initialAr,
  saving,
  onSave,
  onCancel,
}: Props): JSX.Element | null {
  const t = useTranslations("admin.products.edit.images");
  const [en, setEn] = useState(initialEn);
  const [ar, setAr] = useState(initialAr);

  // Reset to the latest persisted values whenever the sheet re-opens
  // for a different tile (or the same tile after a successful save).
  useEffect(() => {
    if (open) {
      setEn(initialEn);
      setAr(initialAr);
    }
  }, [open, initialEn, initialAr]);

  if (!open) return null;

  return (
    <BottomSheet
      open={open}
      heading={t("altSheet.heading")}
      closeLabel={t("altSheet.cancel")}
      backdropDismissLabel={t("altSheet.cancel")}
      testIdPrefix="product-photo-alt"
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            data-testid="product-photo-alt-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("altSheet.cancel")}
          </button>
          <button
            type="button"
            onClick={() => onSave({ en, ar })}
            disabled={saving}
            data-testid="product-photo-alt-save"
            className="flex h-12 flex-1 items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {t("altSheet.save")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t("altSheet.helper")}
        </p>
        <div>
          <label
            htmlFor="product-photo-alt-en-field"
            className="block text-sm font-medium"
          >
            {t("altSheet.englishLabel")}
          </label>
          <input
            id="product-photo-alt-en-field"
            data-testid="product-photo-alt-en"
            type="text"
            dir="ltr"
            value={en}
            onChange={(e) => setEn(e.target.value)}
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
            autoComplete="off"
          />
        </div>
        <div>
          <label
            htmlFor="product-photo-alt-ar-field"
            className="block text-sm font-medium"
          >
            {t("altSheet.arabicLabel")}
          </label>
          <input
            id="product-photo-alt-ar-field"
            data-testid="product-photo-alt-ar"
            type="text"
            dir="rtl"
            value={ar}
            onChange={(e) => setAr(e.target.value)}
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
            autoComplete="off"
          />
        </div>
      </div>
    </BottomSheet>
  );
}
