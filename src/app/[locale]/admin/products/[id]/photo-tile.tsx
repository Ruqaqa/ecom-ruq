/**
 * `<PhotoTile>` — single 1:1 square tile in the product Photos library.
 *
 * Three rendering modes:
 *   1. Persisted tile (image row from images.list). Renders a thumbnail
 *      from the byte-read derivative route, with the cover badge,
 *      missing-alt-text indicator, and kebab actions menu.
 *   2. Optimistic in-flight tile (a freshly picked file mid-upload).
 *      Renders the local blob preview with a 0–100% progress overlay.
 *      No kebab while in-flight.
 *   3. Failed tile (upload settled in error). Red border + tap-to-retry.
 *
 * Square reserved by `aspect-square` so the grid does not jump as
 * thumbnails decode. Always uses logical positioning (`start`/`end`)
 * so RTL flips automatically.
 */
"use client";

import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  type HTMLAttributes,
  type JSX,
  type Ref,
} from "react";
import type { ImageDerivative } from "@/server/db/schema/_types";

/**
 * Sortable handle wiring passed in by the section's per-tile sortable
 * wrapper. Mirrors the surface of `useSortable` from `@dnd-kit/sortable`
 * without forcing this file to import the dnd-kit type — the tile is
 * happy to receive plain DOM attribute objects.
 */
export interface SortableHandleProps {
  attributes: HTMLAttributes<HTMLButtonElement>;
  listeners: HTMLAttributes<HTMLButtonElement> | undefined;
  setActivatorNodeRef: Ref<HTMLButtonElement>;
  isDragging: boolean;
}

export type PhotoTileMode =
  | {
      kind: "persisted";
      imageId: string;
      version: number;
      position: number;
      /** Full derivative ledger; the thumbnail picks the matching entry. */
      derivatives: ReadonlyArray<ImageDerivative>;
    }
  | { kind: "uploading"; clientId: string; percent: number }
  | { kind: "failed"; clientId: string };

interface CommonProps {
  /** EN/AR alt-text pair; either side may be missing. */
  altText: { en?: string; ar?: string } | null;
  /** Whether this tile is the product cover (position 0). */
  isCover: boolean;
  /** Local blob URL when `mode.kind` is "uploading" or "failed". */
  blobPreviewUrl?: string;
  hydrated: boolean;
}

interface PersistedProps extends CommonProps {
  mode: Extract<PhotoTileMode, { kind: "persisted" }>;
  onOpenMenu: () => void;
  /**
   * When provided, renders a drag handle at `top-2 start-2` and lets
   * the parent section wire the dnd-kit sortable activator to it.
   * Cover/kebab/alt-missing affordances move to other corners to keep
   * touch targets non-overlapping. Omit on tiles that should not be
   * draggable (e.g., when only one photo exists).
   */
  sortableHandle?: SortableHandleProps;
}

interface UploadingProps extends CommonProps {
  mode: Extract<PhotoTileMode, { kind: "uploading" }>;
  onOpenMenu?: never;
}

interface FailedProps extends CommonProps {
  mode: Extract<PhotoTileMode, { kind: "failed" }>;
  onOpenMenu?: never;
  onRetry: () => void;
}

type Props = PersistedProps | UploadingProps | FailedProps;

const TILE_PIXEL_SIZE = 320;

