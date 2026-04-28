/**
 * Admin: edit-category form (chunk 1a.4.2 Block 3; position field
 * removed in 1a.4.2 follow-up).
 *
 * Mirrors `edit-product-form.tsx` for: hydration flag, dirty memo,
 * beforeunload listener, sticky bottom action bar, discard-confirm
 * dialog, stale-write banner with refresh CTA, FORBIDDEN + generic
 * top-error fallbacks, slug-change warning when slug differs from
 * initial.
 *
 * Differences vs edit-product:
 *   - No Remove product affordance — soft-delete UX is 1a.4.3 territory.
 *   - No cost-price field — Tier-B doesn't apply to categories.
 *   - No `↻ slug-sync` button on edit (architect call: editing slug is
 *     destructive enough that we don't help the user generate one).
 *   - Adds the parent picker (single-select, search enabled) with
 *     `excludeIds = [self.id, ...descendantIds]` passed in by the RSC.
 *
 * Position is *not* surfaced on the edit form. The MCP `update_category`
 * tool still accepts an explicit `position` for back-compat with the
 * operator's MCP workflow; in-app reordering happens via the up/down
 * arrows on the categories list page.
 *
 * Sparse update payload: only changed keys go into the mutation. The
 * `parentId` field is special-cased — sending `null` means "make root",
 * sending `undefined` (key absent) means "leave alone". Service
 * contract from 1a.4.1.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  parentId: string | null;
  expectedUpdatedAt: string;
}

interface Props {
  locale: Locale;
  initial: InitialValues;
  categoryOptions: ReadonlyArray<CategoryOption>;
  excludeIds: ReadonlyArray<string>;
}

type FieldErrors = Record<string, string[] | undefined>;

export function EditCategoryForm({
  locale,
  initial,
  categoryOptions,
  excludeIds,
}: Props) {
  const t = useTranslations("admin.categories.edit");
  const tc = useTranslations("admin.categories.create");
  const router = useRouter();
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
  const [parentId, setParentId] = useState<string | null>(initial.parentId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [staleWriteFlash, setStaleWriteFlash] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const optionsById = useMemo(() => {
    const m = new Map<string, CategoryOption>();
    for (const o of categoryOptions) m.set(o.id, o);
    return m;
  }, [categoryOptions]);

  const parentDisplay = parentId
    ? (optionsById.get(parentId)?.fullPath[locale] ?? tc("parentTopLevel"))
    : tc("parentTopLevel");

  const dirty = useMemo<boolean>(() => {
    if (slug !== initial.slug) return true;
    if (nameEn !== initial.nameEn) return true;
    if (nameAr !== initial.nameAr) return true;
    if (descriptionEn !== initial.descriptionEn) return true;
    if (descriptionAr !== initial.descriptionAr) return true;
    if (parentId !== initial.parentId) return true;
    return false;
  }, [
    slug,
    nameEn,
    nameAr,
    descriptionEn,
    descriptionAr,
    parentId,
    initial,
  ]);

  // Browser back / tab close confirmation.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    function handler(e: BeforeUnloadEvent): string | undefined {
      if (!dirtyRef.current) return undefined;
      e.preventDefault();
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

  const mutation = trpc.categories.update.useMutation({
    onSuccess: (data) => {
      dirtyRef.current = false;
      const updatedName =
        (data?.name as { en: string } | undefined)?.en ?? data?.slug ?? "";
      router.push(
        `/${locale}/admin/categories?updatedId=${encodeURIComponent(updatedName)}`,
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
      if (
        err.data?.code === "BAD_REQUEST" &&
        err.message === "parent_not_found"
      ) {
        setTopError(t("parentNotFound"));
        return;
      }
      if (
        err.data?.code === "BAD_REQUEST" &&
        err.message === "category_depth_exceeded"
      ) {
        setTopError(t("depthExceeded"));
        return;
      }
      if (
        err.data?.code === "BAD_REQUEST" &&
        err.message === "category_cycle"
      ) {
        setTopError(t("categoryCycle"));
        return;
      }
      const zodFieldErrors = err.data?.zodError?.fieldErrors as
        | FieldErrors
        | undefined;
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
      if (next.en !== undefined || next.ar !== undefined) {
        payload.name = next;
      }
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
    if (parentId !== initial.parentId) {
      // null = make root; uuid = re-parent. Both are explicit-set
      // (key present) — service contract from 1a.4.1.
      payload.parentId = parentId;
    }
    return payload as Parameters<typeof mutation.mutate>[0];
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (mutation.isPending || !dirty) return;
    setFieldErrors({});
    setTopError(null);
    setStaleWriteFlash(false);
    mutation.mutate(buildPayload());
  }

  function onCancelClick(): void {
    if (dirty) {
      setShowDiscardConfirm(true);
      return;
    }
    router.push(`/${locale}/admin/categories`);
  }

  function onDiscardConfirm(): void {
    dirtyRef.current = false;
    setShowDiscardConfirm(false);
    router.push(`/${locale}/admin/categories`);
  }

  const submitDisabled = !hydrated || mutation.isPending || !dirty;
  const slugChanged = slug !== initial.slug;

  return (
    <form
      className="space-y-4"
      onSubmit={onSubmit}
      noValidate
      data-testid="edit-category-form"
    >
      {staleWriteFlash ? (
        <div
          role="alert"
          data-testid="edit-category-stale-write"
          className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>{t("staleWriteError")}</p>
          <button
            type="button"
            onClick={() => router.refresh()}
            data-testid="edit-category-stale-write-refresh"
            className="mt-2 inline-flex min-h-[44px] items-center rounded-md border border-amber-300 px-3 text-sm font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            {t("staleWriteRefresh")}
          </button>
        </div>
      ) : null}

      {topError ? (
        <p
          role="alert"
          data-testid="edit-category-top-error"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {topError}
        </p>
      ) : null}

      <div className="space-y-4 sm:flex sm:items-start sm:gap-4 sm:space-y-0">
        <div className="sm:w-full sm:max-w-lg">
          <FormField
            id="category-name-en"
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
          id="category-name-ar"
          name="name.ar"
          label={tc("nameAr")}
          value={nameAr}
          onChange={setNameAr}
          required
          errors={fieldErrors["name.ar"]}
        />
        <FormTextarea
          id="category-description-en"
          name="description.en"
          label={tc("descriptionEn")}
          value={descriptionEn}
          onChange={setDescriptionEn}
          errors={fieldErrors["description.en"]}
        />
        <FormTextarea
          id="category-description-ar"
          name="description.ar"
          label={tc("descriptionAr")}
          value={descriptionAr}
          onChange={setDescriptionAr}
          errors={fieldErrors["description.ar"]}
        />

        <div>
          <label
            className="block text-sm font-medium"
            htmlFor="category-parent-trigger"
          >
            {tc("parent")}
          </label>
          <button
            type="button"
            id="category-parent-trigger"
            data-testid="category-parent-trigger"
            onClick={() => setPickerOpen(true)}
            className="mt-1 flex h-11 w-full items-center justify-between rounded-md border border-neutral-300 bg-white px-3 text-start text-base dark:border-neutral-700 dark:bg-neutral-900"
          >
            <span data-testid="category-parent-display">{parentDisplay}</span>
            <span aria-hidden="true">›</span>
          </button>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            {tc("parentHelper")}
          </p>
        </div>
      </div>

      {/* Sticky bottom action bar — Cancel + Save side-by-side, 50/50 on mobile. */}
      <div
        data-testid="edit-category-action-bar"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <div className="mx-auto flex max-w-4xl items-stretch gap-3">
          <button
            type="button"
            onClick={onCancelClick}
            data-testid="edit-category-cancel"
            className="flex h-12 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={submitDisabled}
            data-testid="edit-category-submit"
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
          data-testid="edit-category-discard-confirm"
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
                data-testid="edit-category-discard-confirm-yes"
                className="flex h-11 flex-1 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
              >
                {t("discardConfirm")}
              </button>
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                data-testid="edit-category-discard-confirm-no"
                className="flex h-11 flex-1 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                {t("keepEditing")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CategoryPickerSheet
        open={pickerOpen}
        mode="single"
        selectedIds={parentId ? [parentId] : []}
        categories={categoryOptions}
        excludeIds={excludeIds}
        locale={locale as "en" | "ar"}
        onApply={(next) => {
          setParentId(next[0] ?? null);
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

function FormField({
  id,
  name,
  label,
  value,
  onChange,
  required,
  errors,
}: FieldProps) {
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

function FormTextarea({
  id,
  name,
  label,
  value,
  onChange,
  errors,
}: FieldProps) {
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
        aria-describedby={
          errors && errors.length > 0 ? `${id}-error` : undefined
        }
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
  const serverMessage =
    serverErrors && serverErrors.length > 0 ? serverErrors[0] : null;
  const displayedError = liveMessage ?? serverMessage;

  const describedBy: string[] = ["category-slug-helper"];
  if (slugChanged) describedBy.push("category-slug-change-warning");
  if (displayedError) describedBy.push("category-slug-error");

  return (
    <div>
      <label htmlFor="category-slug" className="block text-sm font-medium">
        {labels.label}
      </label>
      <div className="mt-1 flex items-start gap-2">
        <input
          id="category-slug"
          data-testid="category-slug"
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
        id="category-slug-helper"
        className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
      >
        {labels.helper}
      </p>
      {slugChanged ? (
        <p
          id="category-slug-change-warning"
          data-testid="category-slug-change-warning"
          className="mt-1 text-xs text-amber-700 dark:text-amber-400"
        >
          {slugChangeWarning}
        </p>
      ) : null}
      {displayedError ? (
        <p
          id="category-slug-error"
          role="alert"
          className="mt-1 text-sm text-red-700 dark:text-red-400"
        >
          {displayedError}
        </p>
      ) : null}
    </div>
  );
}
