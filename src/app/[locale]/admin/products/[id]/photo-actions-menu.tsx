/**
 * `<PhotoActionsMenu>` — kebab-triggered actions menu for a single
 * persisted photo tile. Four items: Set as cover / Edit description /
 * Replace / Remove.
 *
 * Mobile-first contract: on viewports ≤ sm we wrap the items inside the
 * shared `<BottomSheet>` so each menu item is a comfortable 44+ pixel
 * tap target with the standard sheet focus-trap and backdrop dismiss.
 * On sm+ we render an inline absolute-positioned popover anchored to
 * the kebab — chunk 1a.7.2 explicitly does NOT introduce a new shared
 * popover primitive, so the desktop affordance is intentionally simple.
 *
 * "Set as cover" is hidden when the tile already IS the cover; the
 * service rejects a no-op anyway, but hiding the menu item avoids a
 * confusing tap.
 */
"use client";

import { useEffect, useRef, type JSX } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet } from "@/components/admin/bottom-sheet";

interface Props {
  open: boolean;
  /** Whether to render as a bottom sheet (mobile) or inline popover (desktop). */
  variant: "sheet" | "popover";
  /** Hide "Set as cover" when this tile is already the cover. */
  isCover: boolean;
  onSetCover: () => void;
  onEditAlt: () => void;
  onReplace: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PhotoActionsMenu({
  open,
  variant,
  isCover,
  onSetCover,
  onEditAlt,
  onReplace,
  onRemove,
  onClose,
}: Props): JSX.Element | null {
  const t = useTranslations("admin.products.edit.images");

  if (!open) return null;

  const items = (
    <ul role="menu" className="flex flex-col">
      {!isCover ? (
        <MenuItem
          testId="product-photo-action-set-cover"
          label={t("tile.setCoverMenuItem")}
          onSelect={() => {
            onSetCover();
            onClose();
          }}
        />
      ) : null}
      <MenuItem
        testId="product-photo-action-edit-alt"
        label={t("tile.editAltMenuItem")}
        onSelect={() => {
          onEditAlt();
          onClose();
        }}
      />
      <MenuItem
        testId="product-photo-action-replace"
        label={t("tile.replaceMenuItem")}
        onSelect={() => {
          onReplace();
          onClose();
        }}
      />
      <MenuItem
        testId="product-photo-action-remove"
        label={t("tile.removeMenuItem")}
        onSelect={() => {
          onRemove();
          onClose();
        }}
        destructive
      />
    </ul>
  );

  if (variant === "sheet") {
    return (
      <BottomSheet
        open={open}
        heading={t("tile.actionsAriaLabel")}
        closeLabel={t("altSheet.cancel")}
        backdropDismissLabel={t("altSheet.cancel")}
        testIdPrefix="product-photo-actions"
        onCancel={onClose}
        footer={
          <button
            type="button"
            onClick={onClose}
            data-testid="product-photo-actions-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("altSheet.cancel")}
          </button>
        }
      >
        {items}
      </BottomSheet>
    );
  }

  return <PopoverShell onClose={onClose}>{items}</PopoverShell>;
}

function MenuItem({
  testId,
  label,
  onSelect,
  destructive = false,
}: {
  testId: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}): JSX.Element {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        data-testid={testId}
        onClick={onSelect}
        className={[
          "flex min-h-[44px] w-full items-center justify-start ps-4 pe-4 py-2 text-start text-sm",
          "hover:bg-neutral-100 dark:hover:bg-neutral-800",
          destructive
            ? "text-red-700 dark:text-red-400"
            : "text-neutral-900 dark:text-neutral-100",
        ].join(" ")}
      >
        {label}
      </button>
    </li>
  );
}

/**
 * Lightweight inline popover for sm+ viewports. Click-outside and Escape
 * both close it. Anchored absolute-bottom-end relative to the tile that
 * owns it (the parent sets a relative wrapper around the kebab so the
 * popover lands above-end of the trigger).
 */
function PopoverShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent): void {
      const root = ref.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onClose();
    }
    function onDocKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="product-photo-actions-popover"
      className="absolute bottom-14 end-2 z-10 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
    >
      {children}
    </div>
  );
}
