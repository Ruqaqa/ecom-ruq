/**
 * `<InlineNumberField>` — number input with leading affix (chunk
 * 1a.5.2). Used by the variants list for price + stock and reused by
 * 1a.5.3's bulk-apply sheet.
 *
 * Mobile-first. ≥ 44×44 hit area. `inputmode` is caller-set so an
 * integer field (stock) gets the numeric keypad and a decimal field
 * (price) gets the decimal keypad. The affix rides on the visual
 * `start` side via Tailwind logical properties so RTL flips correctly.
 *
 * Validation copy is rendered below the input via the `error` slot;
 * keeping the shape identical across all use sites means duplicate-
 * SKU / out-of-range / cap-hit messages all read the same.
 */
"use client";

import { useId, type InputHTMLAttributes } from "react";

interface Props {
  /** Localized visible label. */
  label: string;
  /** Optional affix rendered inside the input on the start side (e.g. `SAR`, `pcs`). */
  affix?: string;
  /** Either `decimal` (price) or `numeric` (stock). */
  inputMode: "decimal" | "numeric";
  /** Stable selector (e.g. `variant-price`). */
  testId: string;
  /** Optional minimum (passed to the input element). */
  min?: number;
  /** Optional step (passed to the input element). */
  step?: number;
  /** Field value as a string — uncontrolled forms set with the empty string for "no value yet". */
  value: string;
  onChange: (next: string) => void;
  /** Localized error message; renders the input in error state when present. */
  error?: string | null;
  /** Whether the field is required (browser validation hint). */
  required?: boolean;
  /** Forwarded to the underlying input element. */
  autoComplete?: InputHTMLAttributes<HTMLInputElement>["autoComplete"];
  /** Optional disabled flag. */
  disabled?: boolean;
}

export function InlineNumberField({
  label,
  affix,
  inputMode,
  testId,
  min,
  step,
  value,
  onChange,
  error,
  required,
  autoComplete,
  disabled,
}: Props) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex w-full flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </label>
      <div
        className={
          error
            ? "relative flex h-11 items-stretch overflow-hidden rounded-md border border-red-500 bg-white dark:bg-neutral-900"
            : "relative flex h-11 items-stretch overflow-hidden rounded-md border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
        }
      >
        {affix ? (
          <span
            aria-hidden="true"
            className="flex items-center bg-neutral-50 px-3 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {affix}
          </span>
        ) : null}
        <input
          id={id}
          data-testid={testId}
          type="number"
          inputMode={inputMode}
          min={min}
          step={step}
          dir="ltr"
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          autoComplete={autoComplete}
          disabled={disabled}
          className="block w-full bg-transparent px-3 text-base outline-none disabled:opacity-60"
        />
      </div>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
