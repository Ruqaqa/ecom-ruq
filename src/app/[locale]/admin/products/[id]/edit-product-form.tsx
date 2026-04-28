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
}

type FieldErrors = Record<string, string[] | undefined>;

export function EditProductForm({
  locale,
  initial,
  categoryOptions,
  initialCategoryIds,
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
  // requestAnimationFrame is the right pin: by the next paint, React
  // has reconciled the new chip set into the DOM.
  const categoriesSectionRef = useRef<HTMLElement | null>(null);

  function onRemoveChip(removedId: string, removedIndex: number): void {
    setSelectedCategoryIds((prev) => prev.filter((x) => x !== removedId));
    // After the next paint, find a focus target inside the section.
    requestAnimationFrame(() => {
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
    });
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

  // setCategories is the second leg of the two-mutation save flow. On
  // success it redirects to the list. On stale-category (BAD_REQUEST
  // category_not_found) it surfaces an inline banner and re-queries the
  // current set so the chips reflect what the server has now.
  const setCategoriesMutation = trpc.products.setCategories.useMutation({
    onSuccess: (data, variables) => {
      // Clear dirty BEFORE navigating so the beforeunload listener
      // doesn't fire on the redirect.
      dirtyRef.current = false;
      const updatedName =
        nameEn !== initial.nameEn && nameEn.length > 0
          ? nameEn
          : initial.nameEn || initial.slug;
      // Pass productUpdatedAt forward via the URL so future debugging is
      // easier; the list page just shows the success flash.
      void data;
      void variables;
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

  const mutation = trpc.products.update.useMutation({
    onSuccess: (data) => {
      // First leg succeeded. Capture the freshly-bumped OCC token from
      // the wire return for the second leg.
      const newUpdatedAt = data?.updatedAt
        ? new Date(data.updatedAt).toISOString()
        : null;
      if (newUpdatedAt) setLiveExpectedUpdatedAt(newUpdatedAt);

      // If categories also changed, fire setCategories with the fresh
      // OCC token. Otherwise we're done — clear dirty + redirect.
      if (selectedCategoryIdsKey !== baselineCategoryIdsKey && newUpdatedAt) {
        setCategoriesMutation.mutate({
          productId: initial.id,
          expectedUpdatedAt: newUpdatedAt,
          categoryIds: selectedCategoryIds,
        });
        return;
      }
      dirtyRef.current = false;
      const updatedName =
        (data?.name as { en: string } | undefined)?.en ?? data?.slug ?? "";
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
      !dirty
    ) {
      return;
    }
    setFieldErrors({});
    setTopError(null);
    setStaleWriteFlash(false);
    setStaleCategoriesFlash(false);

    if (productFieldsChanged()) {
      // Two-leg save: products.update first; on success the update
      // mutation chains into setCategories iff categories also changed.
      mutation.mutate(buildPayload());
      return;
    }
    // Categories-only edit. Skip update; call setCategories directly
    // with the current live OCC token (which equals
    // initial.expectedUpdatedAt because nothing else was saved).
    setCategoriesMutation.mutate({
      productId: initial.id,
      expectedUpdatedAt: liveExpectedUpdatedAt,
      categoryIds: selectedCategoryIds,
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
    !hydrated || mutation.isPending || setCategoriesMutation.isPending || !dirty;
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
