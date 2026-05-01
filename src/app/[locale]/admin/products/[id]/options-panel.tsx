/**
 * `<OptionsPanel>` — the Options block on the product edit page (chunk
 * 1a.5.2). Inline list of option-type cards (Screen 1 of the wireframe);
 * no per-option sheet — operators define options + values without losing
 * sight of the cap counter.
 *
 * Controlled-only: the parent owns the options state. This component
 * mirrors that state into editor rows. Adds and renames stay client-
 * side until Save; removal of an existing option type is disabled with
 * helper copy because 1a.5.1's `setProductOptions` rejects
 * removal-via-set-replace (1a.5.3 wires the cascade flow).
 *
 * Each option-type and option-value gets a stable client uuid so the
 * cartesian generator can key rows deterministically across renders.
 * On Save the parent strips client-only ids (server-minted uuids
 * replace them) and submits the canonical shape.
 */
"use client";

import { useTranslations } from "next-intl";
import type { EditorOption, EditorOptionValue } from "@/lib/variants/build-variant-rows";

const MAX_OPTIONS = 3;

interface Props {
  options: EditorOption[];
  /** Returns true iff the option's id was already on the server when the form mounted. */
  isPersistedOption: (optionId: string) => boolean;
  onAddOption: () => void;
  onUpdateOption: (
    optionId: string,
    next: { name?: { en?: string; ar?: string } },
  ) => void;
  onAddValue: (optionId: string) => void;
  onUpdateValue: (
    optionId: string,
    valueId: string,
    next: { value?: { en?: string; ar?: string } },
  ) => void;
  onRemoveValue: (optionId: string, valueId: string) => void;
}

