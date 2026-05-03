/**
 * `<PhotosSection>` — admin photos library on the product edit page.
 *
 * OCC token threading: until `images.list` starts returning
 * `productUpdatedAt`, this section keeps a local ref seeded from the
 * parent product's `expectedUpdatedAt` and advances it after each
 * successful upload. For metadata-only mutations (set-cover, set-alt,
 * delete) the procedures don't return a fresh token, so after each one
 * we refetch the list and the next mutation reads off the updated cache.
 *
 * Blob URLs are revoked on unmount and on settle to prevent leaks.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type JSX,
} from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type Announcements,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { trpc } from "@/lib/trpc/client";
import {
  uploadProductImage,
  replaceProductImage,
} from "@/lib/images/upload-client";
import { validateClientUpload } from "@/lib/images/validate-client-upload";
import { PhotoTile, type SortableHandleProps } from "./photo-tile";
import { PhotoActionsMenu } from "./photo-actions-menu";
import { PhotoAltTextSheet } from "./photo-alt-text-sheet";
import type { ListProductImagesResult } from "@/server/services/images/list-product-images";

type ListImage = ListProductImagesResult["images"][number];

interface InFlightTile {
  clientId: string;
  file: File;
  blobUrl: string;
  percent: number;
  status: "uploading" | "failed";
}

interface Props {
  productId: string;
  initialImages: ListProductImagesResult;
  /** Seed for the local OCC token ref. Sourced from product.updatedAt in the RSC. */
  initialProductUpdatedAt: string;
  /**
   * Lifts the freshest known `productUpdatedAt` back to the parent form
   * after every successful photo mutation. Without this, the form's
   * own `liveExpectedUpdatedAt` (which seeds the four-leg save chain)
   * stays at the mount-time value and a subsequent Save shows a
   * stale-write banner even though the photo mutation legitimately
   * advanced the parent product's updated_at.
   */
  onProductUpdatedAtChange?: (next: string) => void;
}