export function PhotoTile(props: Props): JSX.Element {
  const t = useTranslations("admin.products.edit.images");
  const { mode, altText, isCover, blobPreviewUrl, hydrated } = props;

  const altTextLocalized = pickAlt(altText);
  const altMissing = !altTextLocalized;

  const isUploading = mode.kind === "uploading";
  const isFailed = mode.kind === "failed";

  const dataAttrs: Record<string, string> = {};
  if (mode.kind === "persisted") {
    dataAttrs["data-image-id"] = mode.imageId;
    dataAttrs["data-position"] = String(mode.position);
  } else {
    dataAttrs["data-client-id"] = mode.clientId;
  }
  if (isUploading) dataAttrs["data-uploading"] = "true";
  if (isFailed) dataAttrs["data-failed"] = "true";

  return (
    <div
      data-testid="product-photo-tile"
      {...dataAttrs}
      className={[
        "relative aspect-square overflow-hidden rounded-md bg-neutral-100",
        "dark:bg-neutral-900",
        isFailed
          ? "border-2 border-red-500"
          : "border border-neutral-200 dark:border-neutral-800",
      ].join(" ")}
    >
      {mode.kind === "persisted" ? (
        <PersistedThumbnail
          imageId={mode.imageId}
          version={mode.version}
          derivatives={mode.derivatives}
          alt={altTextLocalized ?? ""}
        />
      ) : null}

      {(isUploading || isFailed) && blobPreviewUrl ? (
        // Decorative blob preview while the upload is in flight or has
        // just failed. The real alt-text is set after the upload settles
        // through the alt-text sheet, so empty alt is correct here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={blobPreviewUrl}
          alt=""
          width={TILE_PIXEL_SIZE}
          height={TILE_PIXEL_SIZE}
          className="absolute inset-0 h-full w-full object-cover opacity-90"
        />
      ) : null}

      {/* Drag handle. top-2 start-2. Persisted tiles only, and only when
          the parent section enables reorder by passing `sortableHandle`. */}
      {mode.kind === "persisted" && (props as PersistedProps).sortableHandle ? (
        <DragHandleButton
          handle={(props as PersistedProps).sortableHandle!}
          ariaLabel={t("reorderHandleAriaLabel")}
          disabled={!hydrated}
        />
      ) : null}

      {/* Cover badge moved to top-2 end-2 to free top-2 start-2 for the
          drag handle. Tiles without a sortable handle still get the
          badge in this position — consistent layout regardless of
          reorder availability. */}
      {isCover && mode.kind === "persisted" ? (
        <span
          data-testid="product-photo-cover-badge"
          className="absolute top-2 end-2 rounded-full bg-neutral-900/90 px-2 py-0.5 text-xs font-medium text-white shadow dark:bg-white/90 dark:text-neutral-900"
        >
          {t("tile.coverBadge")}
        </span>
      ) : null}

      {/* Alt-missing chip moved to bottom-2 start-2. Cover badge (top-2
          end-2) and kebab (bottom-2 end-2) cannot collide because they
          live on opposite vertical edges; the alt-missing chip occupies
          the remaining free corner. */}
      {altMissing && mode.kind === "persisted" ? (
        <span
          data-testid="product-photo-alt-missing"
          aria-hidden="true"
          className="absolute bottom-2 start-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 shadow-sm dark:bg-amber-900/80 dark:text-amber-100"
          title={t("tile.altMissing")}
        >
          {t("tile.altMissing")}
        </span>
      ) : null}

      {isUploading ? (
        <UploadingOverlay percent={mode.percent} />
      ) : null}

      {isFailed ? (
        <FailedOverlay onRetry={(props as FailedProps).onRetry} />
      ) : null}

      {mode.kind === "persisted" ? (
        <button
          type="button"
          data-testid="product-photo-tile-kebab"
          aria-label={t("tile.actionsAriaLabel")}
          aria-haspopup="menu"
          disabled={!hydrated}
          onClick={() => (props as PersistedProps).onOpenMenu()}
          className={[
            "absolute bottom-2 end-2 flex h-11 w-11 items-center justify-center",
            "rounded-full bg-white/95 text-neutral-900 shadow",
            "hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900",
            "dark:bg-neutral-800/95 dark:text-white dark:hover:bg-neutral-800",
            "disabled:opacity-60",
          ].join(" ")}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      ) : null}
    </div>
  );
}

