/**
 * Admin: create-product form.
 *
 * Thin wrapper around `trpc.products.create.useMutation()`. Form is a
 * real `<form>` with `onSubmit`-only per the chunk-5 forms invariant
 * (see docs/runbooks/auth.md). No `onClick` on the submit button —
 * that caused WebKit double-fire + password-manager regressions.
 *
 * Error display:
 *   - Zod field errors surface inline beneath the offending input
 *     (we match `error.data.zodError.fieldErrors` — tRPC's standard
 *     shape when `.input(zodSchema)` rejects).
 *   - TRPCError FORBIDDEN surfaces as a top-level banner ("you don't
 *     have permission") — for a customer-role caller who somehow
 *     reached the form without being redirected by the admin layout
 *     guard (e.g. client-side route push that bypassed RSC).
 *   - Any other error: generic message.
 *
 * The server-side admin layout redirects anonymous/customer callers
 * BEFORE this component renders; this client-side guard is belt-and-
 * braces.
 */
"use client";

import { useEffect, useState } from "react";
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

interface Props {
  locale: Locale;
}

type FieldErrors = Record<string, string[] | undefined>;

export function CreateProductForm({ locale }: Props) {
  const t = useTranslations("admin.products.create");
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const [slug, setSlug] = useState("");
  // `slugDirty` flips true the moment the user edits the slug input
  // manually. While false, changes to name.en re-derive the slug via
  // `slugify`; after the user has touched the field, we stop auto-
  // writing to preserve their edit. The sync button resets dirty.
  const [slugDirty, setSlugDirty] = useState(false);
  const [slugError, setSlugError] = useState<SlugValidationError | null>(null);
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [descriptionAr, setDescriptionAr] = useState("");
  const [status, setStatus] = useState<"draft" | "active">("draft");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);

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

  const mutation = trpc.products.create.useMutation({
    onSuccess: (data) => {
      // Land on the edit page directly. The owner's natural next action
      // after creating a product is filling in variants, options,
      // categories, and photos — all of which live on the edit page.
      // Routing back to the list with a flash banner forced them to
      // re-find the row they just created.
      router.push(`/${locale}/admin/products/${data.id}`);
    },
    onError: (err) => {
      setFieldErrors({});
      setTopError(null);
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("forbidden"));
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
    mutation.mutate({
      slug,
      name: { en: nameEn, ar: nameAr },
      ...(description !== undefined ? { description } : {}),
      status,
    });
  }

  const submitDisabled = !hydrated || mutation.isPending;

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {topError ? (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">
          {topError}
        </p>
      ) : null}

      <div className="space-y-4 sm:flex sm:items-start sm:gap-4 sm:space-y-0">
        <div className="sm:w-full sm:max-w-lg">
          <FormField
            id="product-name-en"
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
          id="product-name-ar"
          name="name.ar"
          label={t("nameAr")}
          value={nameAr}
          onChange={setNameAr}
          required
          errors={fieldErrors["name.ar"]}
        />
        <FormTextarea
          id="product-description-en"
          name="description.en"
          label={t("descriptionEn")}
          value={descriptionEn}
          onChange={setDescriptionEn}
          errors={fieldErrors["description.en"]}
        />
        <FormTextarea
          id="product-description-ar"
          name="description.ar"
          label={t("descriptionAr")}
          value={descriptionAr}
          onChange={setDescriptionAr}
          errors={fieldErrors["description.ar"]}
        />

        <div>
          <label htmlFor="product-status" className="block text-sm font-medium">
            {t("status")}
          </label>
          <select
            id="product-status"
            name="status"
            value={status}
            onChange={(e) => setStatus(e.target.value === "active" ? "active" : "draft")}
            className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="draft">{t("statusDraft")}</option>
            <option value="active">{t("statusActive")}</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={submitDisabled}
          className="flex h-11 w-full items-center justify-center rounded-md bg-neutral-900 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {t("submit")}
        </button>
      </div>
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
  pattern?: string;
  helper?: string;
  errors?: string[] | undefined;
}

function FormField({ id, name, label, value, onChange, required, pattern, helper, errors }: FieldProps) {
  const describedByIds: string[] = [];
  if (helper) describedByIds.push(`${id}-helper`);
  if (errors && errors.length > 0) describedByIds.push(`${id}-error`);
  const describedBy = describedByIds.length > 0 ? describedByIds.join(" ") : undefined;
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
        pattern={pattern}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors && errors.length > 0 ? true : undefined}
        aria-describedby={describedBy}
        className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-900"
      />
      {helper ? (
        <p id={`${id}-helper`} className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {helper}
        </p>
      ) : null}
      {errors && errors.length > 0 ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
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
        <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
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

/**
 * Slug input composition: text input + sync-from-name button (↻), plus
 * live shape validation via `validateSlug`. Server Zod remains
 * authoritative — any validation that gets past live checks is
 * re-validated server-side and surfaces via `serverErrors`. Live
 * error takes precedence over server error while the user types.
 */
function SlugField({
  slug,
  liveError,
  serverErrors,
  onSlugChange,
  onSyncFromName,
  labels,
}: SlugFieldProps) {
  const liveMessage = liveError ? labels.errorMessages[liveError] : null;
  const serverMessage = serverErrors && serverErrors.length > 0 ? serverErrors[0] : null;
  const displayedError = liveMessage ?? serverMessage;

  const describedBy: string[] = ["product-slug-helper"];
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
          aria-label={labels.syncAriaLabel}
          title={labels.syncAriaLabel}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-neutral-300 bg-white text-base dark:border-neutral-700 dark:bg-neutral-900"
        >
          ↻
        </button>
      </div>
      <p id="product-slug-helper" className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        {labels.helper}
      </p>
      {displayedError ? (
        <p id="product-slug-error" role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
          {displayedError}
        </p>
      ) : null}
    </div>
  );
}
