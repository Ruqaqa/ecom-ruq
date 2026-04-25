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
}

type FieldErrors = Record<string, string[] | undefined>;

export function EditProductForm({ locale, initial }: Props) {
  const t = useTranslations("admin.products.edit");
  const tc = useTranslations("admin.products.create");
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
  const [status, setStatus] = useState<"draft" | "active">(initial.status);
  // costPriceMinor is owner-only — the form receives it iff the
  // role-gated DTO exposed it (RSC page passes it through). For staff
  // the prop is undefined and we never render the field.
  const initialHasCostPrice = "costPriceMinor" in initial;
  const [costPriceText, setCostPriceText] = useState<string>(
    initialHasCostPrice && initial.costPriceMinor != null
      ? (initial.costPriceMinor / 100).toFixed(2)
      : "",
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [staleWriteFlash, setStaleWriteFlash] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Dirty state — deep equality vs the initial values.
  const dirty = useMemo<boolean>(() => {
    if (slug !== initial.slug) return true;
    if (nameEn !== initial.nameEn) return true;
    if (nameAr !== initial.nameAr) return true;
    if (descriptionEn !== initial.descriptionEn) return true;
    if (descriptionAr !== initial.descriptionAr) return true;
    if (status !== initial.status) return true;
    if (initialHasCostPrice) {
      const initialText =
        initial.costPriceMinor != null
          ? (initial.costPriceMinor / 100).toFixed(2)
          : "";
      if (costPriceText !== initialText) return true;
    }
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

  const mutation = trpc.products.update.useMutation({
    onSuccess: (data) => {
      // Clear dirty BEFORE navigating so the beforeunload listener
      // doesn't fire on the redirect.
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
    if (initialHasCostPrice) {
      const initialText =
        initial.costPriceMinor != null
          ? (initial.costPriceMinor / 100).toFixed(2)
          : "";
      if (costPriceText !== initialText) {
        if (costPriceText.length === 0) {
          payload.costPriceMinor = null;
        } else {
          const sar = Number.parseFloat(costPriceText);
          payload.costPriceMinor = Number.isFinite(sar)
            ? Math.round(sar * 100)
            : null;
        }
      }
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
    router.push(`/${locale}/admin/products`);
  }

  function onDiscardConfirm(): void {
    dirtyRef.current = false;
    setShowDiscardConfirm(false);
    router.push(`/${locale}/admin/products`);
  }

  const submitDisabled = !hydrated || mutation.isPending || !dirty;
  const slugChanged = slug !== initial.slug;

  return (
    <form
      className="space-y-4"
      onSubmit={onSubmit}
      noValidate
      data-testid="edit-product-form"
    >
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

      {/* Hidden link for tests / a11y fallback in case JS fails — Cancel
          button uses router.push, so this is belt-and-braces. */}
      <Link
        href={`/${locale}/admin/products`}
        className="sr-only"
        data-testid="edit-product-cancel-link"
      >
        {t("cancel")}
      </Link>
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
