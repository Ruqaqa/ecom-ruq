/**
 * `<TransitionNotice>` — shared dismissible info banner (chunk 1a.5.3).
 *
 * Used to surface non-error transitions where the operator's data has
 * been silently preserved (e.g. multi → single variant collapse, single
 * → multi expansion). Amber palette, mobile-first, ≥44×44 dismiss
 * button, RTL-safe via Tailwind logical properties.
 */
"use client";

interface Props {
  /** Stable selector for the banner container and the dismiss button. */
  testId: string;
  /** Localized body copy. */
  body: string;
  /** Localized aria-label for the dismiss button. */
  dismissAriaLabel: string;
  /** Called when the dismiss × is pressed. */
  onDismiss: () => void;
}

export function TransitionNotice({
  testId,
  body,
  dismissAriaLabel,
  onDismiss,
}: Props) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 ps-3 pe-1 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="flex-1">{body}</p>
      <button
        type="button"
        onClick={onDismiss}
        data-testid={`${testId}-dismiss`}
        aria-label={dismissAriaLabel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-amber-100 dark:hover:bg-amber-900/40"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
