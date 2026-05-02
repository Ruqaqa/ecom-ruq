/**
 * `<VariantsList>` — the Variants block on the product edit page (chunk
 * 1a.5.2; bulk-select / per-row kebab / cap-warning amber / inline
 * confirm strip live in 1a.5.3). List-of-cards layout from Screen 2 of
 * the wireframe.
 *
 * Three modes derived from the parent's options state:
 *   - **single-variant flat form** when no options are defined; the
 *     operator types a single SKU/price/stock pair (Screen 3 State A).
 *   - **multi-variant cards** when one or more options are defined; the
 *     cartesian product of option values is the row set, with each row
 *     keyed by `variantRowKey(tuple)` so SKU/price/stock survive a
 *     re-render when the options tree changes mid-edit (Screens 3 B/D).
 *
 * Controlled-only: the parent owns the variant rows. This component
 * renders them and emits per-row edit callbacks; the parent computes
 * the cartesian and merges existing rows in via `buildVariantRows`.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { InlineNumberField } from "@/components/admin/inline-number-field";
import { RowSelectionToolbar } from "@/components/admin/row-selection-toolbar";
import {
  formatCombinationLabel,
  type EditorOption,
  type VariantRow,
} from "@/lib/variants/build-variant-rows";

interface Props {
  rows: VariantRow[];
  options: ReadonlyArray<EditorOption>;
  locale: "en" | "ar";
  rowErrors: Record<string, RowErrors | undefined>;
  onUpdateRow: (key: string, next: Partial<VariantRow>) => void;
  /**
   * 1a.5.3 — controlled select-mode + selected-key set (lifted to the
   * parent so the bulk-apply patch can be applied to the parent's
   * `variantState` map). When `selectMode` is false the leading
   * checkbox column is suppressed entirely.
   */
  selectMode: boolean;
  selectedKeys: ReadonlySet<string>;
  onToggleSelectMode: () => void;
  onToggleRowSelected: (key: string) => void;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onApplyBulk: () => void;
  /** Per-row kebab → Remove this variant. The parent removes the row from variant state. */
  onRemoveRow: (key: string) => void;
  /** Variant cap counter turns amber when the row count is at or beyond this threshold. */
  capWarningThreshold?: number;
}

export interface RowErrors {
  sku?: string;
  price?: string;
  stock?: string;
  combination?: string;
}