export function PhotosSection({
  productId,
  initialImages,
  initialProductUpdatedAt,
  onProductUpdatedAtChange,
}: Props): JSX.Element {
  const t = useTranslations("admin.products.edit.images");
  const trpcUtils = trpc.useUtils();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const listQuery = trpc.images.list.useQuery(
    { productId },
    { initialData: initialImages },
  );
  const listData = listQuery.data ?? initialImages;
  const persistedImages = listData.images;

  // ----- in-flight upload state ---------------------------------------------
  const [inFlight, setInFlight] = useState<InFlightTile[]>([]);
  const inFlightRef = useRef<InFlightTile[]>([]);
  inFlightRef.current = inFlight;

  // Always revoke blob URLs we've created — once on unmount, and per-tile
  // when it leaves the in-flight set (handled in the settle paths below).
  useEffect(() => {
    return () => {
      for (const tile of inFlightRef.current) {
        URL.revokeObjectURL(tile.blobUrl);
      }
    };
  }, []);

  // ----- viewport flag for menu variant -------------------------------------
  const [isWideViewport, setIsWideViewport] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 640px)");
    const update = (): void => setIsWideViewport(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // ----- per-tile menu / sheet / dialog state -------------------------------
  const [menuOpenForId, setMenuOpenForId] = useState<string | null>(null);
  const [altSheetForId, setAltSheetForId] = useState<string | null>(null);
  const [removeForId, setRemoveForId] = useState<string | null>(null);
  const [replaceForId, setReplaceForId] = useState<string | null>(null);

  // ----- shared error / flash state -----------------------------------------
  const [validationError, setValidationError] = useState<{
    target: string; // image id, in-flight client id, or "pending"
    code: string;
  } | null>(null);
  const [uploadError, setUploadError] = useState<{
    target: string;
    code: string;
  } | null>(null);
  const [staleWriteFlash, setStaleWriteFlash] = useState(false);

  // Refs for hidden file inputs.
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  // ----- mutations -----------------------------------------------------------
  const setCoverMutation = trpc.images.setProductCover.useMutation();
  const setAltMutation = trpc.images.setAltText.useMutation();
  const deleteMutation = trpc.images.delete.useMutation();
  const reorderMutation = trpc.images.reorder.useMutation();

  // ----- reorder state ------------------------------------------------------
  // Optimistic ordering applied on drag end. While set, the grid renders
  // in this order; cleared once the server confirms (via refreshList,
  // whose new cache will already match) or on rollback.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>("");

  const refreshList = useCallback(async (): Promise<void> => {
    await trpcUtils.images.list.invalidate({ productId });
    // Lift the freshest productUpdatedAt back to the parent form so the
    // four-leg save chain's OCC token stays in sync with photo mutations.
    if (onProductUpdatedAtChange) {
      const fresh = trpcUtils.images.list.getData({ productId })?.productUpdatedAt;
      if (fresh) onProductUpdatedAtChange(fresh);
    }
  }, [trpcUtils, productId, onProductUpdatedAtChange]);

  /**
   * Live OCC token. Reads `productUpdatedAt` straight off the React
   * Query cache; falls back to the SSR seed before the first hydration.
   * Each `await refreshList()` repopulates the cache so the next call
   * to `occToken()` sees the freshest server value.
   */
  const occToken = useCallback((): string => {
    const live = trpcUtils.images.list.getData({ productId })?.productUpdatedAt;
    return live ?? initialProductUpdatedAt;
  }, [trpcUtils.images.list, productId, initialProductUpdatedAt]);

  /**
   * Translate the wire `staleWrite` outcome into UI state. Wire codes
   * are snake_case (`stale_write`); we accept either spelling so the
   * branch fires whether tdd ships the canonical or the legacy form.
   */
  // ----- drag-to-upload state -----------------------------------------------
  // Drop a file from the OS file manager onto the section to trigger the
  // existing upload flow. The dragenter/dragleave events bubble through
  // child elements, so we use a counter pattern: increment on enter,
  // decrement on leave, hide the overlay only when the counter is zero.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Window-level guard: a file dropped anywhere outside our drop zone
  // would otherwise navigate the browser to its URL, unloading the page
  // and any in-flight uploads. preventDefault on the page-level
  // dragover + drop neutralizes that default behavior; our own zone's
  // listeners still fire normally because they don't propagate up.
  useEffect(() => {
    function preventGlobalDrop(e: DragEvent): void {
      e.preventDefault();
    }
    window.addEventListener("dragover", preventGlobalDrop);
    window.addEventListener("drop", preventGlobalDrop);
    return () => {
      window.removeEventListener("dragover", preventGlobalDrop);
      window.removeEventListener("drop", preventGlobalDrop);
    };
  }, []);

  // ----- multi-upload --------------------------------------------------------
  const onAddPhotosClick = useCallback((): void => {
    addInputRef.current?.click();
  }, []);

  const onPickFiles = useCallback(
    async (
      fileList: FileList | ReadonlyArray<File> | null,
    ): Promise<void> => {
      if (!fileList || fileList.length === 0) return;
      setValidationError(null);
      setUploadError(null);
      const picked = Array.from(fileList);
      const accepted: InFlightTile[] = [];
      for (const file of picked) {
        const check = validateClientUpload(file);
        if (!check.ok) {
          // Stop on the first invalid file. The owner can re-pick after
          // fixing — surfacing per-file pile of errors is noisy at 360px.
          setValidationError({ target: "pending", code: check.code });
          break;
        }
        accepted.push({
          clientId: crypto.randomUUID(),
          file,
          blobUrl: URL.createObjectURL(file),
          percent: 0,
          status: "uploading",
        });
      }
      if (accepted.length === 0) return;
      setInFlight((prev) => [...prev, ...accepted]);

      // Serial upload — between each one we advance the local OCC token
      // from the returned image row's parent updatedAt and refresh the
      // ledger so the grid reflects the new tile. This keeps the
      // per-product OCC chain coherent without parallel writes racing
      // on the same row.
      for (const tile of accepted) {
        const result = await uploadProductImage(
          tile.file,
          { productId, expectedUpdatedAt: occToken() },
          {
            onProgress: (percent: number) => {
              setInFlight((prev) =>
                prev.map((row) =>
                  row.clientId === tile.clientId ? { ...row, percent } : row,
                ),
              );
            },
          },
        );
        if (result.ok) {
          URL.revokeObjectURL(tile.blobUrl);
          setInFlight((prev) =>
            prev.filter((row) => row.clientId !== tile.clientId),
          );
          // refreshList re-reads the list — the next iteration's
          // occToken() picks the fresh productUpdatedAt off the cache.
          await refreshList();
        } else {
          if (isStaleWriteCode(result.code)) {
            setStaleWriteFlash(true);
            await refreshList();
          }
          setUploadError({ target: tile.clientId, code: result.code });
          setInFlight((prev) =>
            prev.map((row) =>
              row.clientId === tile.clientId
                ? { ...row, status: "failed" }
                : row,
            ),
          );
        }
      }

      // Reset the input so the same file can be re-picked.
      if (addInputRef.current) addInputRef.current.value = "";
    },
    [productId, occToken, refreshList],
  );

  // ----- drag-to-upload handlers --------------------------------------------
  const onDropEnter = useCallback((e: React.DragEvent<HTMLElement>): void => {
    e.preventDefault();
    if (!hasFilesInDataTransfer(e.dataTransfer)) return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const onDropLeave = useCallback((e: React.DragEvent<HTMLElement>): void => {
    e.preventDefault();
    if (dragCounterRef.current > 0) dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const onDropOver = useCallback((e: React.DragEvent<HTMLElement>): void => {
    // preventDefault here is mandatory — without it, drop never fires
    // on this element.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDropFiles = useCallback(
    (e: React.DragEvent<HTMLElement>): void => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      // Iterate `items` and accept only `kind === "file"` entries. OS
      // drops can carry mixed payloads (URL strings, plain text, OS
      // path strings); filtering at this boundary prevents non-file
      // items from ever reaching the upload flow.
      const files: File[] = [];
      const items = e.dataTransfer.items;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item && item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return;
      void onPickFiles(files);
    },
    [onPickFiles],
  );

  const onRetryInFlight = useCallback(
    async (clientId: string): Promise<void> => {
      const tile = inFlightRef.current.find((r) => r.clientId === clientId);
      if (!tile) return;
      setUploadError((cur) =>
        cur && cur.target === clientId ? null : cur,
      );
      setInFlight((prev) =>
        prev.map((row) =>
          row.clientId === clientId
            ? { ...row, status: "uploading", percent: 0 }
            : row,
        ),
      );
      const result = await uploadProductImage(
        tile.file,
        { productId, expectedUpdatedAt: occToken() },
        {
          onProgress: (percent: number) => {
            setInFlight((prev) =>
              prev.map((row) =>
                row.clientId === clientId ? { ...row, percent } : row,
              ),
            );
          },
        },
      );
      if (result.ok) {
        URL.revokeObjectURL(tile.blobUrl);
        setInFlight((prev) => prev.filter((row) => row.clientId !== clientId));
        await refreshList();
      } else {
        if (isStaleWriteCode(result.code)) {
          setStaleWriteFlash(true);
          await refreshList();
        }
        setUploadError({ target: clientId, code: result.code });
        setInFlight((prev) =>
          prev.map((row) =>
            row.clientId === clientId ? { ...row, status: "failed" } : row,
          ),
        );
      }
    },
    [productId, occToken, refreshList],
  );

  // ----- replace -------------------------------------------------------------
  const onReplaceClick = useCallback((imageId: string): void => {
    setReplaceForId(imageId);
    // Defer to the next paint so the input ref is mounted (it is — but
    // safer to queue the .click() to the next microtask in case React
    // batches the state update).
    queueMicrotask(() => replaceInputRef.current?.click());
  }, []);

  const onReplacePicked = useCallback(
    async (file: File | undefined, imageId: string): Promise<void> => {
      if (!file) return;
      setValidationError(null);
      setUploadError(null);
      const check = validateClientUpload(file);
      if (!check.ok) {
        setValidationError({ target: imageId, code: check.code });
        if (replaceInputRef.current) replaceInputRef.current.value = "";
        return;
      }
      const result = await replaceProductImage(
        file,
        { imageId, expectedUpdatedAt: occToken() },
        { onProgress: () => {} },
      );
      if (result.ok) {
        await refreshList();
      } else {
        if (isStaleWriteCode(result.code)) {
          setStaleWriteFlash(true);
          await refreshList();
        }
        setUploadError({ target: imageId, code: result.code });
      }
      if (replaceInputRef.current) replaceInputRef.current.value = "";
    },
    [occToken, refreshList],
  );

  // ----- set cover ----------------------------------------------------------
  const onSetCover = useCallback(
    async (imageId: string): Promise<void> => {
      setUploadError(null);
      try {
        await setCoverMutation.mutateAsync({
          imageId,
          expectedUpdatedAt: occToken(),
        });
        await refreshList();
      } catch (err) {
        const code = trpcErrorCode(err);
        if (isStaleWriteCode(code)) {
          setStaleWriteFlash(true);
          await refreshList();
        }
        setUploadError({ target: imageId, code });
      }
    },
    [occToken, refreshList, setCoverMutation],
  );

  // ----- alt text -----------------------------------------------------------
  const onSaveAltText = useCallback(
    async (imageId: string, next: { en: string; ar: string }): Promise<void> => {
      setUploadError(null);
      try {
        await setAltMutation.mutateAsync({
          imageId,
          altText: next,
          expectedUpdatedAt: occToken(),
        });
        await refreshList();
        setAltSheetForId(null);
      } catch (err) {
        const code = trpcErrorCode(err);
        if (isStaleWriteCode(code)) {
          setStaleWriteFlash(true);
          await refreshList();
        }
        setUploadError({ target: imageId, code });
      }
    },
    [occToken, refreshList, setAltMutation],
  );

  // ----- remove -------------------------------------------------------------
  const onConfirmRemove = useCallback(
    async (imageId: string): Promise<void> => {
      setUploadError(null);
      try {
        await deleteMutation.mutateAsync({
          imageId,
          expectedUpdatedAt: occToken(),
          confirm: true,
        });
        await refreshList();
        setRemoveForId(null);
      } catch (err) {
        const code = trpcErrorCode(err);
        if (isStaleWriteCode(code)) {
          setStaleWriteFlash(true);
          await refreshList();
        }
        setUploadError({ target: imageId, code });
      }
    },
    [occToken, refreshList, deleteMutation],
  );

  // ----- derived state ------------------------------------------------------
  // Display order: server order, optionally overridden by an in-flight
  // optimistic reorder. Once the server confirms (or rejects), we clear
  // optimisticOrder; the cache will already reflect the new server
  // order, so the next render uses the fresh persistedImages directly.
  const orderedImages = useMemo<ListImage[]>(() => {
    if (!optimisticOrder) return persistedImages;
    const byId = new Map(persistedImages.map((img) => [img.id, img]));
    const out: ListImage[] = [];
    for (const id of optimisticOrder) {
      const img = byId.get(id);
      if (img) out.push(img);
    }
    // Defensive: if the optimistic list went stale (server invalidated
    // between drop and refetch), pad with any persisted images we missed.
    if (out.length !== persistedImages.length) {
      const optimisticIdSet = new Set(optimisticOrder);
      for (const img of persistedImages) {
        if (!optimisticIdSet.has(img.id)) out.push(img);
      }
    }
    return out;
  }, [persistedImages, optimisticOrder]);

  const cover = orderedImages[0];
  const coverId = cover?.id ?? null;

  const altSheetTile = useMemo(
    () => persistedImages.find((img) => img.id === altSheetForId) ?? null,
    [persistedImages, altSheetForId],
  );

  const removeTile = useMemo(
    () => persistedImages.find((img) => img.id === removeForId) ?? null,
    [persistedImages, removeForId],
  );

  const isEmpty = persistedImages.length === 0 && inFlight.length === 0;
  const reorderEnabled = orderedImages.length > 1;

  // ----- reorder handlers ---------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Distance-based activation: drag fires the moment the pointer
      // moves a few pixels off the dedicated handle button. Taps still
      // register as clicks (zero movement → no drag). A time-based
      // press-and-hold here was unreliable on the dedicated handle —
      // any finger jitter inside the delay window silently cancelled
      // the activation, which read to the operator as a dead button.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart({ active }) {
        const from = orderedImages.findIndex((img) => img.id === active.id);
        if (from < 0) return;
        return t("reorderLiveAnnouncePicked", { from: from + 1 });
      },
      onDragOver({ over }) {
        if (!over) return;
        const to = orderedImages.findIndex((img) => img.id === over.id);
        if (to < 0) return;
        return t("reorderLiveAnnounceMoved", { to: to + 1 });
      },
      onDragEnd({ over }) {
        if (!over) return t("reorderLiveAnnounceCancelled");
        const to = orderedImages.findIndex((img) => img.id === over.id);
        if (to < 0) return t("reorderLiveAnnounceCancelled");
        return t("reorderLiveAnnounceDropped", { to: to + 1 });
      },
      onDragCancel() {
        return t("reorderLiveAnnounceCancelled");
      },
    }),
    [t, orderedImages],
  );

  // dnd-kit announcements feed the section's own polite live region for
  // screen readers (in addition to dnd-kit's default off-screen one).
  const onAnnouncement = useCallback((message: string): void => {
    setLiveAnnouncement(message);
  }, []);

  const onDragStart = useCallback(
    (event: DragStartEvent): void => {
      const msg = announcements.onDragStart?.({
        active: event.active,
      } as Parameters<NonNullable<Announcements["onDragStart"]>>[0]);
      if (msg) onAnnouncement(msg);
    },
    [announcements, onAnnouncement],
  );

  const onDragEnd = useCallback(
    async (event: DragEndEvent): Promise<void> => {
      const { active, over } = event;
      const msg = announcements.onDragEnd?.({
        active,
        over,
        delta: { x: 0, y: 0 },
        collisions: null,
      } as Parameters<NonNullable<Announcements["onDragEnd"]>>[0]);
      if (msg) onAnnouncement(msg);

      if (!over || active.id === over.id) return;

      const oldIndex = orderedImages.findIndex((img) => img.id === active.id);
      const newIndex = orderedImages.findIndex((img) => img.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;

      const previous = orderedImages.map((img) => img.id);
      const next = arrayMove(previous, oldIndex, newIndex);
      setOptimisticOrder(next);
      setReorderError(null);

      try {
        await reorderMutation.mutateAsync({
          productId,
          expectedUpdatedAt: occToken(),
          orderedImageIds: next,
        });
        // Refresh the cache; orderedImages will now derive from the new
        // server order, and we drop the optimistic override.
        await refreshList();
        setOptimisticOrder(null);
      } catch (err) {
        const code = trpcErrorCode(err);
        // Roll back the optimistic order regardless of which branch fires.
        setOptimisticOrder(null);
        if (isStaleWriteCode(code)) {
          setStaleWriteFlash(true);
          await refreshList();
        } else if (code === "image_set_mismatch") {
          await refreshList();
          setReorderError(t("errors.reorderSetMismatch"));
        } else {
          setReorderError(t("errors.reorderFailed"));
        }
      }
    },
    [
      announcements,
      onAnnouncement,
      orderedImages,
      reorderMutation,
      productId,
      occToken,
      refreshList,
      t,
    ],
  );

  return (
    <section
      data-testid="product-photos-section"
      className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
    >
      {/* Drop-zone wrapper. Handlers live on this inner element so the
          section itself keeps its existing testid for the rest of the
          spec. The wrapper is `relative` so the absolute-positioned
          overlay clips to its bounds. */}
      <div
        data-testid="product-photos-drop-zone"
        onDragEnter={onDropEnter}
        onDragOver={onDropOver}
        onDragLeave={onDropLeave}
        onDrop={onDropFiles}
        className={
          isDragOver
            ? "relative rounded-md outline-dashed outline-2 outline-blue-500"
            : "relative"
        }
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("heading")}</h2>
        </div>

        {isDragOver ? (
          <div
            data-testid="product-photos-drop-overlay"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 rounded-md bg-blue-50/80 dark:bg-blue-950/80"
          >
            <p className="text-base font-semibold text-blue-900 dark:text-blue-100">
              {t("dropZoneOverlay")}
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              {t("dropZoneHelper")}
            </p>
          </div>
        ) : null}

      {staleWriteFlash ? (
        <p
          role="alert"
          data-testid="product-photos-stale-write"
          className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {t("errors.staleWrite")}
        </p>
      ) : null}

      {validationError && validationError.target === "pending" ? (
        <p
          role="alert"
          data-testid="product-photo-validation-error"
          data-image-id="pending"
          className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {tError(t, validationError.code)}
        </p>
      ) : null}

      {uploadError && uploadError.target === "pending" ? (
        <p
          role="alert"
          data-testid="product-photo-upload-error"
          data-image-id="pending"
          className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {tError(t, uploadError.code)}
        </p>
      ) : null}

      {reorderError ? (
        <p
          role="alert"
          data-testid="product-photos-reorder-error"
          className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {reorderError}
        </p>
      ) : null}

      {/* Polite live region for screen-reader announcements during
          drag-reorder. dnd-kit also creates its own off-screen one;
          ours sits inside the section so e2e can assert against a
          stable testid. */}
      <div
        data-testid="product-photos-reorder-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>

      {isEmpty ? (
        <div className="mt-3 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-6 text-center dark:border-neutral-700 dark:bg-neutral-900/40">
          <p
            data-testid="product-photos-empty"
            className="text-sm text-neutral-600 dark:text-neutral-400"
          >
            {t("emptyHeading")}
          </p>
          <button
            type="button"
            data-testid="product-photos-add"
            disabled={!hydrated}
            onClick={onAddPhotosClick}
            className="mt-3 inline-flex h-11 items-center justify-center rounded-full border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            {t("addCta")}
          </button>
        </div>
      ) : (
        <>
          <DndContext
            id="product-photos-dnd"
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={(e) => void onDragEnd(e)}
            accessibility={{ announcements }}
          >
            <SortableContext
              items={orderedImages.map((img) => img.id)}
              strategy={rectSortingStrategy}
            >
              <ul
                data-testid="product-photo-grid"
                className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
              >
                {orderedImages.map((image) => {
                  const isCover = image.id === coverId;
                  const isMenuOpen = menuOpenForId === image.id;
                  return (
                    <SortablePhotoTileWrapper
                      key={image.id}
                      image={image}
                      isCover={isCover}
                      isMenuOpen={isMenuOpen}
                      isWideViewport={isWideViewport}
                      hydrated={hydrated}
                      reorderEnabled={reorderEnabled}
                      validationError={validationError}
                      uploadError={uploadError}
                      tError={(code) => tError(t, code)}
                      onOpenMenu={() => setMenuOpenForId(image.id)}
                      onSetCover={() => onSetCover(image.id)}
                      onEditAlt={() => setAltSheetForId(image.id)}
                      onReplace={() => onReplaceClick(image.id)}
                      onRemove={() => setRemoveForId(image.id)}
                      onCloseMenu={() => setMenuOpenForId(null)}
                    />
                  );
                })}
            {inFlight.map((tile) => (
              <li key={tile.clientId} className="relative">
                {tile.status === "uploading" ? (
                  <PhotoTile
                    mode={{
                      kind: "uploading",
                      clientId: tile.clientId,
                      percent: tile.percent,
                    }}
                    altText={null}
                    isCover={false}
                    hydrated={hydrated}
                    blobPreviewUrl={tile.blobUrl}
                  />
                ) : (
                  <PhotoTile
                    mode={{ kind: "failed", clientId: tile.clientId }}
                    altText={null}
                    isCover={false}
                    hydrated={hydrated}
                    blobPreviewUrl={tile.blobUrl}
                    onRetry={() => void onRetryInFlight(tile.clientId)}
                  />
                )}
                {uploadError && uploadError.target === tile.clientId ? (
                  <p
                    role="alert"
                    data-testid="product-photo-upload-error"
                    data-image-id={tile.clientId}
                    className="mt-1 text-xs text-red-700 dark:text-red-400"
                  >
                    {tError(t, uploadError.code)}
                  </p>
                ) : null}
              </li>
            ))}
              </ul>
            </SortableContext>
          </DndContext>

          <button
            type="button"
            data-testid="product-photos-add"
            disabled={!hydrated}
            onClick={onAddPhotosClick}
            className="mt-4 inline-flex h-11 items-center justify-center rounded-full border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            {t("addCta")}
          </button>
        </>
      )}

      <input
        ref={addInputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="product-photos-file-input"
        onChange={(e) => void onPickFiles(e.target.files)}
        className="hidden"
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        data-testid="product-photo-replace-input"
        data-image-id={replaceForId ?? ""}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (replaceForId) void onReplacePicked(file, replaceForId);
        }}
        className="hidden"
      />

      <PhotoAltTextSheet
        open={altSheetTile !== null}
        initialEn={altSheetTile?.altText?.en ?? ""}
        initialAr={altSheetTile?.altText?.ar ?? ""}
        saving={setAltMutation.isPending}
        onSave={(next) => {
          if (altSheetTile) void onSaveAltText(altSheetTile.id, next);
        }}
        onCancel={() => setAltSheetForId(null)}
      />

      {removeTile ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-photo-remove-title"
          aria-describedby="product-photo-remove-body"
          data-testid="product-photo-remove-dialog"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
            <h2 id="product-photo-remove-title" className="text-base font-semibold">
              {t("removeDialog.heading")}
            </h2>
            <p
              id="product-photo-remove-body"
              className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t("removeDialog.body")}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                onClick={() => void onConfirmRemove(removeTile.id)}
                disabled={deleteMutation.isPending}
                data-testid="product-photo-remove-confirm"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {t("removeDialog.confirm")}
              </button>
              <button
                type="button"
                onClick={() => setRemoveForId(null)}
                data-testid="product-photo-remove-cancel"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {t("removeDialog.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}

/**
 * Per-tile sortable wrapper. Calls `useSortable` (which can't be invoked
 * inside a `.map(...)` from the parent component without breaking the
 * Rules of Hooks), wires the transform/transition style on the `<li>`,
 * passes the activator props down to `<PhotoTile>` for the drag handle,
 * and surrounds with the standard tile chrome (validation/upload error,
 * actions menu).
 *
 * Reduced motion: dnd-kit's `transition` string already short-circuits
 * to `null` when the OS prefers reduced motion via the underlying
 * `useReducedMotion` hook from `@dnd-kit/utilities`. Explicitly setting
 * `transition: undefined` on the style object lets the browser fall
 * back to no transition. We additionally suppress the scale/shadow
 * pop when the user prefers reduced motion.
 */
function SortablePhotoTileWrapper({
  image,
  isCover,
  isMenuOpen,
  isWideViewport,
  hydrated,
  reorderEnabled,
  validationError,
  uploadError,
  tError,
  onOpenMenu,
  onSetCover,
  onEditAlt,
  onReplace,
  onRemove,
  onCloseMenu,
}: {
  image: ListImage;
  isCover: boolean;
  isMenuOpen: boolean;
  isWideViewport: boolean;
  hydrated: boolean;
  reorderEnabled: boolean;
  validationError: { target: string; code: string } | null;
  uploadError: { target: string; code: string } | null;
  tError: (code: string) => string;
  onOpenMenu: () => void;
  onSetCover: () => void;
  onEditAlt: () => void;
  onReplace: () => void;
  onRemove: () => void;
  onCloseMenu: () => void;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id });

  const reduceMotion = usePrefersReducedMotion();

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: reduceMotion ? "none" : transition,
    // Lift the dragging tile above siblings without disturbing layout.
    zIndex: isDragging ? 10 : undefined,
  };

  const sortableHandle: SortableHandleProps | undefined = reorderEnabled
    ? {
        attributes: attributes as HTMLAttributes<HTMLButtonElement>,
        listeners: listeners as HTMLAttributes<HTMLButtonElement> | undefined,
        setActivatorNodeRef,
        isDragging,
      }
    : undefined;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={[
        "relative",
        // Lift effect when actively dragging — kept off when reduced
        // motion is preferred so the tile pops less aggressively.
        isDragging && !reduceMotion ? "scale-105 shadow-xl" : "",
      ].join(" ")}
    >
      <PhotoTile
        mode={{
          kind: "persisted",
          imageId: image.id,
          version: image.version,
          position: image.position,
          derivatives: image.derivatives,
        }}
        altText={image.altText}
        isCover={isCover}
        hydrated={hydrated}
        onOpenMenu={onOpenMenu}
        {...(sortableHandle ? { sortableHandle } : {})}
      />
      {validationError && validationError.target === image.id ? (
        <p
          role="alert"
          data-testid="product-photo-validation-error"
          data-image-id={image.id}
          className="mt-1 text-xs text-red-700 dark:text-red-400"
        >
          {tError(validationError.code)}
        </p>
      ) : null}
      {uploadError && uploadError.target === image.id ? (
        <p
          role="alert"
          data-testid="product-photo-upload-error"
          data-image-id={image.id}
          className="mt-1 text-xs text-red-700 dark:text-red-400"
        >
          {tError(uploadError.code)}
        </p>
      ) : null}
      <PhotoActionsMenu
        open={isMenuOpen}
        variant={isWideViewport ? "popover" : "sheet"}
        isCover={isCover}
        onSetCover={onSetCover}
        onEditAlt={onEditAlt}
        onReplace={onReplace}
        onRemove={onRemove}
        onClose={onCloseMenu}
      />
    </li>
  );
}

