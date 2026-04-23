/**
 * CreateTokenForm — mints a PAT and surfaces plaintext via props to the
 * parent state machine. The parent renders the RevealTokenPanel; this
 * form only owns the mint interaction.
 *
 * Inputs:
 *   - name (required, max 120)
 *   - expiresInDays (7 / 30 / 90 / 365 preset)
 *   - scope role (owner / staff / support)
 *   - ownerScopeConfirm (required if role=owner; S-1)
 *   - experimental tools disclosure (checkbox list — security H-1)
 *   - experimentalToolsConfirm (required if any tool is checked; H-4)
 *
 * Error handling mirrors the create-product form:
 *   - Zod field errors render inline under the offending control.
 *   - TRPCError FORBIDDEN surfaces as a top-level banner.
 *   - TOO_MANY_REQUESTS → dedicated rate-limit message.
 *   - Any other error → generic message.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import type { MintedTokenView } from "./tokens-client";

type FieldErrors = Record<string, string[] | undefined>;

type ScopeRole = "owner" | "staff" | "support";
type ExpiryPreset = "7" | "30" | "90" | "365";
type ExperimentalTool = "run_sql_readonly";
const EXPERIMENTAL_TOOLS: ReadonlyArray<ExperimentalTool> = ["run_sql_readonly"];

interface Props {
  onSuccess: (minted: MintedTokenView) => void;
  onCancel: () => void;
}

export function CreateTokenForm({ onSuccess, onCancel }: Props) {
  const t = useTranslations("admin.tokens.create");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<ExpiryPreset>("90");
  const [scopeRole, setScopeRole] = useState<ScopeRole>("staff");
  const [ownerScopeConfirm, setOwnerScopeConfirm] = useState(false);
  const [toolsChecked, setToolsChecked] = useState<Record<ExperimentalTool, boolean>>({
    run_sql_readonly: false,
  });
  const [experimentalConfirm, setExperimentalConfirm] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);

  const selectedTools = EXPERIMENTAL_TOOLS.filter((t) => toolsChecked[t]);

  const mutation = trpc.tokens.create.useMutation({
    onSuccess: (data) => {
      onSuccess({
        plaintext: data.plaintext,
        tokenPrefix: data.tokenPrefix,
        name: data.name,
      });
    },
    onError: (err) => {
      setFieldErrors({});
      setTopError(null);
      if (err.data?.code === "FORBIDDEN" || err.data?.code === "UNAUTHORIZED") {
        setTopError(t("errorForbidden"));
        return;
      }
      if (err.data?.code === "TOO_MANY_REQUESTS") {
        setTopError(t("errorRateLimited"));
        return;
      }
      const zodFieldErrors = err.data?.zodError?.fieldErrors as FieldErrors | undefined;
      if (zodFieldErrors) {
        setFieldErrors(zodFieldErrors);
        setTopError(t("errorValidation"));
        return;
      }
      setTopError(t("errorGeneric"));
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (mutation.isPending) return;
    setFieldErrors({});
    setTopError(null);

    const expiresMs = Number(expiresInDays) * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + expiresMs);
    const scopes: { role: ScopeRole; tools?: ExperimentalTool[] } = { role: scopeRole };
    if (selectedTools.length > 0) scopes.tools = selectedTools;

    const payload: Record<string, unknown> = { name, scopes, expiresAt };
    if (scopeRole === "owner" && ownerScopeConfirm) payload.ownerScopeConfirm = true;
    if (selectedTools.length > 0 && experimentalConfirm) {
      payload.experimentalToolsConfirm = true;
    }
    // Local quick-guards: if required confirm flags are missing, short-
    // circuit with a synthetic field error rather than spending a server
    // round-trip. The server still enforces via Zod — these are for UX.
    const localErrors: FieldErrors = {};
    if (scopeRole === "owner" && !ownerScopeConfirm) {
      localErrors.ownerScopeConfirm = ["required"];
    }
    if (selectedTools.length > 0 && !experimentalConfirm) {
      localErrors.experimentalToolsConfirm = ["required"];
    }
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      setTopError(t("errorValidation"));
      return;
    }

    mutation.mutate(payload as Parameters<typeof mutation.mutate>[0]);
  }

  const submitDisabled = !hydrated || mutation.isPending;

  return (
    <form className="space-y-5 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900" onSubmit={onSubmit} noValidate>
      <h2 className="text-lg font-semibold">{t("heading")}</h2>

      {topError ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-400"
        >
          {topError}
        </p>
      ) : null}

      <div>
        <label htmlFor="token-name" className="block text-sm font-medium">
          {t("nameLabel")}
        </label>
        <input
          id="token-name"
          name="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldErrors.name && fieldErrors.name.length > 0 ? true : undefined}
          aria-describedby={
            fieldErrors.name && fieldErrors.name.length > 0 ? "token-name-error" : "token-name-helper"
          }
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
        />
        <p id="token-name-helper" className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {t("nameHelper")}
        </p>
        {fieldErrors.name && fieldErrors.name.length > 0 ? (
          <p id="token-name-error" role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
            {fieldErrors.name[0]}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="token-expires" className="block text-sm font-medium">
          {t("expiresLabel")}
        </label>
        <select
          id="token-expires"
          name="expiresInDays"
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value as ExpiryPreset)}
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="7">{t("expires7")}</option>
          <option value="30">{t("expires30")}</option>
          <option value="90">{t("expires90")}</option>
          <option value="365">{t("expires365")}</option>
        </select>
      </div>

      <div>
        <label htmlFor="token-scope-role" className="block text-sm font-medium">
          {t("scopeRoleLabel")}
        </label>
        <select
          id="token-scope-role"
          name="scopeRole"
          value={scopeRole}
          onChange={(e) => {
            // L-3 (7.6.6): reset the owner-consent checkbox on every
            // role change. Otherwise a user who ticked "confirm owner",
            // switched away, and switched back would carry stale
            // consent forward — server Zod still re-enforces, but the
            // click happened at a prior moment. Clear on every change.
            setScopeRole(e.target.value as ScopeRole);
            setOwnerScopeConfirm(false);
          }}
          aria-describedby="token-scope-role-helper"
          className="mt-1 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-base dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="owner">owner</option>
          <option value="staff">staff</option>
          <option value="support">support</option>
        </select>
        <p id="token-scope-role-helper" className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {t("scopeRoleHelper")}
        </p>
      </div>

      {scopeRole === "owner" ? (
        <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="ownerScopeConfirm"
              checked={ownerScopeConfirm}
              onChange={(e) => setOwnerScopeConfirm(e.target.checked)}
              aria-invalid={
                fieldErrors.ownerScopeConfirm && fieldErrors.ownerScopeConfirm.length > 0
                  ? true
                  : undefined
              }
              aria-describedby={
                fieldErrors.ownerScopeConfirm && fieldErrors.ownerScopeConfirm.length > 0
                  ? "token-owner-confirm-error"
                  : "token-owner-confirm-helper"
              }
              className="mt-1 h-5 w-5"
            />
            <span className="text-sm">{t("ownerScopeConfirmLabel")}</span>
          </label>
          <p
            id="token-owner-confirm-helper"
            className="ms-8 mt-1 text-xs text-neutral-600 dark:text-neutral-400"
          >
            {t("ownerScopeConfirmHelper")}
          </p>
          {fieldErrors.ownerScopeConfirm && fieldErrors.ownerScopeConfirm.length > 0 ? (
            <p
              id="token-owner-confirm-error"
              role="alert"
              className="ms-8 mt-1 text-sm text-red-700 dark:text-red-400"
            >
              {t("errorValidation")}
            </p>
          ) : null}
        </div>
      ) : null}

      <details className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <summary className="cursor-pointer select-none text-sm font-medium">
          {t("experimentalSummary")}
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {t("experimentalDescription")}
          </p>
          {EXPERIMENTAL_TOOLS.map((tool) => (
            <label key={tool} className="flex items-start gap-3">
              <input
                type="checkbox"
                name={`tool-${tool}`}
                checked={toolsChecked[tool] ?? false}
                onChange={(e) =>
                  setToolsChecked((prev) => ({ ...prev, [tool]: e.target.checked }))
                }
                className="mt-1 h-5 w-5"
              />
              <span className="text-sm">{t(`toolLabels.${tool}` as "toolLabels.run_sql_readonly")}</span>
            </label>
          ))}
          {selectedTools.length > 0 ? (
            <div>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="experimentalToolsConfirm"
                  checked={experimentalConfirm}
                  onChange={(e) => setExperimentalConfirm(e.target.checked)}
                  aria-invalid={
                    fieldErrors.experimentalToolsConfirm &&
                    fieldErrors.experimentalToolsConfirm.length > 0
                      ? true
                      : undefined
                  }
                  aria-describedby={
                    fieldErrors.experimentalToolsConfirm &&
                    fieldErrors.experimentalToolsConfirm.length > 0
                      ? "token-experimental-confirm-error"
                      : "token-experimental-confirm-helper"
                  }
                  className="mt-1 h-5 w-5"
                />
                <span className="text-sm">{t("experimentalToolsConfirmLabel")}</span>
              </label>
              <p
                id="token-experimental-confirm-helper"
                className="ms-8 mt-1 text-xs text-neutral-600 dark:text-neutral-400"
              >
                {t("experimentalToolsConfirmHelper")}
              </p>
              {fieldErrors.experimentalToolsConfirm &&
              fieldErrors.experimentalToolsConfirm.length > 0 ? (
                <p
                  id="token-experimental-confirm-error"
                  role="alert"
                  className="ms-8 mt-1 text-sm text-red-700 dark:text-red-400"
                >
                  {t("errorValidation")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitDisabled}
          className="flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-neutral-900 px-4 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {t("submit")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-base dark:border-neutral-700 dark:bg-neutral-900"
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