export function VariantsList({
  rows,
  options,
  locale,
  rowErrors,
  onUpdateRow,
  selectMode,
  selectedKeys,
  onToggleSelectMode,
  onToggleRowSelected,
  onSelectAllVisible,
  onClearSelection,
  onApplyBulk,
  onRemoveRow,
  capWarningThreshold = 95,
}: Props) {
  const t = useTranslations("admin.products.edit.variants");
  const tBulk = useTranslations("admin.products.edit.variants.bulkSelect");
  const tRow = useTranslations("admin.products.edit.variants.removeRow");
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);

  // Single-variant flat-form mode (no options defined).
  if (options.length === 0) {
    const row = rows[0]!;
    const errors = rowErrors[row.key];
    return (
      <section
        data-testid="variants-section"
        className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
      >
        <h2 className="text-sm font-medium">{t("headingSingle")}</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t("helperFlat")}
        </p>
        <div
          data-testid="variant-flat-form"
          className="mt-3 flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
        >
          <div>
            <label
              htmlFor="variant-flat-sku"
              className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
            >
              {t("skuLabel")}
            </label>
            <input
              id="variant-flat-sku"
              data-testid="variant-flat-sku"
              type="text"
              dir="ltr"
              value={row.sku}
              onChange={(e) => onUpdateRow(row.key, { sku: e.target.value })}
              aria-invalid={errors?.sku ? true : undefined}
              className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 font-mono text-base dark:border-neutral-700 dark:bg-neutral-900"
            />
            {errors?.sku ? (
              <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
                {errors.sku}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <VariantPriceField
              testId="variant-flat-price"
              priceMinor={row.priceMinor}
              onCommit={(next) => onUpdateRow(row.key, { priceMinor: next })}
              label={t("priceLabel")}
              affix={t("currencyAffix")}
              error={errors?.price ?? null}
            />
            <InlineNumberField
              label={t("stockLabel")}
              affix={t("stockAffix")}
              inputMode="numeric"
              testId="variant-flat-stock"
              min={0}
              step={1}
              value={stockToText(row.stock)}
              onChange={(next) =>
                onUpdateRow(row.key, { stock: textToStock(next) })
              }
              error={errors?.stock ?? null}
            />
          </div>
        </div>
      </section>
    );
  }

  // Multi-variant cards. The combination label uses the same option
  // ordering as the cartesian generator, so the visible label and the
  // row's data-key stay in lock-step.
  const capAmber = rows.length >= capWarningThreshold;
  return (
    <section
      data-testid="variants-section"
      className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t("headingMulti")}</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleSelectMode}
            data-testid="variants-section-select-toggle"
            className="flex h-9 items-center justify-center rounded-md px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {selectMode ? tBulk("exitSelectMode") : tBulk("enterSelectMode")}
          </button>
          <span
            data-testid="variant-cap-counter"
            className={
              capAmber
                ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                : "rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            }
          >
            {t("capCounter", { count: rows.length })}
          </span>
        </div>
      </div>

      <ul className="mt-3 space-y-3">
        {rows.map((row) => {
          const label = formatCombinationLabel(row.tuple, options, locale);
          const errors = rowErrors[row.key];
          const isSelected = selectedKeys.has(row.key);
          const isConfirmingRemove = confirmingKey === row.key;
          return (
            <li key={row.key}>
              <article
                data-testid="variant-row"
                data-key={row.key}
                data-selected={isSelected ? "true" : "false"}
                aria-label={label}
                className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
              >
                {isConfirmingRemove ? (
                  <div
                    data-testid="variant-row-remove-confirm"
                    className="flex flex-col gap-2 rounded-md bg-red-50 p-2 sm:flex-row sm:items-center sm:justify-between dark:bg-red-950/40"
                  >
                    <p className="ps-2 text-sm font-medium text-red-800 dark:text-red-300">
                      {tRow("inlineConfirmQuestion")}{" "}
                      <span className="font-normal">{label}</span>
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmingKey(null)}
                        data-testid="variant-row-remove-confirm-no"
                        className="flex h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        {tRow("inlineConfirmCancel")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingKey(null);
                          onRemoveRow(row.key);
                        }}
                        data-testid="variant-row-remove-confirm-yes"
                        className="flex h-11 items-center justify-center rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700"
                      >
                        {tRow("inlineConfirmRemove")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    {selectMode ? (
                      <input
                        type="checkbox"
                        data-testid="variant-row-checkbox"
                        checked={isSelected}
                        onChange={() => onToggleRowSelected(row.key)}
                        aria-label={tBulk("rowSelectAriaLabel", { label })}
                        className="mt-1 h-5 w-5"
                      />
                    ) : null}
                    <div className="flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          data-testid="variant-combination-label"
                          className="flex-1 truncate text-sm font-medium"
                        >
                          {label}
                        </p>
                        {!selectMode ? (
                          <RowKebab
                            label={tRow("kebabAriaLabel")}
                            removeLabel={tRow("removeMenuItem")}
                            onRemove={() => setConfirmingKey(row.key)}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
                {!isConfirmingRemove ? (
                  <>
                    <div className="mt-3">
                      <label
                        htmlFor={`variant-sku-${row.key}`}
                        className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
                      >
                        {t("skuLabel")}
                      </label>
                      <input
                        id={`variant-sku-${row.key}`}
                        data-testid="variant-sku"
                        type="text"
                        dir="ltr"
                        value={row.sku}
                        onChange={(e) =>
                          onUpdateRow(row.key, { sku: e.target.value })
                        }
                        aria-invalid={errors?.sku ? true : undefined}
                        className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 font-mono text-base dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      {errors?.sku ? (
                        <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
                          {errors.sku}
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                      <VariantPriceField
                        testId="variant-price"
                        priceMinor={row.priceMinor}
                        onCommit={(next) =>
                          onUpdateRow(row.key, { priceMinor: next })
                        }
                        label={t("priceLabel")}
                        affix={t("currencyAffix")}
                        error={errors?.price ?? null}
                      />
                      <InlineNumberField
                        label={t("stockLabel")}
                        affix={t("stockAffix")}
                        inputMode="numeric"
                        testId="variant-stock"
                        min={0}
                        step={1}
                        value={stockToText(row.stock)}
                        onChange={(next) =>
                          onUpdateRow(row.key, { stock: textToStock(next) })
                        }
                        error={errors?.stock ?? null}
                      />
                    </div>
                    {errors?.combination ? (
                      <p
                        role="alert"
                        data-testid="variant-combination-error"
                        className="mt-2 text-xs text-red-700 dark:text-red-400"
                      >
                        {errors.combination}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>

      <RowSelectionToolbar
        testIdPrefix="variants-bulk-toolbar"
        selectedCount={selectedKeys.size}
        countLabel={tBulk("selectionCount", { count: selectedKeys.size })}
        toolbarAriaLabel={tBulk("toolbarAriaLabel")}
        selectAllVisibleLabel={tBulk("selectAllVisible")}
        applyLabel={t("bulkApply.applyCta", { count: selectedKeys.size })}
        onSelectAllVisible={onSelectAllVisible}
        onApply={() => {
          if (selectedKeys.size === 0) {
            onClearSelection();
            return;
          }
          onApplyBulk();
        }}
      />
    </section>
  );
}

interface RowKebabProps {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}

function RowKebab({ label, removeLabel, onRemove }: RowKebabProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="variant-row-menu-cta"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open ? true : false}
        className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-0 cursor-default"
          />
          <div
            role="menu"
            data-testid="variant-row-menu"
            className="absolute end-0 top-full z-10 mt-1 min-w-[12rem] rounded-md border border-neutral-200 bg-white p-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="variant-row-menu-remove"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              className="flex h-11 w-full items-center rounded-md px-3 text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {removeLabel}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface VariantPriceFieldProps {
  testId: string;
  priceMinor: number | null;
  onCommit: (next: number | null) => void;
  label: string;
  affix: string;
  error?: string | null;
}

// Per-keystroke text round-trip would reformat "3" into "3.00" mid-typing
// and silently round the next character away, so the field tracks its own
// draft text while focused and only commits the parsed cents on blur.
function VariantPriceField({
  testId,
  priceMinor,
  onCommit,
  label,
  affix,
  error,
}: VariantPriceFieldProps) {
  const externalText = priceMinorToText(priceMinor);
  const [draft, setDraft] = useState(externalText);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(externalText);
  }, [externalText, focused]);
  return (
    <InlineNumberField
      label={label}
      affix={affix}
      inputMode="decimal"
      testId={testId}
      min={0}
      step={0.01}
      value={draft}
      onChange={setDraft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onCommit(textToPriceMinor(draft));
      }}
      error={error ?? null}
    />
  );
}

function priceMinorToText(value: number | null): string {
  if (value === null) return "";
  return (value / 100).toFixed(2);
}

function textToPriceMinor(text: string): number | null {
  if (text.length === 0) return null;
  const sar = Number.parseFloat(text);
  if (!Number.isFinite(sar)) return null;
  return Math.round(sar * 100);
}

function stockToText(value: number | null): string {
  if (value === null) return "";
  return String(value);
}

function textToStock(text: string): number | null {
  if (text.length === 0) return null;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}