function PersistedThumbnail({
  imageId,
  version,
  derivatives,
  alt,
}: {
  imageId: string;
  version: number;
  derivatives: ReadonlyArray<ImageDerivative>;
  alt: string;
}): JSX.Element {
  // The byte-read GET route at /api/admin/images/[imageId]/[size]/[format]
  // serves derivatives. The version in the query string is belt-and-braces
  // — the underlying storage key already includes the version, so the
  // browser cache cannot serve stale bytes after a replace.
  const src = `/api/admin/images/${encodeURIComponent(imageId)}/thumb/avif?v=${version}`;
  // Prefer the canonical thumb dimensions if the derivative ledger has
  // them; fall back to a square reservation otherwise. The aspect-square
  // wrapper above already prevents layout shift; this just informs the
  // browser of the bitmap's real intrinsic size for layout.
  const thumb = derivatives.find(
    (d) => d.size === "thumb" && d.format === "avif",
  );
  const width = thumb?.width ?? TILE_PIXEL_SIZE;
  const height = thumb?.height ?? TILE_PIXEL_SIZE;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

function UploadingOverlay({ percent }: { percent: number }): JSX.Element {
  const t = useTranslations("admin.products.edit.images");
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const fillStyle: CSSProperties = { width: `${clamped}%` };
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 text-white"
    >
      <p className="text-xs font-medium">{t("tile.uploadingLabel")}</p>
      <div
        aria-label={t("tile.uploadingProgress", { percent: clamped })}
        className="h-1.5 w-3/4 overflow-hidden rounded-full bg-white/30"
      >
        <div
          className="h-full bg-white transition-[width] duration-150"
          style={fillStyle}
        />
      </div>
      <p className="text-xs tabular-nums">{`${clamped}%`}</p>
    </div>
  );
}

function FailedOverlay({ onRetry }: { onRetry: () => void }): JSX.Element {
  const t = useTranslations("admin.products.edit.images");
  return (
    <button
      type="button"
      onClick={onRetry}
      data-testid="product-photo-failed-retry"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-900/55 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <span className="text-xs font-medium">{t("tile.failedRetry")}</span>
    </button>
  );
}

function DragHandleButton({
  handle,
  ariaLabel,
  disabled,
}: {
  handle: SortableHandleProps;
  ariaLabel: string;
  disabled: boolean;
}): JSX.Element {
  // The handle scopes the activation to ONLY this button, not the
  // whole tile, so tap-to-action (kebab) and tap-to-focus stay
  // unaffected. setActivatorNodeRef is the dnd-kit hook that wires
  // this button as the pickup target.
  return (
    <button
      type="button"
      ref={handle.setActivatorNodeRef}
      data-testid="product-photo-drag-handle"
      aria-label={ariaLabel}
      disabled={disabled}
      {...handle.attributes}
      {...handle.listeners}
      className={[
        "absolute top-2 start-2 flex h-11 w-11 items-center justify-center",
        "rounded-full bg-white/95 text-neutral-900 shadow",
        "hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900",
        "dark:bg-neutral-800/95 dark:text-white dark:hover:bg-neutral-800",
        "disabled:opacity-60",
        // Hint to the browser that this is a draggable surface — disables
        // text selection on long-press, which the dnd-kit PointerSensor
        // also wants out of the way.
        "touch-none select-none",
      ].join(" ")}
    >
      <DragHandleIcon />
    </button>
  );
}

function DragHandleIcon(): JSX.Element {
  // Six-dot grip glyph. SVG so it scales cleanly with the tile and
  // respects currentColor for dark mode.
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="currentColor"
    >
      <circle cx="5" cy="3.5" r="1.25" />
      <circle cx="11" cy="3.5" r="1.25" />
      <circle cx="5" cy="8" r="1.25" />
      <circle cx="11" cy="8" r="1.25" />
      <circle cx="5" cy="12.5" r="1.25" />
      <circle cx="11" cy="12.5" r="1.25" />
    </svg>
  );
}

function pickAlt(altText: { en?: string; ar?: string } | null): string | null {
  if (!altText) return null;
  // Prefer English then Arabic; the storefront-side preference will be
  // locale-aware when public bytes ship in 1a.7.x. For the admin tile
  // we just need any non-empty alt for the "missing" indicator and to
  // give the thumbnail a meaningful accessible name.
  const en = altText.en?.trim();
  if (en) return en;
  const ar = altText.ar?.trim();
  if (ar) return ar;
  return null;
}

