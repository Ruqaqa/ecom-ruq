/**
 * `<BottomSheet>` — shared bottom-sheet shell (chunk 1a.5.2).
 *
 * Extracted from `category-picker-sheet.tsx` so the bulk-apply sheet
 * (1a.5.3), and any future selection / confirm flow, can reuse the
 * focus-trap / escape / restore-focus / backdrop-cancel glue without
 * cloning it.
 *
 * Layout: bottom-sheet on mobile (≤ sm), centered modal on sm+. Header
 * + scrollable body + sticky footer. The body region uses
 * `overscroll-contain` so vertical scroll at the bottom does not
 * propagate to the page underneath (iOS rubber-band guard).
 *
 * A11y contract (preserved from the category-picker version):
 *   - role="dialog" aria-modal="true"
 *   - aria-labelledby points at the heading
 *   - first focus on the close button
 *   - Tab cycles inside; Escape closes (calls onCancel)
 *   - backdrop tap closes (calls onCancel)
 *   - focus restored to the trigger on close
 *
 * The `testIdPrefix` prop keeps each call site's selectors stable;
 * existing tests assert against `category-picker-*` and continue to
 * pass because `<CategoryPickerSheet>` passes `category-picker` here.
 */
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

interface Props {
  open: boolean;
  /** Localized heading text — owned by the caller. */
  heading: string;
  /** Localized aria-label for the close (×) button. */
  closeLabel: string;
  /** Localized aria-label for the backdrop dismiss button. */
  backdropDismissLabel: string;
  /** Stable selector prefix; `<X>-sheet`, `<X>-close`, etc. */
  testIdPrefix: string;
  /** Optional content rendered alongside the close button (e.g., a count pill). */
  headerExtras?: ReactNode;
  /** Body content (scrollable, overscroll-contained). */
  children: ReactNode;
  /** Footer content (sticky, full-width). Caller renders Cancel/Apply etc. */
  footer: ReactNode;
  /** Called when Escape, backdrop, or close (×) fires. */
  onCancel: () => void;
}

export function BottomSheet({
  open,
  heading,
  closeLabel,
  backdropDismissLabel,
  testIdPrefix,
  headerExtras,
  children,
  footer,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    queueMicrotask(() => closeBtnRef.current?.focus());
    return () => {
      const t = triggerRef.current;
      if (t && document.body.contains(t)) {
        t.focus();
      }
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const tabbables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("data-tab-skip"));
      if (tabbables.length === 0) return;
      const first = tabbables[0]!;
      const last = tabbables[tabbables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  const headingId = `${testIdPrefix}-heading`;

  return (
    <div
      data-testid={`${testIdPrefix}-sheet`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      ref={dialogRef}
      className="fixed inset-0 z-30 flex items-end justify-center sm:items-center"
    >
      <button
        type="button"
        aria-label={backdropDismissLabel}
        data-testid={`${testIdPrefix}-backdrop`}
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
        data-tab-skip="true"
        tabIndex={-1}
      />
      <section className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-lg bg-white shadow-xl sm:rounded-lg dark:bg-neutral-900">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2
            id={headingId}
            data-testid={`${testIdPrefix}-heading`}
            className="text-base font-semibold"
          >
            {heading}
          </h2>
          <div className="flex items-center gap-2">
            {headerExtras}
            <button
              type="button"
              ref={closeBtnRef}
              onClick={onCancel}
              data-testid={`${testIdPrefix}-close`}
              aria-label={closeLabel}
              className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <div
          data-testid={`${testIdPrefix}-body`}
          className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-4"
        >
          {children}
        </div>
        <footer className="flex items-stretch gap-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
          {footer}
        </footer>
      </section>
    </div>
  );
}
