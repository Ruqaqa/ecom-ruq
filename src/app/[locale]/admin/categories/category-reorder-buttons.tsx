/**
 * `CategoryReorderButtons` — sibling-swap arrows on the admin categories
 * list page (1a.4.2 follow-up).
 *
 * Replaces the leaky operator-facing "Position" form field. One pair of
 * buttons per row; tapping either swaps the row's position with that of
 * its immediate sibling neighbour. Server-side service (`moveCategory`)
 * is the authority on what "neighbour" means — see
 * src/server/services/categories/move-category.ts for the ordering and
 * tie-break rules.
 *
 * Mobile-first invariants:
 *   - Each button is 44×44px (CLAUDE.md §3 hard rule).
 *   - SVG glyphs are direction-agnostic (vertical arrows; up still means
 *     earlier-in-the-list in both LTR and RTL — the list reads
 *     top-to-bottom regardless of script).
 *   - aria-label includes the row's localized name so screen readers
 *     announce "Move <name> up / down".
 *
 * Concurrency:
 *   - `disabled` on the button while the mutation is in flight prevents
 *     a double-tap from racing against itself.
 *   - The page reloads via `router.refresh()` on success so the new
 *     order renders authoritatively from the server.
 *
 * Edge handling:
 *   - The parent (server-rendered list) hides the up arrow on the first
 *     sibling and the down arrow on the last sibling (visual contract).
 *   - The service treats a tap on the edge as an idempotent no-op anyway,
 *     so a stale layout (operator's view drifted) doesn't throw.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

interface Props {
  categoryId: string;
  displayName: string;
  showUp: boolean;
  showDown: boolean;
}

export function CategoryReorderButtons({
  categoryId,
  displayName,
  showUp,
  showDown,
}: Props) {
  const t = useTranslations("admin.categories.list");
  const router = useRouter();
  const [pending, setPending] = useState<"up" | "down" | null>(null);
  const [errorFlash, setErrorFlash] = useState<boolean>(false);

  const moveUp = trpc.categories.moveUp.useMutation({
    onSuccess: () => {
      setPending(null);
      router.refresh();
    },
    onError: () => {
      setPending(null);
      setErrorFlash(true);
    },
  });
  const moveDown = trpc.categories.moveDown.useMutation({
    onSuccess: () => {
      setPending(null);
      router.refresh();
    },
    onError: () => {
      setPending(null);
      setErrorFlash(true);
    },
  });

  function onUpClick(): void {
    if (pending) return;
    setErrorFlash(false);
    setPending("up");
    moveUp.mutate({ id: categoryId });
  }
  function onDownClick(): void {
    if (pending) return;
    setErrorFlash(false);
    setPending("down");
    moveDown.mutate({ id: categoryId });
  }

  return (
    <span
      data-testid="category-reorder-buttons"
      className="inline-flex items-center gap-1"
    >
      {showUp ? (
        <button
          type="button"
          onClick={onUpClick}
          disabled={pending !== null}
          data-testid="category-move-up"
          data-id={categoryId}
          aria-label={t("moveUpAriaLabel", { name: displayName })}
          title={t("moveUpAriaLabel", { name: displayName })}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-neutral-300 bg-white text-base hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          <ArrowUpIcon />
        </button>
      ) : (
        // Reserve space so rows with/without an arrow line up. aria-hidden
        // because there's no actionable affordance here for assistive tech.
        <span
          aria-hidden="true"
          data-testid="category-move-up-spacer"
          className="inline-block h-11 w-11"
        />
      )}
      {showDown ? (
        <button
          type="button"
          onClick={onDownClick}
          disabled={pending !== null}
          data-testid="category-move-down"
          data-id={categoryId}
          aria-label={t("moveDownAriaLabel", { name: displayName })}
          title={t("moveDownAriaLabel", { name: displayName })}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-neutral-300 bg-white text-base hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          <ArrowDownIcon />
        </button>
      ) : (
        <span
          aria-hidden="true"
          data-testid="category-move-down-spacer"
          className="inline-block h-11 w-11"
        />
      )}
      {errorFlash ? (
        <span
          role="alert"
          data-testid="category-reorder-error"
          className="ms-2 text-xs text-red-700 dark:text-red-400"
        >
          {t("moveError")}
        </span>
      ) : null}
    </span>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 16V4" />
      <path d="M5 9l5-5 5 5" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 4v12" />
      <path d="M5 11l5 5 5-5" />
    </svg>
  );
}
