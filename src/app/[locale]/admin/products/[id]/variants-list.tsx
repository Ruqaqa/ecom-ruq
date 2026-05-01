/**
 * `<VariantsList>` — the Variants block on the product edit page (chunk
 * 1a.5.2). List-of-cards layout from Screen 2 of the wireframe.
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

import { useTranslations } from "next-intl";
import { InlineNumberField } from "@/components/admin/inline-number-field";
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
}: Props) {
  const t = useTranslations("admin.products.edit.variants");

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
            <InlineNumberField
              label={t("priceLabel")}
              affix={t("currencyAffix")}
              inputMode="decimal"
              testId="variant-flat-price"
              min={0}
              step={0.01}
              value={priceMinorToText(row.priceMinor)}
              onChange={(next) =>
                onUpdateRow(row.key, { priceMinor: textToPriceMinor(next) })
              }
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
  return (
    <section
      data-testid="variants-section"
      className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t("headingMulti")}</h2>
        <span
          data-testid="variant-cap-counter"
          className={
            rows.length >= 95
              ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
              : "rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          }
        >
          {t("capCounter", { count: rows.length })}
        </span>
      </div>

      <ul className="mt-3 space-y-3">
        {rows.map((row) => {
          const label = formatCombinationLabel(row.tuple, options, locale);
          const errors = rowErrors[row.key];
          return (
            <li key={row.key}>
              <article
                data-testid="variant-row"
                data-key={row.key}
                aria-label={label}
                className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <p
                  data-testid="variant-combination-label"
                  className="truncate text-sm font-medium"
                >
                  {label}
                </p>
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
                  <InlineNumberField
                    label={t("priceLabel")}
                    affix={t("currencyAffix")}
                    inputMode="decimal"
                    testId="variant-price"
                    min={0}
                    step={0.01}
                    value={priceMinorToText(row.priceMinor)}
                    onChange={(next) =>
                      onUpdateRow(row.key, {
                        priceMinor: textToPriceMinor(next),
                      })
                    }
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
              </article>
            </li>
          );
        })}
      </ul>
    </section>
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
