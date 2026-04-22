/**
 * Client-side PAT management state machine (sub-chunk 7.5).
 *
 * MUST NOT be converted to a server action or server-component form.
 * Plaintext must never leave the client-side mutation result; routing
 * through server actions serializes it into the RSC payload and network
 * traffic. If a future refactor wants to move this server-side, revisit
 * ADR 0001 and the 7.5 security review first.
 *
 * State:
 *   - list query (paused while reveal is mounted — one read path at a time)
 *   - create-form visibility
 *   - revealedToken: the plaintext of a just-minted PAT (nullable)
 *   - revokeTarget: { id, name } of a row the user is confirming revoke for
 *
 * Role branching:
 *   - owner: sees everything (list + create + revoke).
 *   - staff: sees list ONLY. No create button, no revoke action. The
 *     server-side role gate still holds even if the UI is bypassed
 *     (tokens.create / tokens.revoke both require 'owner').
 */
"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/routing";
import { trpc } from "@/lib/trpc/client";
import { CreateTokenForm } from "./create-token-form";
import { RevealTokenPanel } from "./reveal-token-panel";
import { RevokeConfirmDialog } from "./revoke-confirm-dialog";

export type ViewerRole = "owner" | "staff";

interface Props {
  locale: Locale;
  viewerRole: ViewerRole;
}

export interface MintedTokenView {
  plaintext: string;
  tokenPrefix: string;
  name: string;
}

export function TokensClient({ viewerRole }: Props) {
  void (undefined as unknown as Locale); // keep `locale` typed in signature for future i18n-aware URL building
  const t = useTranslations("admin.tokens");
  const format = useFormatter();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [revealed, setRevealed] = useState<MintedTokenView | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  // Pause list query while the reveal panel is mounted: a refetch after
  // a successful create would flash the row before the user copies the
  // plaintext. Re-enable on ack/unmount.
  const listQuery = trpc.tokens.list.useQuery(undefined, {
    enabled: revealed === null,
    refetchOnWindowFocus: false,
  });

  const utils = trpc.useUtils();

  function onMintSuccess(minted: MintedTokenView): void {
    setRevealed(minted);
    setShowCreateForm(false);
  }

  function onAck(): void {
    setRevealed(null);
    // Re-fetch the list now that we have a new row.
    void utils.tokens.list.invalidate();
  }

  const revokeMutation = trpc.tokens.revoke.useMutation({
    onSettled: () => {
      void utils.tokens.list.invalidate();
    },
  });

  function onRevokeConfirm(): void {
    if (!revokeTarget) return;
    const id = revokeTarget.id;
    setRevokeTarget(null);
    revokeMutation.mutate({ tokenId: id, confirm: true });
  }

  if (revealed) {
    return (
      <RevealTokenPanel
        plaintext={revealed.plaintext}
        tokenPrefix={revealed.tokenPrefix}
        name={revealed.name}
        onAck={onAck}
      />
    );
  }

  return (
    <div className="space-y-6">
      {viewerRole === "owner" ? (
        <div>
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="flex h-11 min-w-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-base font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {t("newButton")}
            </button>
          ) : (
            <CreateTokenForm
              onSuccess={onMintSuccess}
              onCancel={() => setShowCreateForm(false)}
            />
          )}
        </div>
      ) : null}

      <section aria-labelledby="active-tokens-heading">
        <h2 id="active-tokens-heading" className="text-lg font-medium">
          {t("listHeading")}
        </h2>
        {listQuery.isLoading ? (
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">{t("loading")}</p>
        ) : (listQuery.data ?? []).length === 0 ? (
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">{t("empty")}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {(listQuery.data ?? []).map((row) => (
              <li
                key={row.id}
                className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium">{row.name}</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      <span>{row.tokenPrefix}</span>
                      <span className="mx-2">·</span>
                      <span>{t(`role${capitalize(row.scopes.role)}` as Parameters<typeof t>[0])}</span>
                      {row.scopes.tools && row.scopes.tools.length > 0 ? (
                        <>
                          <span className="mx-2">·</span>
                          <span>{t("experimentalBadge")}</span>
                        </>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      <span>
                        {t("columns.lastUsed")}
                        {": "}
                        {row.lastUsedAt
                          ? format.dateTime(row.lastUsedAt, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : t("lastUsedNever")}
                      </span>
                      <span className="mx-2">·</span>
                      <span>
                        {t("columns.expires")}
                        {": "}
                        {row.expiresAt
                          ? format.dateTime(row.expiresAt, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : t("neverExpires")}
                      </span>
                    </p>
                  </div>
                  {viewerRole === "owner" ? (
                    <button
                      type="button"
                      onClick={() => setRevokeTarget({ id: row.id, name: row.name })}
                      className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-red-300 px-4 text-sm font-medium text-red-700 dark:border-red-700 dark:text-red-400"
                    >
                      {t("revokeButton")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revokeTarget ? (
        <RevokeConfirmDialog
          name={revokeTarget.name}
          onConfirm={onRevokeConfirm}
          onCancel={() => setRevokeTarget(null)}
        />
      ) : null}
    </div>
  );
}

function capitalize<T extends string>(s: T): Capitalize<T> {
  return (s.charAt(0).toUpperCase() + s.slice(1)) as Capitalize<T>;
}
