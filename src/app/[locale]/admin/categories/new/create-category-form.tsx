/**
 * Admin: create-category form (chunk 1a.4.2 Block 2).
 *
 * Mirrors `create-product-form.tsx` for the slug auto-derive + sync,
 * inline-error pattern, and forbidden / generic top-error fallbacks.
 *
 * Adds:
 *   - parent picker via the shared `<CategoryPickerSheet mode="single" />`,
 *   - position number field,
 *   - server-error mapping for `parent_not_found` and
 *     `category_depth_exceeded` from the service layer.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { trpc } from "@/lib/trpc/client";
import {
  SLUG_MAX,
  slugify,
  validateSlug,
  type SlugValidationError,
} from "@/lib/product-slug";
import type { CategoryOption } from "@/lib/categories/build-category-options";
import { CategoryPickerSheet } from "@/components/admin/category-picker-sheet";

interface Props {
  locale: Locale;
  categoryOptions: ReadonlyArray<CategoryOption>;
}

type FieldErrors = Record<string, string[] | undefined>;

export function CreateCategoryForm({
  locale,
  categoryOptions,
}: Props) {
  const t = useTranslations("admin.categories.create");
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [descriptionAr, setDescriptionAr] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [slugError, setSlugError] = useState<SlugValidationError | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [position, setPosition] = useState<string>("0");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);

  const optionsById = useMemo(() => {
    const m = new Map<string, CategoryOption>();
    for (const o of categoryOptions) m.set(o.id, o);
    return m;
  }, [categoryOptions]);

  const parentDisplay = parentId
    ? (optionsById.get(parentId)?.fullPath[locale] ?? t("parentTopLevel"))
    : t("parentTopLevel");

  function onNameEnChange(next: string): void {
    setNameEn(next);
    if (!slugDirty) {
      const derived = slugify(next);
      setSlug(derived);
      setSlugError(derived.length === 0 ? null : validateSlug(derived));
    }
  }

  function onSlugChange(next: string): void {
    setSlug(next);
    setSlugDirty(true);
    setSlugError(next.length === 0 ? null : validateSlug(next));
  }

  function onSyncFromName(): void {
    const derived = slugify(nameEn);
    setSlug(derived);
    setSlugDirty(false);
    setSlugError(derived.length === 0 ? null : validateSlug(derived));
  }

  const mutation = trpc.categories.create.useMutation({
    onSuccess: (data) => {
      const display =
        (data?.name as { en?: string } | undefined)?.en ??
        data?.slug ??
        "";
      router.push(
        `/${locale}/admin/categories?createdId=${encodeURIComponent(display)}`,
      );
    },
    onError: (err) => {
      setFieldErrors({});
      setTopError(null);
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
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

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (mutation.isPending) return;
    setFieldErrors({});
    setTopError(null);
    const description =
      descriptionEn.length > 0 || descriptionAr.length > 0
        ? {
            ...(descriptionEn.length > 0 ? { en: descriptionEn } : {}),
            ...(descriptionAr.length > 0 ? { ar: descriptionAr } : {}),
          }
        : undefined;
    const positionNum = Number.parseInt(position, 10);
    mutation.mutate({
      slug,
      name: { en: nameEn, ar: nameAr },
      ...(description !== undefined ? { description } : {}),
      parentId,
      position: Number.isFinite(positionNum) && positionNum >= 0 ? positionNum : 0,
    });
  }

  const submitDisabled = !hydrated || mutation.isPending;

  return (
    <form
      className="space-y-4"
      onSubmit={onSubmit}
      noValidate
      data-testid="create-category-form"
    >
      {topError ? (
        <p
          role="alert"
          data-testid="create-category-top-error"
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
            label={t("nameEn")}
            value={nameEn}
            onChange={onNameEnChange}
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
            liveError={slugError}
            serverErrors={fieldErrors["slug"]}
            onSlugChange={onSlugChange}
            onSyncFromName={onSyncFromName}
            labels={{
              label: t("slug"),
              helper: t("slugHelper"),
              syncAriaLabel: t("slugSyncAriaLabel"),
              errorMessages: {
                empty: t("slugError.empty"),
                too_long: t("slugError.too_long"),
                invalid_chars: t("slugError.invalid_chars"),
                leading_hyphen: t("slugError.leading_hyphen"),
                trailing_hyphen: t("slugError.trailing_hyphen"),
                consecutive_hyphens: t("slugError.consecutive_hyphens"),
              },
            }}
          />
        </div>
      </div>

      <div className="space-y-4 sm:max-w-lg">
        <FormField
          id="category-name-ar"
          name="name.ar"
          label={t("nameAr")}
          value={nameAr}
          onChange={setNameAr}
          required
          errors={fieldErrors["name.ar"]}
        />
        <FormTextarea
          id="category-description-en"
          name="description.en"
          label={t("descriptionEn")}
          value={descriptionEn}
          onChange={setDescriptionEn}
          errors={fieldErrors["description.en"]}
        />
        <FormTextarea
          id="category-description-ar"
          name="description.ar"
          label={t("descriptionAr")}
          value={descriptionAr}
          onChange={setDescriptionAr}
          errors={fieldErrors["description.ar"]}
        />

        {/* Parent picker. Trigger button opens the shared sheet in
            single-select mode. Display element is the localized full
            path (or the "(top-level)" placeholder when null). */}
        <div>
          <label className="block text-sm font-medium" htmlFor="category-parent-trigger">
            {t("parent")}
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
            {t("parentHelper")}
          </p>
        </div>

        <div>
          <label htmlFor="category-position" className="block text-sm font-medium">
            {t("position")}
          </label>
          <input
            id="category-position"
            data-testid="category-position"
            name="position"
            type="number"
            inputMode="numeric"
            min={0}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
            aria-describedby="category-position-helper"
          />
          <p
            id="category-position-helper"
            className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
          >
            {t("positionHelper")}
          </p>
        </div>

        <button
          type="submit"
          disabled={submitDisabled}
          data-testid="create-category-submit"
          className="flex h-11 w-full items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {t("submit")}
        </button>
      </div>

      <CategoryPickerSheet
        open={pickerOpen}
        mode="single"
        searchable={false}
        selectedIds={parentId ? [parentId] : []}
        categories={categoryOptions}
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
  liveError: SlugValidationError | null;
  serverErrors: string[] | undefined;
  onSlugChange: (v: string) => void;
  onSyncFromName: () => void;
  labels: {
    label: string;
    helper: string;
    syncAriaLabel: string;
    errorMessages: Record<SlugValidationError, string>;
  };
}

function SlugField({
  slug,
  liveError,
  serverErrors,
  onSlugChange,
  onSyncFromName,
  labels,
}: SlugFieldProps) {
  const liveMessage = liveError ? labels.errorMessages[liveError] : null;
  const serverMessage =
    serverErrors && serverErrors.length > 0 ? serverErrors[0] : null;
  const displayedError = liveMessage ?? serverMessage;

  const describedBy: string[] = ["category-slug-helper"];
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
        <button
          type="button"
          onClick={onSyncFromName}
          data-testid="category-slug-sync"
          aria-label={labels.syncAriaLabel}
          title={labels.syncAriaLabel}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-neutral-300 bg-white text-base dark:border-neutral-700 dark:bg-neutral-900"
        >
          ↻
        </button>
      </div>
      <p
        id="category-slug-helper"
        className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
      >
        {labels.helper}
      </p>
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
