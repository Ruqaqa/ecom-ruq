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
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [descriptionAr, setDescriptionAr] = useState("");
  const [status, setStatus] = useState<"draft" | "active">("draft");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);

  const mutation = trpc.products.create.useMutation({
    onSuccess: (data) => {
      router.push(`/${locale}/admin/products?createdId=${data.id}`);
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

      <FormField
        id="product-slug"
        name="slug"
        label={t("slug")}
        value={slug}
        onChange={setSlug}
        required
        pattern="[a-z0-9-]+"
        helper={t("slugHelper")}
        errors={fieldErrors["slug"]}
      />
      <FormField
        id="product-name-en"
        name="name.en"
        label={t("nameEn")}
        value={nameEn}
        onChange={setNameEn}
        required
        errors={fieldErrors["name.en"] ?? fieldErrors["name"]}
      />
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