/**
 * Lightweight reduced-motion detector. Avoids pulling in a dedicated
 * hook library for a one-line media-query subscription.
 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduce(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return reduce;
}

/**
 * Map a server wire code or a client validation code to the matching
 * camelCase i18n key under `admin.products.edit.images.errors.*`.
 *
 * Wire codes are snake_case (`stale_write`, `image_too_large`); client
 * validation codes are also snake_case (`too_large`,
 * `unsupported_format`). The i18n catalog uses camelCase short names so
 * this lookup is the only place the two namespaces meet. Unknown codes
 * collapse to the generic "unknown" key — never echo a raw token to
 * the operator.
 */
const WIRE_CODE_TO_I18N_KEY: Record<string, string> = {
  // Client-side validation codes
  too_large: "tooLarge",
  too_small: "tooSmall",
  unsupported_format: "unsupportedFormat",
  // Server wire codes
  image_too_small: "tooSmall",
  image_too_large: "tooLarge",
  image_unsupported_format: "unsupportedFormat",
  image_dimensions_exceeded: "dimensionsExceeded",
  image_count_exceeded: "countExceeded",
  image_corrupt: "corrupt",
  image_duplicate_in_product: "duplicate",
  image_storage_failed: "storageFailed",
  product_not_found: "unknown",
  image_not_found: "unknown",
  stale_write: "staleWrite",
  validation_failed: "unknown",
  forbidden: "unknown",
  // Already-camelCase aliases (defensive — let either spelling land)
  staleWrite: "staleWrite",
  tooLarge: "tooLarge",
  tooSmall: "tooSmall",
  unsupportedFormat: "unsupportedFormat",
  dimensionsExceeded: "dimensionsExceeded",
  corrupt: "corrupt",
  duplicate: "duplicate",
  countExceeded: "countExceeded",
  storageFailed: "storageFailed",
  unknown: "unknown",
};

