/**
 * `<RowSelectionToolbar>` — sticky toolbar surfaced when select-mode is
 * active and at least one row is selected (chunk 1a.5.3).
 *
 * Shared admin primitive — currently consumed by `<VariantsList>` for
 * bulk-apply price/stock; future multi-row admin lists (categories,
 * products) can drop it in.
 *
 * Mobile-first. The toolbar docks at the bottom of the variants section
 * (sticky, NOT page-fixed) so it does not overlap the form's primary
 * sticky save bar. Translucent surface with a top hairline. Live count
 * announced via `aria-live="polite"`.
 */
"use client";

import type { ReactNode } from "react";

interface Props {
  /** Stable selector prefix (`variants-bulk-toolbar`, etc). */
  testIdPrefix: string;
  /** Number of currently-selected rows; the toolbar hides when zero. */
  selectedCount: number;
  /** Localized count text (caller renders the ICU plural). */
  countLabel: string;
  /** Localized aria-label for the toolbar element. */
  toolbarAriaLabel: string;
  /** Localized "Select all visible" link copy. */
  selectAllVisibleLabel: string;
  /** Localized primary action button copy (e.g. "Apply…"). */
  applyLabel: string;
  /** Optional element rendered between the count and the buttons (e.g. an exit-mode link). */
  trailingChildren?: ReactNode;
  onSelectAllVisible: () => void;
  onApply: () => void;
}

export function RowSelectionToolbar({
  testIdPrefix,
  selectedCount,
  countLabel,
  toolbarAriaLabel,
  selectAllVisibleLabel,
  applyLabel,
  trailingChildren,
  onSelectAllVisible,
  onApply,
}: Props) {
  if (selectedCount <= 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={toolbarAriaLabel}
      data-testid={testIdPrefix}
      className="sticky bottom-0 z-10 mt-3 flex items-center gap-2 rounded-md border border-neutral-200 bg-white/95 p-2 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95"
    >
      <span
        aria-live="polite"
        data-testid={`${testIdPrefix}-count`}
        className="flex-1 ps-2 text-sm font-medium"
      >
        {countLabel}
      </span>
      <button
        type="button"
        onClick={onSelectAllVisible}
        data-testid={`${testIdPrefix}-select-all`}
        className="flex h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {selectAllVisibleLabel}
      </button>
      {trailingChildren}
      <button
        type="button"
        onClick={onApply}
        data-testid={`${testIdPrefix}-apply`}
        className="flex h-11 items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        {applyLabel}
      </button>
    </div>
  );
}
