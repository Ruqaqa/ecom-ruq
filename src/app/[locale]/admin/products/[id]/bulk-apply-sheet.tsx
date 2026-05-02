/**
 * `<BulkApplySheet>` — bottom-sheet for applying price/stock to a
 * selection of variant rows in one batch (chunk 1a.5.3).
 *
 * Wraps the shared `<BottomSheet>` primitive. Two gated number fields
 * (price, stock); the operator opts each in via a leading checkbox. The
 * apply button stays disabled until at least one field is opted in
 * with a valid value.
 *
 * The sheet is a CLIENT-ONLY operation — it emits a patch to the
 * parent's variant state. The four-leg save chain runs against the
 * post-patch row set when the operator hits Save.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet } from "@/components/admin/bottom-sheet";
import { InlineNumberField } from "@/components/admin/inline-number-field";

export interface BulkApplyPatch {
  /** Minor units (SAR cents). Undefined when the operator did not opt price in. */
  priceMinor?: number;
  /** Whole units. Undefined when the operator did not opt stock in. */
  stock?: number;
}

interface Props {
  open: boolean;
  /** Number of rows the patch will apply to (drives the heading + apply CTA). */
  selectedCount: number;
  onApply: (patch: BulkApplyPatch) => void;
  onCancel: () => void;
}

export function BulkApplySheet({ open, selectedCount, onApply, onCancel }: Props) {
  const t = useTranslations("admin.products.edit.variants.bulkApply");
  const tv = useTranslations("admin.products.edit.variants");
  const [applyPrice, setApplyPrice] = useState(false);
  const [priceText, setPriceText] = useState("");
  const [applyStock, setApplyStock] = useState(false);
  const [stockText, setStockText] = useState("");

  // Reset fields each time the sheet re-opens; the operator should not
  // see leftover values from a previous selection.
  useEffect(() => {
    if (open) {
      setApplyPrice(false);
      setPriceText("");
      setApplyStock(false);
      setStockText("");
    }
  }, [open]);

  const priceMinor = parsePriceMinor(priceText);
  const stock = parseStock(stockText);
  const priceValid = !applyPrice || (priceMinor !== null && priceMinor >= 0);
  const stockValid = !applyStock || (stock !== null && stock >= 0);
  const anySelected = applyPrice || applyStock;
  const canApply = anySelected && priceValid && stockValid;

  function onConfirm(): void {
    if (!canApply) return;
    const patch: BulkApplyPatch = {};
    if (applyPrice && priceMinor !== null) patch.priceMinor = priceMinor;
    if (applyStock && stock !== null) patch.stock = stock;
    onApply(patch);
  }

  return (
    <BottomSheet
      open={open}
      heading={t("heading", { count: selectedCount })}
      closeLabel={t("close")}
      backdropDismissLabel={t("backdropDismiss")}
      testIdPrefix="bulk-apply"
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            data-testid="bulk-apply-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canApply}
            data-testid="bulk-apply-confirm"
            className="flex h-12 flex-1 items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {t("applyCta", { count: selectedCount })}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="bulk-apply-price-toggle"
              checked={applyPrice}
              onChange={(e) => setApplyPrice(e.target.checked)}
              className="h-5 w-5"
            />
            <span className="font-medium">{t("applyPriceLabel")}</span>
          </label>
          {applyPrice ? (
            <InlineNumberField
              label={tv("priceLabel")}
              affix={tv("currencyAffix")}
              inputMode="decimal"
              testId="bulk-apply-price-field"
              min={0}
              step={0.01}
              value={priceText}
              onChange={setPriceText}
              error={applyPrice && !priceValid ? tv("priceInvalid") : null}
            />
          ) : null}
        </div>
        <div className="space-y-2">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="bulk-apply-stock-toggle"
              checked={applyStock}
              onChange={(e) => setApplyStock(e.target.checked)}
              className="h-5 w-5"
            />
            <span className="font-medium">{t("applyStockLabel")}</span>
          </label>
          {applyStock ? (
            <InlineNumberField
              label={tv("stockLabel")}
              affix={tv("stockAffix")}
              inputMode="numeric"
              testId="bulk-apply-stock-field"
              min={0}
              step={1}
              value={stockText}
              onChange={setStockText}
              error={applyStock && !stockValid ? tv("stockInvalid") : null}
            />
          ) : null}
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {t("overwriteHelper")}
        </p>
      </div>
    </BottomSheet>
  );
}

function parsePriceMinor(text: string): number | null {
  if (text.length === 0) return null;
  const sar = Number.parseFloat(text);
  if (!Number.isFinite(sar) || sar < 0) return null;
  return Math.round(sar * 100);
}

function parseStock(text: string): number | null {
  if (text.length === 0) return null;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