function tError(
  t: ReturnType<typeof useTranslations<"admin.products.edit.images">>,
  code: string,
): string {
  const key = WIRE_CODE_TO_I18N_KEY[code] ?? "unknown";
  return t(`errors.${key}` as Parameters<typeof t>[0]);
}

/**
 * Pull the discriminator out of a thrown tRPC mutation error. tRPC
 * surfaces `stale_write` as the closed-set `message` string (see
 * `src/server/trpc/routers/images.ts:105`). On anything else we
 * collapse to "unknown" so the operator gets a polite generic
 * message rather than a raw stack token.
 */
function trpcErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const maybeMsg = (err as { message?: unknown }).message;
    if (typeof maybeMsg === "string" && maybeMsg.length > 0) return maybeMsg;
  }
  return "unknown";
}

// Returns true if the DataTransfer carries at least one file. OS drags
// can carry mixed payloads (URL strings, plain text alongside a file);
// checking `kind === "file"` prevents non-file items reaching the upload
// flow. During dragenter the browser always exposes `kind` even when it
// withholds the file metadata for privacy.
function isStaleWriteCode(code: string): boolean {
  return code === "stale_write" || code === "staleWrite";
}

function hasFilesInDataTransfer(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (let i = 0; i < dt.items.length; i += 1) {
    if (dt.items[i]?.kind === "file") return true;
  }
  return false;
}
