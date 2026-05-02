/**
 * Admin: edit-product form.
 *
 * Copy-and-adapt of `create-product-form.tsx`. 1a.5 (variants) and 1a.7
 * (image pipeline) will both modify this form; we'll consolidate with
 * the create form into a shared component once those divergence axes
 * are visible (per consolidated brief Conflict 1).
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { trpc } from "@/lib/trpc/client";
import {
  SLUG_MAX,
  validateSlug,
  type SlugValidationError,
} from "@/lib/product-slug";
import type { CategoryOption } from "@/lib/categories/build-category-options";
import { CategoryPickerSheet } from "@/components/admin/category-picker-sheet";
import {
  buildVariantRows,
  type EditorOption,
  type EditorVariant,
  type VariantRow,
} from "@/lib/variants/build-variant-rows";
import { TransitionNotice } from "@/components/admin/transition-notice";
import { OptionsPanel } from "./options-panel";
import { VariantsList, type RowErrors } from "./variants-list";
import { BulkApplySheet, type BulkApplyPatch } from "./bulk-apply-sheet";

const MAX_VARIANTS_PER_PRODUCT = 100;

interface InitialValues {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  status: "draft" | "active";
  expectedUpdatedAt: string;
  costPriceMinor?: number | null;
}

interface Props {
  locale: Locale;
  initial: InitialValues;
  categoryOptions: ReadonlyArray<CategoryOption>;
  initialCategoryIds: ReadonlyArray<string>;
  initialOptions: ReadonlyArray<EditorOption>;
  initialVariants: ReadonlyArray<EditorVariant>;
}

/** Mint a runtime client id for a fresh option/value (server replaces on save). */
function clientId(): string {
  return crypto.randomUUID();
}

type FieldErrors = Record<string, string[] | undefined>;