export function OptionsPanel({
  options,
  isPersistedOption,
  onAddOption,
  onUpdateOption,
  onAddValue,
  onUpdateValue,
  onRemoveValue,
}: Props) {
  const t = useTranslations("admin.products.edit.options");
  const atCap = options.length >= MAX_OPTIONS;
  return (
    <section
      data-testid="options-panel"
      className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        <span
          data-testid="option-cap-counter"
          className={
            atCap
              ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
              : "rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          }
        >
          {t("capCounter", { count: options.length })}
        </span>
      </div>

      {options.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("helperEmpty")}
        </p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {options.map((opt) => (
          <li key={opt.id}>
            <OptionTypeCard
              option={opt}
              persisted={isPersistedOption(opt.id)}
              onUpdateOption={(next) => onUpdateOption(opt.id, next)}
              onAddValue={() => onAddValue(opt.id)}
              onUpdateValue={(valueId, next) =>
                onUpdateValue(opt.id, valueId, next)
              }
              onRemoveValue={(valueId) => onRemoveValue(opt.id, valueId)}
            />
          </li>
        ))}
      </ul>

      {atCap ? (
        <p
          data-testid="option-cap-reached-help"
          className="mt-3 text-xs text-amber-700 dark:text-amber-400"
        >
          {t("capReachedHelp")}
        </p>
      ) : (
        <button
          type="button"
          onClick={onAddOption}
          data-testid="add-option-type"
          className="mt-3 flex h-12 w-full items-center justify-center rounded-md border border-dashed border-neutral-300 bg-white text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          + {t("addOptionType")}
        </button>
      )}
    </section>
  );
}

interface OptionCardProps {
  option: EditorOption;
  persisted: boolean;
  onUpdateOption: (next: { name?: { en?: string; ar?: string } }) => void;
  onAddValue: () => void;
  onUpdateValue: (
    valueId: string,
    next: { value?: { en?: string; ar?: string } },
  ) => void;
  onRemoveValue: (valueId: string) => void;
}

function OptionTypeCard({
  option,
  persisted,
  onUpdateOption,
  onAddValue,
  onUpdateValue,
  onRemoveValue,
}: OptionCardProps) {
  const t = useTranslations("admin.products.edit.options");
  return (
    <div
      data-testid="option-type-card"
      data-id={option.id}
      data-persisted={persisted ? "true" : "false"}
      className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="flex-1">
          <label
            htmlFor={`option-name-en-${option.id}`}
            className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
          >
            {t("nameEnLabel")}
          </label>
          <input
            id={`option-name-en-${option.id}`}
            data-testid="option-name-en-input"
            type="text"
            dir="ltr"
            value={option.name.en}
            onChange={(e) =>
              onUpdateOption({ name: { en: e.target.value } })
            }
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div className="flex-1">
          <label
            htmlFor={`option-name-ar-${option.id}`}
            className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
          >
            {t("nameArLabel")}
          </label>
          <input
            id={`option-name-ar-${option.id}`}
            data-testid="option-name-ar-input"
            type="text"
            dir="rtl"
            value={option.name.ar}
            onChange={(e) =>
              onUpdateOption({ name: { ar: e.target.value } })
            }
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        {/* The cascade-confirm flow lands in 1a.5.3. Testids
            `remove-option-dialog` / `remove-option-cascade-warning` /
            `remove-option-confirm` / `remove-option-cancel` are
            reserved by design for that wiring — do not strip them as
            "unused" before 1a.5.3 ships, and do not rename
            `remove-option-cta` here. */}
        <button
          type="button"
          data-testid="option-remove-cta"
          disabled={true}
          aria-disabled="true"
          aria-describedby={`option-remove-help-${option.id}`}
          className="h-11 self-end rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 opacity-60 disabled:cursor-not-allowed dark:border-red-900/60 dark:bg-neutral-950 dark:text-red-400"
        >
          {t("removeOptionCta")}
        </button>
      </div>
      <p
        id={`option-remove-help-${option.id}`}
        data-testid="remove-option-cta-disabled-helper"
        className="mt-1 text-xs text-neutral-500 dark:text-neutral-400"
      >
        {t("removeOptionDisabledHelp")}
      </p>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-700 dark:text-neutral-300">
          {t("valuesLabel")}
        </p>
        <ul className="mt-2 space-y-2">
          {option.values.map((v) => (
            <li key={v.id}>
              <OptionValueRow
                value={v}
                onUpdate={(next) => onUpdateValue(v.id, next)}
                onRemove={() => onRemoveValue(v.id)}
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onAddValue}
          data-testid="add-option-value"
          data-option-id={option.id}
          className="mt-3 flex h-11 w-full items-center justify-center rounded-md border border-dashed border-neutral-300 bg-white text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          + {t("addOptionValue")}
        </button>
      </div>
    </div>
  );
}

interface OptionValueRowProps {
  value: EditorOptionValue;
  onUpdate: (next: { value?: { en?: string; ar?: string } }) => void;
  onRemove: () => void;
}

function OptionValueRow({ value, onUpdate, onRemove }: OptionValueRowProps) {
  const t = useTranslations("admin.products.edit.options");
  return (
    <div
      data-testid="option-value-row"
      data-id={value.id}
      className="flex flex-col gap-2 rounded-md border border-neutral-200 p-2 sm:flex-row sm:items-end sm:gap-3 dark:border-neutral-800"
    >
      <div className="flex-1">
        <label
          htmlFor={`option-value-en-${value.id}`}
          className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
        >
          {t("valueEnLabel")}
        </label>
        <input
          id={`option-value-en-${value.id}`}
          data-testid="option-value-en-input"
          type="text"
          dir="ltr"
          value={value.value.en}
          onChange={(e) => onUpdate({ value: { en: e.target.value } })}
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex-1">
        <label
          htmlFor={`option-value-ar-${value.id}`}
          className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
        >
          {t("valueArLabel")}
        </label>
        <input
          id={`option-value-ar-${value.id}`}
          data-testid="option-value-ar-input"
          type="text"
          dir="rtl"
          value={value.value.ar}
          onChange={(e) => onUpdate({ value: { ar: e.target.value } })}
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        data-testid="option-value-remove"
        aria-label={t("valueRemoveAriaLabel")}
        className="flex h-11 w-11 items-center justify-center self-end rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
