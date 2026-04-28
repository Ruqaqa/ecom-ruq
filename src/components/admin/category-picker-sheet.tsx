/**
 * `<CategoryPickerSheet>` — shared admin picker (chunk 1a.4.2 Block 4,
 * sliced forward into Block 2 because the parent picker on the
 * create/edit category forms depends on it).
 *
 * Controlled-only: the parent owns selection state. The component
 * mirrors the desired set in local "draft" state while the sheet is
 * open and commits to the parent on Apply. Cancel is a true no-op
 * (parent state unchanged).
 *
 * Modes:
 *   - `single` — radio buttons; Apply commits 0 or 1 id.
 *   - `multi`  — checkboxes; Apply commits 0..N ids.
 *
 * A11y contract (load-bearing — see master brief Block 4 spec):
 *   - role="dialog" aria-modal="true"
 *   - aria-labelledby points at the heading
 *   - first focus on close button
 *   - Tab cycles inside; Escape closes (calls onCancel)
 *   - backdrop tap closes (calls onCancel)
 *   - aria-live="polite" announces the filtered count when search
 *     filters change
 *   - The body region uses `overscroll-contain` so vertical scroll at
 *     the bottom does not propagate to the page underneath. Master-brief
 *     addendum — required for both UX (no jank under iOS rubber-band)
 *     and the Apply-still-visible test assertion in Block 6.
 *
 * Disabled rows:
 *   - 50% opacity, aria-disabled, with a one-line helper underneath
 *     explaining why ("depth_cap" → 3-level limit; "self_or_descendant"
 *     → cannot select itself or its descendants).
 *
 * Path strings are pre-built by the caller (see `buildCategoryOptions`).
 * The component picks `fullPath[locale]` directly; missing translation
 * fallbacks already lived in the option builder.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslations } from "next-intl";
import type { CategoryOption } from "@/lib/categories/build-category-options";

export type CategoryPickerMode = "single" | "multi";
export type CategoryPickerDisabledReason =
  | "depth_cap"
  | "self_or_descendant";

interface Props {
  open: boolean;
  mode: CategoryPickerMode;
  selectedIds: ReadonlyArray<string>;
  categories: ReadonlyArray<CategoryOption>;
  excludeIds?: ReadonlyArray<string>;
  searchable?: boolean;
  locale: "en" | "ar";
  onApply: (nextIds: string[]) => void;
  onCancel: () => void;
}

interface RowOption extends CategoryOption {
  disabled: boolean;
  disabledReason: CategoryPickerDisabledReason | null;
}

const DEPTH_INDENT_CLASS: Record<1 | 2 | 3, string> = {
  1: "ps-0",
  2: "ps-4",
  3: "ps-8",
};

export function CategoryPickerSheet({
  open,
  mode,
  selectedIds,
  categories,
  excludeIds,
  searchable = true,
  locale,
  onApply,
  onCancel,
}: Props) {
  const t = useTranslations("admin.categoryPicker");

  // Local "draft" selection — synced from parent on open.
  const [draft, setDraft] = useState<string[]>(() => [...selectedIds]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) {
      setDraft([...selectedIds]);
      setQuery("");
    }
    // We deliberately don't watch selectedIds while open — committing
    // happens through onApply. The parent re-mounts (or flips `open`)
    // when it wants the draft refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Capture the previously-focused element on open so we can restore on
  // close. Restoring focus is part of the a11y contract.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    // Defer focus until after the dialog mounts.
    queueMicrotask(() => closeBtnRef.current?.focus());
    return () => {
      // On close, restore focus to the trigger if it's still in the DOM.
      const t = triggerRef.current;
      if (t && document.body.contains(t)) {
        t.focus();
      }
    };
  }, [open]);

  // Disabled-rows computation: depth-3 are always disabled (cannot host
  // a child), and any id in excludeIds is also disabled with a different
  // reason ("self_or_descendant" — provided by the caller for the edit
  // case).
  const excludeSet = useMemo(
    () => new Set(excludeIds ?? []),
    [excludeIds],
  );
  const rows: RowOption[] = useMemo(
    () =>
      categories.map((c) => {
        if (excludeSet.has(c.id)) {
          return { ...c, disabled: true, disabledReason: "self_or_descendant" };
        }
        if (c.depth === 3) {
          return { ...c, disabled: true, disabledReason: "depth_cap" };
        }
        return { ...c, disabled: false, disabledReason: null };
      }),
    [categories, excludeSet],
  );

  // Search filtering — by localized fullPath OR slug, case-insensitive.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter((r) => {
      const path = r.fullPath[locale].toLowerCase();
      if (path.includes(q)) return true;
      if (r.slug.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, query, locale]);

  const selectedCount = draft.length;
  const filteredCount = filteredRows.length;

  // Toggle a row in the draft set.
  const toggle = useCallback(
    (id: string, disabled: boolean): void => {
      if (disabled) return;
      setDraft((prev) => {
        if (mode === "single") {
          // Single-select: clicking the already-selected row deselects.
          return prev.includes(id) ? [] : [id];
        }
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      });
    },
    [mode],
  );

  // Tab-cycle focus trap. Track all tabbable elements inside the dialog;
  // Tab off the last → first, Shift+Tab off the first → last. Escape
  // closes.
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

  const headingId = "category-picker-heading";

  return (
    <div
      data-testid="category-picker-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      ref={dialogRef}
      className="fixed inset-0 z-30 flex items-end justify-center sm:items-center"
    >
      {/* Backdrop. Clicking it cancels. */}
      <button
        type="button"
        aria-label={t("backdropDismiss")}
        data-testid="category-picker-backdrop"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
        data-tab-skip="true"
        tabIndex={-1}
      />

      {/* Sheet card. Bottom-sheet on mobile, centered modal on sm+. */}
      <section
        className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-lg bg-white shadow-xl sm:rounded-lg dark:bg-neutral-900"
      >
        {/* Sticky header. */}
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2
            id={headingId}
            data-testid="category-picker-heading"
            className="text-base font-semibold"
          >
            {t(mode === "multi" ? "headingMulti" : "headingSingle")}
          </h2>
          <div className="flex items-center gap-2">
            {mode === "multi" ? (
              <span
                data-testid="category-picker-selected-count"
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {t("selectedCount", { count: selectedCount })}
              </span>
            ) : null}
            <button
              type="button"
              ref={closeBtnRef}
              onClick={onCancel}
              data-testid="category-picker-close"
              aria-label={t("close")}
              className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        {/* Scrollable body region. overscroll-contain prevents the
            scroll inside from rubber-banding onto the page underneath
            (master-brief addendum). */}
        <div
          data-testid="category-picker-body"
          className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-4"
        >
          {searchable ? (
            <div>
              <label htmlFor="category-picker-search" className="sr-only">
                {t("searchLabel")}
              </label>
              <input
                id="category-picker-search"
                data-testid="category-picker-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
              />
              <p
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
              >
                {t("searchResultCount", { count: filteredCount })}
              </p>
            </div>
          ) : null}

          {rows.length === 0 ? (
            <div data-testid="category-picker-empty" className="py-8 text-center">
              <p className="text-sm text-neutral-700 dark:text-neutral-300">
                {t("emptyHeading")}
              </p>
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                {t("emptyHelper")}
              </p>
              <a
                href={`/${locale}/admin/categories/new`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="category-picker-empty-cta"
                className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {t("emptyCta")}
              </a>
            </div>
          ) : filteredRows.length === 0 ? (
            <p
              data-testid="category-picker-no-results"
              className="py-8 text-center text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t("noResults")}
            </p>
          ) : (
            <ul role="list" className="space-y-1">
              {filteredRows.map((r) => {
                const checked = draft.includes(r.id);
                const inputType = mode === "multi" ? "checkbox" : "radio";
                const inputTestid =
                  mode === "multi"
                    ? "category-picker-checkbox"
                    : "category-picker-radio";
                const path = r.fullPath[locale];
                return (
                  <li key={r.id}>
                    <label
                      data-testid="category-picker-row"
                      data-id={r.id}
                      data-depth={r.depth}
                      data-disabled={r.disabled ? "true" : "false"}
                      data-disabled-reason={r.disabledReason ?? ""}
                      aria-disabled={r.disabled || undefined}
                      className={
                        r.disabled
                          ? `${DEPTH_INDENT_CLASS[r.depth]} flex cursor-not-allowed flex-col gap-1 rounded-md p-3 opacity-50`
                          : `${DEPTH_INDENT_CLASS[r.depth]} flex cursor-pointer flex-col gap-1 rounded-md p-3 hover:bg-neutral-50 dark:hover:bg-neutral-800`
                      }
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type={inputType}
                          name="category-picker-choice"
                          data-testid={inputTestid}
                          data-id={r.id}
                          checked={checked}
                          onChange={() => toggle(r.id, r.disabled)}
                          disabled={r.disabled}
                          className="h-5 w-5"
                        />
                        <span className="flex-1 text-sm">{path}</span>
                      </div>
                      {r.disabled ? (
                        <p className="ms-8 text-xs text-neutral-500 dark:text-neutral-400">
                          {t(
                            r.disabledReason === "depth_cap"
                              ? "disabledDepthCap"
                              : "disabledSelfOrDescendant",
                          )}
                        </p>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Sticky footer. */}
        <footer className="flex items-stretch gap-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onCancel}
            data-testid="category-picker-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => onApply([...draft])}
            data-testid="category-picker-apply"
            className="flex h-12 flex-1 items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            {mode === "multi"
              ? t("applyCount", { count: selectedCount })
              : t("apply")}
          </button>
        </footer>
      </section>
    </div>
  );
}