export function EditProductForm({
  locale,
  initial,
  categoryOptions,
  initialCategoryIds,
  initialOptions,
  initialVariants,
}: Props) {
  const t = useTranslations("admin.products.edit");
  const tc = useTranslations("admin.products.create");
  const tcat = useTranslations("admin.products.edit.categories");
  const router = useRouter();
  const trpcUtils = trpc.useUtils();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const [slug, setSlug] = useState(initial.slug);
  const [slugError, setSlugError] = useState<SlugValidationError | null>(null);
  const [nameEn, setNameEn] = useState(initial.nameEn);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [descriptionEn, setDescriptionEn] = useState(initial.descriptionEn);
  const [descriptionAr, setDescriptionAr] = useState(initial.descriptionAr);
  const [status, setStatus] = useState<"draft" | "active">(initial.status);
  // costPriceMinor is owner-only — the form receives it iff the
  // role-gated DTO exposed it (RSC page passes it through). For staff
  // the prop is undefined and we never render the field.
  const initialHasCostPrice = "costPriceMinor" in initial;
  const initialCostPriceText =
    initialHasCostPrice && initial.costPriceMinor != null
      ? (initial.costPriceMinor / 100).toFixed(2)
      : "";
  const [costPriceText, setCostPriceText] = useState<string>(initialCostPriceText);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [staleWriteFlash, setStaleWriteFlash] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  // Categories state — initial set comes from listForProduct.
  // selectedCategoryIds is the live set the user has chosen; baseline
  // mirrors initialCategoryIds and gets refreshed after a stale-category
  // recovery so the dirty memo is consistent.
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(
    () => [...initialCategoryIds],
  );
  const [baselineCategoryIds, setBaselineCategoryIds] = useState<string[]>(
    () => [...initialCategoryIds],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [staleCategoriesFlash, setStaleCategoriesFlash] = useState(false);
  // Track the live OCC token. The first mutation (products.update)
  // bumps updated_at and returns a fresh value; the second mutation
  // (products.setCategories) needs that fresh token to pass OCC.
  const [liveExpectedUpdatedAt, setLiveExpectedUpdatedAt] = useState<string>(
    initial.expectedUpdatedAt,
  );

  // Options + variants (chunk 1a.5.2). Persisted ids are tracked so
  // 1a.5.1's `setProductOptions` rejection of REMOVE-via-set-replace
  // doesn't accidentally fire — the Remove affordance is disabled in
  // 1a.5.2 (1a.5.3 wires the cascade), but we keep the persisted-id set
  // ready for future use.
  const persistedOptionIds = useMemo(
    () => new Set<string>(initialOptions.map((o) => o.id)),
    [initialOptions],
  );
  const initialOptionsKey = useMemo(
    () => snapshotOptions(initialOptions),
    [initialOptions],
  );
  const initialVariantsKey = useMemo(
    () => snapshotVariants(initialVariants),
    [initialVariants],
  );
  const [optionsState, setOptionsState] = useState<EditorOption[]>(() =>
    initialOptions.map((o) => ({
      id: o.id,
      name: { en: o.name.en, ar: o.name.ar },
      position: o.position,
      values: o.values.map((v) => ({
        id: v.id,
        value: { en: v.value.en, ar: v.value.ar },
        position: v.position,
      })),
    })),
  );
  const [variantState, setVariantState] = useState<Map<string, VariantRow>>(
    () => {
      // Hydrate the per-key edit state from the cartesian generator,
      // pre-filled by `buildVariantRows` from the server's variant rows.
      const rows = buildVariantRows(initialOptions, initialVariants);
      return new Map(rows.map((r) => [r.key, r]));
    },
  );
  const [variantRowErrors, setVariantRowErrors] = useState<
    Record<string, RowErrors | undefined>
  >({});
  const [variantsTopError, setVariantsTopError] = useState<string | null>(null);

  // 1a.5.3 — bulk-select / per-row remove / State-C transition.
  // `selectMode` toggles the leading checkbox column on each row.
  // `selectedKeys` is the set of variant rows the bulk-apply sheet
  // will patch. `removedKeys` carries the variant keys the operator
  // removed via the per-row kebab; on Save these rows are omitted from
  // the setVariants payload, triggering the existing
  // hard-delete-on-diff-removal contract. `removedRowIds` carries the
  // persisted ids alongside (purely for forensic clarity in the dirty
  // memo). `transitionNotice` surfaces a dismissible banner when the
  // form's variant shape collapses or expands; `useFlatFormSeed` flips
  // the cartesian generator into preserve-first-touched mode for the
  // expand transition. `cascadeOptionId` is the option pending in the
  // confirm dialog (null when no dialog is open).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(() => new Set());
  const [transitionNotice, setTransitionNotice] = useState<
    "collapse" | "expand" | null
  >(null);
  const [useFlatFormSeed, setUseFlatFormSeed] = useState(false);
  // Stable ref so `optionsHandlers` (memoized once) can read the latest
  // options length when deciding whether the State-C expand banner
  // should fire — without invalidating the handler identity each render.
  const optionsStateRef = useRef<EditorOption[]>([]);
  optionsStateRef.current = optionsState;
  // Stashes variant keys dropped by the cascade prune so the row-
  // error sibling call inside the same flushSync batch can clear
  // their errors (we can't chain a setter from inside another
  // setter's updater).
  const cascadeDroppedKeysRef = useRef<Set<string>>(new Set());

  // Materialise the rows the variants list renders by combining the
  // current options state with the per-key edit map. This is the same
  // function tested in `tests/unit/lib/variants/build-variant-rows.test.ts`,
  // so any divergence between the form and the back-office shape is
  // caught at unit-test level.
  //
  // 1a.5.3 — when the operator was on flat-form and just added their
  // first option type (`useFlatFormSeed`), pass the preserve-first-
  // touched policy so the flat-form's typed SKU/price/stock carries
  // into the first generated row instead of being discarded. We also
  // filter `removedKeys` out before render so per-row removals take
  // effect immediately.
  const variantRows: VariantRow[] = useMemo(() => {
    const generated = buildVariantRows(
      optionsState,
      // For pre-existing rows we want their persisted SKU/price/stock
      // to flow into the generator's `existing` arg. We recover that
      // from `variantState` by tuple lookup.
      [...variantState.values()].map<EditorVariant>((r) => ({
        id: r.id,
        sku: r.sku,
        priceMinor: r.priceMinor ?? 0,
        currency: r.currency,
        stock: r.stock ?? 0,
        active: r.active,
        optionValueIds: r.tuple,
      })),
      useFlatFormSeed
        ? { transitionMergePolicy: "preserve-first-touched" }
        : undefined,
    );
    // Merge the per-key live edit state on top — the user might have
    // typed a new SKU that hasn't been written back to existingMap yet.
    const withLive = generated.map((r) => {
      const live = variantState.get(r.key);
      return live
        ? {
            ...r,
            sku: live.sku,
            priceMinor: live.priceMinor,
            stock: live.stock,
            active: live.active,
            id: live.id ?? r.id,
          }
        : r;
    });
    return withLive.filter((r) => !removedKeys.has(r.key));
    // `variantState` is a Map identity; React reuses it across renders
    // so we depend on the JSON snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsState, variantStateSnapshot(variantState), removedKeys, useFlatFormSeed]);

  // Lets the memoized options handler peek at the latest visible flat
  // row when deciding whether the State-C expand banner has anything
  // worth reassuring the operator about — without invalidating the
  // handler identity each render.
  const variantRowsRef = useRef<VariantRow[]>([]);
  variantRowsRef.current = variantRows;

  function updateVariantRow(key: string, next: Partial<VariantRow>): void {
    setVariantState((prev) => {
      const live =
        prev.get(key) ??
        variantRows.find((r) => r.key === key) ??
        emptyRowForKey(key);
      const merged: VariantRow = { ...live, ...next };
      const m = new Map(prev);
      m.set(key, merged);
      return m;
    });
    setVariantRowErrors((prev) => {
      // Clear only the touched row's error so other rows keep their
      // validation state until they're touched too.
      const cur = prev[key];
      if (!cur) return prev;
      const cleared: RowErrors = {};
      if (cur.combination) cleared.combination = cur.combination;
      const next = { ...prev };
      next[key] = Object.keys(cleared).length === 0 ? undefined : cleared;
      return next;
    });
  }

  const optionsHandlers = useMemo(
    () => ({
      onAddOption: () => {
        const wasFlat = optionsStateRef.current.length === 0;
        setOptionsState((prev) =>
          prev.length >= 3
            ? prev
            : [
                ...prev,
                {
                  id: clientId(),
                  name: { en: "", ar: "" },
                  position: prev.length + 1,
                  values: [],
                },
              ],
        );
        // State-C single → multi: arm the preserve-first-touched seed
        // and surface the expand banner only when the flat form has
        // typed-in data worth reassuring the operator about. Otherwise
        // the banner promises preservation that has nothing to land on.
        if (wasFlat) {
          const flatRow = variantRowsRef.current[0];
          const hasFlatData =
            !!flatRow &&
            (flatRow.sku !== "" ||
              flatRow.priceMinor !== null ||
              flatRow.stock !== null);
          if (hasFlatData) {
            setUseFlatFormSeed(true);
            setTransitionNotice("expand");
          }
        }
      },
      onUpdateOption: (
        optionId: string,
        next: { name?: { en?: string; ar?: string } },
      ) =>
        setOptionsState((prev) =>
          prev.map((o) =>
            o.id !== optionId
              ? o
              : {
                  ...o,
                  name: {
                    en: next.name?.en ?? o.name.en,
                    ar: next.name?.ar ?? o.name.ar,
                  },
                },
          ),
        ),
      onAddValue: (optionId: string) =>
        setOptionsState((prev) =>
          prev.map((o) =>
            o.id !== optionId
              ? o
              : {
                  ...o,
                  values: [
                    ...o.values,
                    {
                      id: clientId(),
                      value: { en: "", ar: "" },
                      position: o.values.length + 1,
                    },
                  ],
                },
          ),
        ),
      onUpdateValue: (
        optionId: string,
        valueId: string,
        next: { value?: { en?: string; ar?: string } },
      ) =>
        setOptionsState((prev) =>
          prev.map((o) =>
            o.id !== optionId
              ? o
              : {
                  ...o,
                  values: o.values.map((v) =>
                    v.id !== valueId
                      ? v
                      : {
                          ...v,
                          value: {
                            en: next.value?.en ?? v.value.en,
                            ar: next.value?.ar ?? v.value.ar,
                          },
                        },
                  ),
                },
          ),
        ),
      onRemoveValue: (optionId: string, valueId: string) =>
        setOptionsState((prev) =>
          prev.map((o) =>
            o.id !== optionId
              ? o
              : {
                  ...o,
                  values: o.values.filter((v) => v.id !== valueId),
                },
          ),
        ),
    }),
    [],
  );

  const optionsDirty = useMemo(
    () => snapshotOptions(optionsState) !== initialOptionsKey,
    [optionsState, initialOptionsKey],
  );
  const variantsDirty = useMemo(() => {
    // Filter out auto-generated rows the operator hasn't touched. An
    // untouched row is one with no persisted id, an empty SKU, and
    // both price + stock at null (i.e., the row was synthesised by
    // the cartesian generator and the operator hasn't typed anything
    // into it). This keeps the dirty memo from flagging a freshly-
    // opened form as dirty just because the cartesian generator
    // emitted a blank default row.
    const operatorTouched = variantRows.filter(
      (r) =>
        r.id !== undefined ||
        r.sku.length > 0 ||
        r.priceMinor !== null ||
        r.stock !== null,
    );
    const editorVariants: EditorVariant[] = operatorTouched.map((r) => ({
      id: r.id,
      sku: r.sku,
      priceMinor: r.priceMinor ?? 0,
      currency: r.currency,
      stock: r.stock ?? 0,
      active: r.active,
      optionValueIds: r.tuple,
    }));
    return snapshotVariants(editorVariants) !== initialVariantsKey;
  }, [variantRows, initialVariantsKey]);

  // Number of cartesian combinations the current options + values draft
  // would generate on Save. Pure derivation — used by the cap-warning
  // (>100) advisory and the cascade-count preview.
  const projectedCombinationCount = useMemo(
    () => projectCombinations(optionsState),
    [optionsState],
  );
  const capWarning =
    projectedCombinationCount > MAX_VARIANTS_PER_PRODUCT
      ? { count: projectedCombinationCount }
      : null;

  function cascadeCountFor(optionId: string): number {
    // Count of currently-rendered variant rows whose tuple contains any
    // value-id of the option being removed. Pure client derivation —
    // the server is the authoritative source on Save.
    const target = optionsState.find((o) => o.id === optionId);
    if (!target) return 0;
    const valueIds = new Set(target.values.map((v) => v.id));
    return variantRows.filter((r) => r.tuple.some((id) => valueIds.has(id)))
      .length;
  }

  function onRemoveOption(optionId: string): void {
    const wasLast = optionsState.length === 1;
    setOptionsState((prev) => prev.filter((o) => o.id !== optionId));
    // Drop any in-flight selection / pending removals that no longer
    // map to a row after the cascade collapses the cartesian.
    setSelectedKeys(new Set());
    setRemovedKeys(new Set());
    if (wasLast) {
      // Multi → single. Arm preserve-first-touched so the first touched
      // row's SKU/price/stock seeds the default row, and surface the
      // collapse banner.
      setUseFlatFormSeed(true);
      setTransitionNotice("collapse");
    } else {
      setTransitionNotice(null);
    }
  }

  function onRemoveRow(key: string): void {
    setRemovedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setSelectedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function onApplyBulkPatch(patch: BulkApplyPatch): void {
    if (selectedKeys.size === 0) return;
    setBulkSheetOpen(false);
    setVariantState((prev) => {
      const next = new Map(prev);
      for (const key of selectedKeys) {
        const live =
          next.get(key) ??
          variantRows.find((r) => r.key === key) ??
          emptyRowForKey(key);
        const merged: VariantRow = { ...live };
        if (patch.priceMinor !== undefined) merged.priceMinor = patch.priceMinor;
        if (patch.stock !== undefined) merged.stock = patch.stock;
        next.set(key, merged);
      }
      return next;
    });
    // Clear the per-row error state for the touched rows so a previous
    // priceInvalid / stockInvalid does not linger after the bulk
    // overwrite.
    setVariantRowErrors((prev) => {
      const next = { ...prev };
      for (const key of selectedKeys) delete next[key];
      return next;
    });
    setSelectedKeys(new Set());
    setSelectMode(false);
  }

  const categoryOptionsById = useMemo(() => {
    const m = new Map<string, CategoryOption>();
    for (const o of categoryOptions) m.set(o.id, o);
    return m;
  }, [categoryOptions]);

  // Ref scoped to the Categories section so `onRemoveChip` can find
  // the *next* chip's remove button after a removal without scanning
  // unrelated form chrome. Move-focus contract: after a chip's × is
  // pressed and the chip unmounts, focus lands on the next chip's ×
  // (DOM order) if one exists, otherwise on the Add Categories button.
  //
  // `flushSync` forces React to commit the state update + DOM patch
  // synchronously inside this handler. Without it, an earlier
  // `requestAnimationFrame` trampoline raced React 18's concurrent
  // reconciler on mobile WebKit / chrome-headless-shell — the chip
  // being removed was still in the DOM when the rAF callback ran, so
  // focus shifted to a node that was about to unmount and
  // `document.activeElement` collapsed to null.
  const categoriesSectionRef = useRef<HTMLElement | null>(null);

  function onRemoveChip(removedId: string, removedIndex: number): void {
    flushSync(() => {
      setSelectedCategoryIds((prev) => prev.filter((x) => x !== removedId));
    });
    const root = categoriesSectionRef.current;
    if (!root) return;
    const remaining = Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        '[data-testid="product-category-chip-remove"]',
      ),
    );
    // Prefer the chip that took the removed chip's slot. If we
    // removed the last chip, fall back one index. If no chips
    // remain, fall back to the Add button.
    const target =
      remaining[removedIndex] ??
      remaining[remaining.length - 1] ??
      document.getElementById("product-categories-add");
    target?.focus();
  }

  // Baseline-key — derived from the live `baselineCategoryIds` (NOT the
  // prop) so that after a stale-category recovery (which refreshes both
  // selected and baseline to the server's current set) the dirty memo
  // collapses to false rather than reporting "still dirty" against a
  // frozen prop snapshot.
  const baselineCategoryIdsKey = useMemo(
    () => [...baselineCategoryIds].sort().join(","),
    [baselineCategoryIds],
  );

  const displayName =
    locale === "ar"
      ? initial.nameAr || initial.nameEn || initial.slug
      : initial.nameEn || initial.nameAr || initial.slug;

  const selectedCategoryIdsKey = useMemo(
    () => [...selectedCategoryIds].sort().join(","),
    [selectedCategoryIds],
  );

  const dirty = useMemo<boolean>(() => {
    if (slug !== initial.slug) return true;
    if (nameEn !== initial.nameEn) return true;
    if (nameAr !== initial.nameAr) return true;
    if (descriptionEn !== initial.descriptionEn) return true;
    if (descriptionAr !== initial.descriptionAr) return true;
    if (status !== initial.status) return true;
    if (initialHasCostPrice && costPriceText !== initialCostPriceText) return true;
    // Compare sorted-string keys for set semantics.
    if (selectedCategoryIdsKey !== baselineCategoryIdsKey) return true;
    if (optionsDirty) return true;
    if (variantsDirty) return true;
    return false;
  }, [
    slug,
    nameEn,
    nameAr,
    descriptionEn,
    descriptionAr,
    status,
    costPriceText,
    initial,
    initialHasCostPrice,
    initialCostPriceText,
    selectedCategoryIdsKey,
    baselineCategoryIdsKey,
    optionsDirty,
    variantsDirty,
  ]);

  // Browser back / tab close confirmation.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    function handler(e: BeforeUnloadEvent): string | undefined {
      if (!dirtyRef.current) return undefined;
      e.preventDefault();
      // Modern browsers ignore the message but require a non-empty
      // returnValue to trigger the confirm dialog.
      e.returnValue = "";
      return "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  function onSlugChange(next: string): void {
    setSlug(next);
    setSlugError(next.length === 0 ? null : validateSlug(next));
  }

  const removeMutation = trpc.products.delete.useMutation({
    onSuccess: () => {
      // Clear dirty BEFORE navigating — the beforeunload listener
      // would otherwise fire on the redirect.
      dirtyRef.current = false;
      router.push(
        `/${locale}/admin/products?removedId=${encodeURIComponent(displayName)}`,
      );
    },
    onError: (err) => {
      setShowRemoveConfirm(false);
      setStaleWriteFlash(false);
      setTopError(null);
      if (err.data?.code === "CONFLICT" && err.message === "stale_write") {
        setStaleWriteFlash(true);
        return;
      }
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
        return;
      }
      setTopError(t("error"));
    },
  });

  // setCategories is the second leg of the save chain. On success it
  // either chains into setOptions / setVariants if those slices are
  // dirty, or redirects to the list. On stale-category (BAD_REQUEST
  // category_not_found) it surfaces an inline banner and re-queries the
  // current set so the chips reflect what the server has now.
  const setCategoriesMutation = trpc.products.setCategories.useMutation({
    onSuccess: (data) => {
      const newUpdatedAt = data?.productUpdatedAt
        ? new Date(data.productUpdatedAt).toISOString()
        : null;
      if (newUpdatedAt) setLiveExpectedUpdatedAt(newUpdatedAt);
      const updatedName =
        saveChainNameRef.current.length > 0
          ? saveChainNameRef.current
          : nameEn !== initial.nameEn && nameEn.length > 0
            ? nameEn
            : initial.nameEn || initial.slug;
      saveChainNameRef.current = updatedName;
      if (optionsDirty && newUpdatedAt) {
        setOptionsMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          options: buildOptionsPayload(),
        });
        return;
      }
      if (variantsDirty && newUpdatedAt) {
        setVariantsMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          variants: buildVariantsPayload(),
        });
        return;
      }
      // Done.
      dirtyRef.current = false;
      router.push(
        `/${locale}/admin/products?updatedId=${encodeURIComponent(updatedName)}`,
      );
    },
    onError: async (err) => {
      if (
        err.data?.code === "BAD_REQUEST" &&
        err.message === "category_not_found"
      ) {
        // A category we tried to attach is no longer live (raced with a
        // soft-delete, or the tree was edited in another tab). Surface
        // the banner and re-query the current set so chips snap back.
        setStaleCategoriesFlash(true);
        try {
          const refreshed = await trpcUtils.categories.listForProduct.fetch({
            productId: initial.id,
          });
          const ids = refreshed.items.map((c) => c.id);
          setSelectedCategoryIds(ids);
          setBaselineCategoryIds(ids);
        } catch {
          // If the re-query fails, leave the picker state alone — the
          // user can refresh the page manually.
        }
        return;
      }
      if (err.data?.code === "CONFLICT" && err.message === "stale_write") {
        setStaleWriteFlash(true);
        return;
      }
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
        return;
      }
      setTopError(t("error"));
    },
  });

  // Save chain: products.update → products.setCategories → products.setOptions
  // → products.setVariants. Any leg may be skipped when its slice isn't
  // dirty. The OCC token is threaded forward through each leg's
  // returned `updatedAt`. We model the chain as a series of refs so the
  // mutation `onSuccess` callbacks can read the latest plan without
  // re-creating the mutation handles.
  const saveChainNameRef = useRef<string>("");
  const setVariantsMutation = trpc.products.setVariants.useMutation({
    onSuccess: () => {
      dirtyRef.current = false;
      router.push(
        `/${locale}/admin/products?updatedId=${encodeURIComponent(saveChainNameRef.current)}`,
      );
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT" && err.message === "stale_write") {
        setStaleWriteFlash(true);
        return;
      }
      if (err.data?.code === "CONFLICT" && err.message === "sku_taken") {
        // Closed-set message — no SKU echoed. We can't pin the error
        // to a specific row from the wire alone. Surface as a section-
        // level inline error; the operator can scan the SKU column.
        setVariantsTopError(t("variants.skuTaken"));
        return;
      }
      if (err.data?.code === "BAD_REQUEST" && err.message === "duplicate_variant_combination") {
        setVariantsTopError(t("variants.duplicateCombination"));
        return;
      }
      if (err.data?.code === "BAD_REQUEST") {
        // 1a.5.3 — the >100-variants cap surfaces as a generic
        // validation_failed; if the structured Zod issue points at the
        // top-level `variants` array (too_big), use the bound cap copy.
        // Otherwise fall through to the generic save-error copy so we
        // do not mislead the operator into thinking they hit the cap.
        const issues = err.data?.zodError?.fieldErrors as
          | Record<string, string[] | undefined>
          | undefined;
        const variantsIssue = issues?.["variants"]?.[0] ?? "";
        if (variantsIssue.toLowerCase().includes("100")) {
          setVariantsTopError(t("variants.serverMaxVariantsExceeded"));
          return;
        }
        setVariantsTopError(t("variants.saveError"));
        return;
      }
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
        return;
      }
      setVariantsTopError(t("variants.saveError"));
    },
  });

  const setOptionsMutation = trpc.products.setOptions.useMutation({
    onSuccess: (data) => {
      const newUpdatedAt = data?.productUpdatedAt
        ? new Date(data.productUpdatedAt).toISOString()
        : null;
      if (newUpdatedAt) setLiveExpectedUpdatedAt(newUpdatedAt);
      // 1a.5.3 — the server tells us which variant rows it cascade-
      // hard-deleted as part of this set-replace. Build the next leg's
      // payload from a *post-cascade* derivation of variant rows so
      // the wire input excludes the now-deleted ids and (for the
      // State-C collapse) re-introduces the preserve-first-touched
      // default row as a brand-new insert (no `id`).
      //
      // We compute the post-cascade row set inline rather than relying
      // on the React-derived `variantRows` memo, because mutating
      // state via setX → flushSync inside this callback does not
      // refresh closure-captured derived values. Building the payload
      // from current data avoids the staleness trap entirely; we
      // mirror the same prune to React state so the UI agrees.
      const cascadedIds = new Set<string>(data?.cascadedVariantIds ?? []);
      const preservedDefault =
        cascadedIds.size > 0 && optionsState.length === 0
          ? variantRows.find((r) => r.key === "default") ?? null
          : null;
      // Build the client-id → server-id map for option values. The
      // server returned options in the same order we submitted them
      // (positions match), and within each option the values are also
      // in submitted order. We walk both side-by-side.
      const idMap = new Map<string, string>();
      const serverOpts = data?.options ?? [];
      for (let i = 0; i < optionsState.length && i < serverOpts.length; i++) {
        const localOpt = optionsState[i]!;
        const remoteOpt = serverOpts[i]!;
        idMap.set(localOpt.id, remoteOpt.id);
        for (let j = 0; j < localOpt.values.length && j < remoteOpt.values.length; j++) {
          idMap.set(localOpt.values[j]!.id, remoteOpt.values[j]!.id);
        }
      }
      if (cascadedIds.size > 0) {
        flushSync(() => {
          setVariantState((prev) => {
            const next = new Map<string, VariantRow>();
            const dropKeys = new Set<string>();
            for (const [k, r] of prev) {
              if (r.id && cascadedIds.has(r.id)) {
                dropKeys.add(k);
                continue;
              }
              next.set(k, r);
            }
            // Mirror the post-cascade re-stash so the UI matches the
            // payload below. The `id: undefined` is load-bearing: the
            // server hard-deleted every variant on this product as
            // part of the same tx that returned `cascadedVariantIds`,
            // so the row's prior id no longer exists. Re-submitting
            // it would surface as `variant_not_found` (best case) or
            // hit a phantom (worst case). Treating the preserved row
            // as a fresh insert is the only correct shape — the
            // server mints a new id on the chained setVariants leg.
            if (
              preservedDefault &&
              (preservedDefault.sku.length > 0 ||
                preservedDefault.priceMinor !== null ||
                preservedDefault.stock !== null)
            ) {
              next.set("default", { ...preservedDefault, id: undefined });
            }
            cascadeDroppedKeysRef.current = dropKeys;
            return next;
          });
          if (cascadeDroppedKeysRef.current.size > 0) {
            setVariantRowErrors((prev) => {
              const next = { ...prev };
              for (const k of cascadeDroppedKeysRef.current) delete next[k];
              return next;
            });
          }
          setRemovedKeys(new Set());
          setSelectedKeys(new Set());
        });
      }
      if (variantsDirty && newUpdatedAt) {
        setVariantsMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          variants: buildVariantsPayloadAfterCascade(
            cascadedIds,
            preservedDefault,
            idMap,
          ),
        });
        return;
      }
      // Done.
      dirtyRef.current = false;
      router.push(
        `/${locale}/admin/products?updatedId=${encodeURIComponent(saveChainNameRef.current)}`,
      );
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT" && err.message === "stale_write") {
        setStaleWriteFlash(true);
        return;
      }
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
        return;
      }
      setVariantsTopError(t("variants.saveError"));
    },
  });

  const mutation = trpc.products.update.useMutation({
    onSuccess: (data) => {
      // First leg succeeded. Capture the freshly-bumped OCC token from
      // the wire return for the next leg.
      const newUpdatedAt = data?.updatedAt
        ? new Date(data.updatedAt).toISOString()
        : null;
      if (newUpdatedAt) setLiveExpectedUpdatedAt(newUpdatedAt);

      const updatedName =
        (data?.name as { en: string } | undefined)?.en ?? data?.slug ?? "";
      saveChainNameRef.current = updatedName;

      // Chain: setCategories → setOptions → setVariants → done. We
      // queue each leg only if its slice is dirty; otherwise we fall
      // through to the next.
      if (selectedCategoryIdsKey !== baselineCategoryIdsKey && newUpdatedAt) {
        setCategoriesMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          categoryIds: selectedCategoryIds,
        });
        return;
      }
      if (optionsDirty && newUpdatedAt) {
        setOptionsMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          options: buildOptionsPayload(),
        });
        return;
      }
      if (variantsDirty && newUpdatedAt) {
        setVariantsMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          variants: buildVariantsPayload(),
        });
        return;
      }
      dirtyRef.current = false;
      router.push(
        `/${locale}/admin/products?updatedId=${encodeURIComponent(updatedName)}`,
      );
    },
    onError: (err) => {
      setFieldErrors({});
      setTopError(null);
      setStaleWriteFlash(false);
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
        return;
      }
      if (err.data?.code === "CONFLICT" && err.message === "stale_write") {
        setStaleWriteFlash(true);
        return;
      }
      if (err.data?.code === "CONFLICT" && err.message === "slug_taken") {
        setFieldErrors({ slug: [t("slugTaken")] });
        return;
      }
      const zodFieldErrors = err.data?.zodError?.fieldErrors as FieldErrors | undefined;
      if (zodFieldErrors) {
        setFieldErrors(zodFieldErrors);
        return;
      }
      setTopError(t("error"));
    },
  });

  function buildPayload(): Parameters<typeof mutation.mutate>[0] {
    const payload: Record<string, unknown> = {
      id: initial.id,
      expectedUpdatedAt: initial.expectedUpdatedAt,
    };
    if (slug !== initial.slug) payload.slug = slug;
    if (nameEn !== initial.nameEn || nameAr !== initial.nameAr) {
      const next: { en?: string; ar?: string } = {};
      if (nameEn !== initial.nameEn && nameEn.length > 0) next.en = nameEn;
      if (nameAr !== initial.nameAr && nameAr.length > 0) next.ar = nameAr;
      // Send only the changed locale(s); the service merges with the
      // existing JSONB row to preserve the unchanged side.
      if (next.en !== undefined || next.ar !== undefined) payload.name = next;
    }
    if (
      descriptionEn !== initial.descriptionEn ||
      descriptionAr !== initial.descriptionAr
    ) {
      const empty =
        descriptionEn.length === 0 && descriptionAr.length === 0;
      if (empty) {
        payload.description = null;
      } else {
        const next: { en?: string; ar?: string } = {};
        if (descriptionEn.length > 0) next.en = descriptionEn;
        if (descriptionAr.length > 0) next.ar = descriptionAr;
        payload.description = next;
      }
    }
    if (status !== initial.status) payload.status = status;
    if (initialHasCostPrice && costPriceText !== initialCostPriceText) {
      if (costPriceText.length === 0) {
        payload.costPriceMinor = null;
      } else {
        const sar = Number.parseFloat(costPriceText);
        payload.costPriceMinor = Number.isFinite(sar)
          ? Math.round(sar * 100)
          : null;
      }
    }
    return payload as Parameters<typeof mutation.mutate>[0];
  }

  // True when any non-category field changed. Used to decide whether
  // to run the products.update mutation. If only categories changed, we
  // skip update entirely and call setCategories directly with the
  // current OCC token.
  function productFieldsChanged(): boolean {
    if (slug !== initial.slug) return true;
    if (nameEn !== initial.nameEn) return true;
    if (nameAr !== initial.nameAr) return true;
    if (descriptionEn !== initial.descriptionEn) return true;
    if (descriptionAr !== initial.descriptionAr) return true;
    if (status !== initial.status) return true;
    if (initialHasCostPrice && costPriceText !== initialCostPriceText) {
      return true;
    }
    return false;
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (
      mutation.isPending ||
      setCategoriesMutation.isPending ||
      setOptionsMutation.isPending ||
      setVariantsMutation.isPending ||
      !dirty
    ) {
      return;
    }
    setFieldErrors({});
    setTopError(null);
    setStaleWriteFlash(false);
    setStaleCategoriesFlash(false);
    setVariantsTopError(null);

    // 1a.5.3 — client-side dup-SKU pre-check (security spec §5 / §B.6).
    // Pin row-level errors when two non-empty SKUs collide within the
    // operator's own draft. Both values are local to the submission;
    // there is no leak. Short-circuits the network call so the wire
    // does not see the obviously-bad submission.
    if (variantsDirty) {
      const seen = new Map<string, string[]>();
      for (const r of variantRows) {
        const key = r.sku.trim();
        if (key.length === 0) continue;
        const arr = seen.get(key) ?? [];
        arr.push(r.key);
        seen.set(key, arr);
      }
      const dupRowKeys = new Set<string>();
      for (const arr of seen.values()) {
        if (arr.length > 1) for (const k of arr) dupRowKeys.add(k);
      }
      if (dupRowKeys.size > 0) {
        setVariantRowErrors((prev) => {
          const next = { ...prev };
          for (const k of dupRowKeys) {
            const existing = next[k] ?? {};
            next[k] = { ...existing, sku: t("variants.duplicateSkuInForm") };
          }
          return next;
        });
        return;
      }
    }

    // Save chain entry-point: each leg is conditional and threads OCC
    // forward via its own onSuccess.
    const fallbackName =
      nameEn !== initial.nameEn && nameEn.length > 0
        ? nameEn
        : initial.nameEn || initial.slug;
    saveChainNameRef.current = fallbackName;

    if (productFieldsChanged()) {
      mutation.mutate(buildPayload());
      return;
    }
    if (selectedCategoryIdsKey !== baselineCategoryIdsKey) {
      setCategoriesMutation.mutate({
        productId: initial.id,
        expectedUpdatedAt: liveExpectedUpdatedAt,
        categoryIds: selectedCategoryIds,
      });
      return;
    }
    if (optionsDirty) {
      setOptionsMutation.mutate({
        productId: initial.id,
        expectedUpdatedAt: liveExpectedUpdatedAt,
        options: buildOptionsPayload(),
      });
      return;
    }
    if (variantsDirty) {
      setVariantsMutation.mutate({
        productId: initial.id,
        expectedUpdatedAt: liveExpectedUpdatedAt,
        variants: buildVariantsPayload(),
      });
    }
  }

  function buildOptionsPayload(): Array<{
    id?: string;
    name: { en: string; ar: string };
    values: Array<{
      id?: string;
      value: { en: string; ar: string };
    }>;
  }> {
    return optionsState.map((o) => ({
      ...(persistedOptionIds.has(o.id) ? { id: o.id } : {}),
      name: { en: o.name.en, ar: o.name.ar },
      values: o.values.map((v) => ({
        // Include the value id only when its parent option is persisted
        // (a fresh option type's values are always brand new — server
        // mints both). Client-only ids would be rejected by the server
        // with option_value_not_found.
        ...(persistedOptionIds.has(o.id) ? { id: v.id } : {}),
        value: { en: v.value.en, ar: v.value.ar },
      })),
    }));
  }

  function buildVariantsPayload(): Array<{
    id?: string;
    sku: string;
    priceMinor: number;
    currency: string;
    stock: number;
    active: boolean;
    optionValueIds: string[];
  }> {
    return buildVariantsPayloadWithIdMap(new Map());
  }

  /**
   * Cascade-aware payload builder for the chained setVariants leg
   * (1a.5.3). Reads the current `variantRows` (which still reflect the
   * pre-cascade state at this synchronous instant) and applies the
   * cascade prune + State-C re-stash explicitly.
   */
  function buildVariantsPayloadAfterCascade(
    cascadedIds: ReadonlySet<string>,
    preservedDefault: VariantRow | null,
    valueIdMap: ReadonlyMap<string, string>,
  ): Array<{
    id?: string;
    sku: string;
    priceMinor: number;
    currency: string;
    stock: number;
    active: boolean;
    optionValueIds: string[];
  }> {
    // Drop cascaded ids; for any row whose persisted id was cascaded,
    // exclude it entirely (the server already deleted the row).
    const survivors = variantRows.filter(
      (r) => !(r.id && cascadedIds.has(r.id)),
    );
    // If we are collapsing to single-variant default mode, swap in
    // the preserved-first-touched default row as a fresh insert.
    const rows: VariantRow[] = (() => {
      if (!preservedDefault) return survivors;
      const withoutDefault = survivors.filter((r) => r.key !== "default");
      const hasContent =
        preservedDefault.sku.length > 0 ||
        preservedDefault.priceMinor !== null ||
        preservedDefault.stock !== null;
      if (!hasContent) return withoutDefault;
      return [...withoutDefault, { ...preservedDefault, id: undefined }];
    })();
    const operatorTouched = rows.filter(
      (r) =>
        r.id !== undefined ||
        r.sku.length > 0 ||
        r.priceMinor !== null ||
        r.stock !== null,
    );
    return operatorTouched.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      sku: r.sku,
      priceMinor: r.priceMinor ?? 0,
      currency: r.currency,
      stock: r.stock ?? 0,
      active: r.active,
      optionValueIds: r.tuple.map((id) => valueIdMap.get(id) ?? id),
    }));
  }

  function buildVariantsPayloadWithIdMap(
    valueIdMap: ReadonlyMap<string, string>,
  ): Array<{
    id?: string;
    sku: string;
    priceMinor: number;
    currency: string;
    stock: number;
    active: boolean;
    optionValueIds: string[];
  }> {
    // Filter out auto-generated rows the operator hasn't touched.
    // Without this, a cascade-collapse (1a.5.3) re-generates fresh
    // empty rows for the surviving options, and the server would
    // reject the empty SKU; it is also not what the operator
    // intended. An untouched row has no persisted id, an empty SKU,
    // and both price + stock at null.
    const operatorTouched = variantRows.filter(
      (r) =>
        r.id !== undefined ||
        r.sku.length > 0 ||
        r.priceMinor !== null ||
        r.stock !== null,
    );
    return operatorTouched.map((r) => {
      // Re-map client-minted value-ids to their server-minted
      // counterparts (from setOptions's response). Persisted ids are
      // not in the map and pass through.
      const tuple = r.tuple.map((id) => valueIdMap.get(id) ?? id);
      return {
        ...(r.id ? { id: r.id } : {}),
        sku: r.sku,
        priceMinor: r.priceMinor ?? 0,
        currency: r.currency,
        stock: r.stock ?? 0,
        active: r.active,
        optionValueIds: tuple,
      };
    });
  }

  function onCancelClick(): void {
    if (dirty) {
      setShowDiscardConfirm(true);
      return;
    }
    router.push(`/${locale}/admin/products`);
  }

  function onDiscardConfirm(): void {
    dirtyRef.current = false;
    setShowDiscardConfirm(false);
    router.push(`/${locale}/admin/products`);
  }

  const submitDisabled =
    !hydrated ||
    mutation.isPending ||
    setCategoriesMutation.isPending ||
    setOptionsMutation.isPending ||
    setVariantsMutation.isPending ||
    !dirty;
  const slugChanged = slug !== initial.slug;

  return (
    <form
      className="space-y-4"
      onSubmit={onSubmit}
      noValidate
      data-testid="edit-product-form"
    >
      {staleCategoriesFlash ? (
        <div
          role="alert"
          data-testid="product-categories-stale-error"
          className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>{tcat("staleError")}</p>
        </div>
      ) : null}
      {staleWriteFlash ? (
        <div
          role="alert"
          data-testid="edit-product-stale-write"
          className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>{t("staleWriteError")}</p>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="mt-2 inline-flex min-h-[44px] items-center rounded-md border border-amber-300 px-3 text-sm font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            {t("staleWriteRefresh")}
          </button>
        </div>
      ) : null}

      {topError ? (
        <p
          role="alert"
          data-testid="edit-product-top-error"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {topError}
        </p>
      ) : null}

      <div className="space-y-4 sm:flex sm:items-start sm:gap-4 sm:space-y-0">
        <div className="sm:w-full sm:max-w-lg">
          <FormField
            id="product-name-en"
            name="name.en"
            label={tc("nameEn")}
            value={nameEn}
            onChange={setNameEn}
            required
            errors={fieldErrors["name.en"] ?? fieldErrors["name"]}
          />
        </div>
        <div
          aria-hidden="true"
          className="hidden self-stretch bg-neutral-200 sm:block sm:w-px dark:bg-neutral-800"
        />
        <div className="sm:flex-1">
          <SlugField
            slug={slug}
            slugChanged={slugChanged}
            liveError={slugError}
            serverErrors={fieldErrors["slug"]}
            onSlugChange={onSlugChange}
            slugChangeWarning={t("slugChangeWarning")}
            labels={{
              label: tc("slug"),
              helper: tc("slugHelper"),
              errorMessages: {
                empty: tc("slugError.empty"),
                too_long: tc("slugError.too_long"),
                invalid_chars: tc("slugError.invalid_chars"),
                leading_hyphen: tc("slugError.leading_hyphen"),
                trailing_hyphen: tc("slugError.trailing_hyphen"),
                consecutive_hyphens: tc("slugError.consecutive_hyphens"),
              },
            }}
          />
        </div>
      </div>

      <div className="space-y-4 sm:max-w-lg">
        <FormField
          id="product-name-ar"
          name="name.ar"
          label={tc("nameAr")}
          value={nameAr}
          onChange={setNameAr}
          required
          errors={fieldErrors["name.ar"]}
        />
        <FormTextarea
          id="product-description-en"
          name="description.en"
          label={tc("descriptionEn")}
          value={descriptionEn}
          onChange={setDescriptionEn}
          errors={fieldErrors["description.en"]}
        />
        <FormTextarea
          id="product-description-ar"
          name="description.ar"
          label={tc("descriptionAr")}
          value={descriptionAr}
          onChange={setDescriptionAr}
          errors={fieldErrors["description.ar"]}
        />

        <div>
          <label htmlFor="product-status" className="block text-sm font-medium">
            {tc("status")}
          </label>
          <select
            id="product-status"
            name="status"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value === "active" ? "active" : "draft")
            }
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="draft">{tc("statusDraft")}</option>
            <option value="active">{tc("statusActive")}</option>
          </select>
        </div>

        {initialHasCostPrice ? (
          <div data-testid="cost-price-field">
            <label
              htmlFor="product-cost-price"
              className="block text-sm font-medium"
            >
              {t("costPriceLabel")}
            </label>
            <input
              id="product-cost-price"
              name="costPriceMinor"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              dir="ltr"
              value={costPriceText}
              onChange={(e) => setCostPriceText(e.target.value)}
              aria-describedby="product-cost-price-helper"
              className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
            />
            <p
              id="product-cost-price-helper"
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
            >
              {t("costPriceHelper")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Categories section — chip list + Add button. Sits above the
          Remove product affordance so the destructive action stays the
          last item before the sticky save bar. */}
      <section
        ref={categoriesSectionRef}
        data-testid="product-categories-section"
        className="border-t border-neutral-200 pt-6 dark:border-neutral-800"
      >
        <h2 className="text-sm font-medium">{tcat("heading")}</h2>
        {selectedCategoryIds.length === 0 ? (
          <p
            data-testid="product-categories-empty"
            className="mt-2 text-sm text-neutral-500 dark:text-neutral-400"
          >
            {tcat("noneSelected")}
          </p>
        ) : (
          <ul
            data-testid="product-category-chip-list"
            className="mt-2 flex flex-wrap gap-2"
          >
            {selectedCategoryIds.map((id, index) => {
              const opt = categoryOptionsById.get(id);
              const path = opt?.fullPath[locale as "en" | "ar"] ?? id;
              return (
                <li
                  key={id}
                  data-testid="product-category-chip"
                  data-id={id}
                  className="flex items-center gap-1 rounded-full border border-neutral-300 bg-neutral-50 ps-3 pe-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <span>{path}</span>
                  <button
                    type="button"
                    data-testid="product-category-chip-remove"
                    aria-label={tcat("chipRemoveAriaLabel", { path })}
                    onClick={() => onRemoveChip(id, index)}
                    className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-800"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button
          type="button"
          id="product-categories-add"
          data-testid="product-categories-add"
          onClick={() => setPickerOpen(true)}
          className="mt-3 inline-flex h-11 items-center justify-center rounded-full border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          {tcat("addCta")}
        </button>
      </section>

      {/* Options panel — chunk 1a.5.2; cap-warning + cascade-confirm
          live in 1a.5.3. */}
      <OptionsPanel
        options={optionsState}
        locale={locale}
        isPersistedOption={(id) => persistedOptionIds.has(id)}
        cascadeCountFor={cascadeCountFor}
        capWarning={capWarning}
        onAddOption={optionsHandlers.onAddOption}
        onUpdateOption={optionsHandlers.onUpdateOption}
        onAddValue={optionsHandlers.onAddValue}
        onUpdateValue={optionsHandlers.onUpdateValue}
        onRemoveValue={optionsHandlers.onRemoveValue}
        onRemoveOption={onRemoveOption}
      />

      {/* Variants list — chunk 1a.5.2. Cartesian rows when options
          defined; flat single-variant form when not. */}
      {variantsTopError ? (
        <p
          role="alert"
          data-testid="variants-top-error"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {variantsTopError}
        </p>
      ) : null}
      {transitionNotice === "collapse" ? (
        <TransitionNotice
          testId="variants-collapse-notice"
          body={t("variants.collapseNotice.body")}
          dismissAriaLabel={t("variants.collapseNotice.dismissAriaLabel")}
          onDismiss={() => setTransitionNotice(null)}
        />
      ) : null}
      {transitionNotice === "expand" ? (
        <TransitionNotice
          testId="variants-expand-notice"
          body={t("variants.expandNotice.body")}
          dismissAriaLabel={t("variants.expandNotice.dismissAriaLabel")}
          onDismiss={() => setTransitionNotice(null)}
        />
      ) : null}
      <VariantsList
        rows={variantRows}
        options={optionsState}
        locale={locale === "ar" ? "ar" : "en"}
        rowErrors={variantRowErrors}
        onUpdateRow={updateVariantRow}
        selectMode={selectMode}
        selectedKeys={selectedKeys}
        onToggleSelectMode={() => {
          setSelectMode((v) => {
            const next = !v;
            if (!next) setSelectedKeys(new Set());
            return next;
          });
        }}
        onToggleRowSelected={(key) =>
          setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        onSelectAllVisible={() =>
          setSelectedKeys(new Set(variantRows.map((r) => r.key)))
        }
        onClearSelection={() => setSelectedKeys(new Set())}
        onApplyBulk={() => setBulkSheetOpen(true)}
        onRemoveRow={onRemoveRow}
      />
      <BulkApplySheet
        open={bulkSheetOpen}
        selectedCount={selectedKeys.size}
        onApply={onApplyBulkPatch}
        onCancel={() => setBulkSheetOpen(false)}
      />

      {/* Destructive Remove product affordance — visually separated
          from the primary Save/Cancel actions; opens its own confirm
          dialog. Sits above the sticky action bar so the action bar
          stays the dominant CTA. */}
      <div className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setShowRemoveConfirm(true)}
          data-testid="remove-product-cta"
          className="flex h-11 items-center justify-center self-start rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:bg-neutral-950 dark:text-red-400 dark:hover:bg-red-950/50"
        >
          {t("removeCta")}
        </button>
      </div>

      {/* Sticky bottom action bar — Cancel + Save side-by-side, 50/50 on mobile. */}
      <div
        data-testid="edit-product-action-bar"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <div className="mx-auto flex max-w-4xl items-stretch gap-3">
          <button
            type="button"
            onClick={onCancelClick}
            data-testid="edit-product-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={submitDisabled}
            data-testid="edit-product-submit"
            className="flex h-12 flex-1 items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {t("submit")}
          </button>
        </div>
      </div>

      {showDiscardConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="discard-confirm-title"
          data-testid="edit-product-discard-confirm"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
            <h2
              id="discard-confirm-title"
              className="text-base font-semibold"
            >
              {t("dirtyConfirmTitle")}
            </h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {t("dirtyConfirmBody")}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                onClick={onDiscardConfirm}
                data-testid="edit-product-discard-confirm-yes"
                className="flex h-11 flex-1 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
              >
                {t("discardConfirm")}
              </button>
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                data-testid="edit-product-discard-confirm-no"
                className="flex h-11 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {t("keepEditing")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRemoveConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-confirm-title"
          aria-describedby="remove-confirm-body"
          data-testid="remove-product-dialog"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
            <h2 id="remove-confirm-title" className="text-base font-semibold">
              {t("removeDialog.heading", { name: displayName })}
            </h2>
            <p
              id="remove-confirm-body"
              className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t("removeDialog.body")}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                type="button"
                onClick={() => {
                  if (removeMutation.isPending) return;
                  removeMutation.mutate({
                    id: initial.id,
                    expectedUpdatedAt: initial.expectedUpdatedAt,
                    confirm: true,
                  });
                }}
                data-testid="remove-product-confirm"
                disabled={removeMutation.isPending}
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {t("removeDialog.confirm")}
              </button>
              <button
                type="button"
                onClick={() => setShowRemoveConfirm(false)}
                data-testid="remove-product-cancel"
                className="flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {t("removeDialog.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Hidden link for tests / a11y fallback in case JS fails — Cancel
          button uses router.push, so this is belt-and-braces. */}
      <Link
        href={`/${locale}/admin/products`}
        className="sr-only"
        data-testid="edit-product-cancel-link"
      >
        {t("cancel")}
      </Link>

      <CategoryPickerSheet
        open={pickerOpen}
        mode="multi"
        searchable={true}
        selectedIds={selectedCategoryIds}
        categories={categoryOptions}
        locale={locale as "en" | "ar"}
        onApply={(next) => {
          setSelectedCategoryIds(next);
          setPickerOpen(false);
        }}
        onCancel={() => setPickerOpen(false)}
      />
    </form>
  );
}

/** Stable JSON snapshot of options for dirty-tracking — content only. */
function snapshotOptions(options: ReadonlyArray<EditorOption>): string {
  return JSON.stringify(
    options.map((o) => ({
      // The id is part of the snapshot only for persisted options;
      // freshly-minted client ids change every render, so we'd otherwise
      // get a permanently-dirty memo. We strip ids by storing positions
      // and the localized name/value text only.
      n: o.name,
      p: o.position,
      v: o.values.map((v) => ({ v: v.value, p: v.position })),
    })),
  );
}

/** Stable JSON snapshot of variants for dirty-tracking — content only. */
function snapshotVariants(variants: ReadonlyArray<EditorVariant>): string {
  return JSON.stringify(
    variants.map((v) => ({
      s: v.sku,
      p: v.priceMinor,
      c: v.currency,
      st: v.stock,
      a: v.active,
      // optionValueIds are part of the variant identity and must
      // contribute. We sort them to be insertion-order independent.
      o: [...v.optionValueIds].sort(),
    })),
  );
}

/** Stable snapshot of the per-key variant edit Map — content only. */
function variantStateSnapshot(state: ReadonlyMap<string, VariantRow>): string {
  const entries = [...state.entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(
    entries.map(([k, r]) => [
      k,
      r.sku,
      r.priceMinor,
      r.stock,
      r.currency,
      r.active,
    ]),
  );
}

/**
 * Cartesian projection used by the cap-warning advisory (1a.5.3). Pure
 * derivation — counts only options that already carry at least one
 * value (an option with zero values contributes nothing to the
 * cartesian and would zero the product). Empty options state ⇒ 1
 * (single-variant default mode, never triggers the cap warning).
 */
function projectCombinations(options: ReadonlyArray<EditorOption>): number {
  if (options.length === 0) return 1;
  let total = 1;
  for (const o of options) {
    const valueCount = o.values.length;
    if (valueCount === 0) continue;
    total *= valueCount;
  }
  return total;
}

/** Fall-back row when an updateVariantRow call hits a key the cartesian doesn't yet know about. */
function emptyRowForKey(key: string): VariantRow {
  return {
    id: undefined,
    key,
    tuple: [],
    sku: "",
    priceMinor: null,
    currency: "SAR",
    stock: null,
    active: true,
  };
}

interface FieldProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  errors?: string[] | undefined;
}

function FormField({ id, name, label, value, onChange, required, errors }: FieldProps) {
  const describedBy = errors && errors.length > 0 ? `${id}-error` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors && errors.length > 0 ? true : undefined}
        aria-describedby={describedBy}
        className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
      />
      {errors && errors.length > 0 ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 text-sm text-red-700 dark:text-red-400"
        >
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}

function FormTextarea({ id, name, label, value, onChange, errors }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors && errors.length > 0 ? true : undefined}
        aria-describedby={errors && errors.length > 0 ? `${id}-error` : undefined}
        rows={3}
        className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
      />
      {errors && errors.length > 0 ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 text-sm text-red-700 dark:text-red-400"
        >
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}

interface SlugFieldProps {
  slug: string;
  slugChanged: boolean;
  liveError: SlugValidationError | null;
  serverErrors: string[] | undefined;
  onSlugChange: (v: string) => void;
  slugChangeWarning: string;
  labels: {
    label: string;
    helper: string;
    errorMessages: Record<SlugValidationError, string>;
  };
}

function SlugField({
  slug,
  slugChanged,
  liveError,
  serverErrors,
  onSlugChange,
  slugChangeWarning,
  labels,
}: SlugFieldProps) {
  const liveMessage = liveError ? labels.errorMessages[liveError] : null;
  const serverMessage = serverErrors && serverErrors.length > 0 ? serverErrors[0] : null;
  const displayedError = liveMessage ?? serverMessage;

  const describedBy: string[] = ["product-slug-helper"];
  if (slugChanged) describedBy.push("product-slug-change-warning");
  if (displayedError) describedBy.push("product-slug-error");

  return (
    <div>
      <label htmlFor="product-slug" className="block text-sm font-medium">
        {labels.label}
      </label>
      <div className="mt-1 flex items-start gap-2">
        <input
          id="product-slug"
          name="slug"
          type="text"
          dir="ltr"
          required
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          pattern="[a-z0-9-]+"
          maxLength={SLUG_MAX}
          aria-invalid={displayedError ? true : undefined}
          aria-describedby={describedBy.join(" ")}
          className="block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <p
        id="product-slug-helper"
        className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
      >
        {labels.helper}
      </p>
      {slugChanged ? (
        <p
          id="product-slug-change-warning"
          data-testid="product-slug-change-warning"
          className="mt-1 text-xs text-amber-700 dark:text-amber-400"
        >
          {slugChangeWarning}
        </p>
      ) : null}
      {displayedError ? (
        <p
          id="product-slug-error"
          role="alert"
          className="mt-1 text-sm text-red-700 dark:text-red-400"
        >
          {displayedError}
        </p>
      ) : null}
    </div>
  );
}
