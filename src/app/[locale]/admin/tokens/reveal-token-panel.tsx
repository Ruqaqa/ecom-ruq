/**
 * RevealTokenPanel — shows the plaintext of a freshly-minted PAT exactly
 * once. The parent state machine unmounts this panel on ack, at which
 * point the plaintext string is garbage-collected (no further references
 * survive in state).
 *
 * Copy path (security H-2): ONLY `navigator.clipboard.writeText`. No
 * `execCommand` fallback — that path re-touches the DOM to create a
 * dummy selection + executes a legacy command that can silently fail on
 * mobile WebKit, leaving the user confused. On clipboard rejection we
 * show a "Copy blocked" hint AND pre-select the plaintext inside a
 * readonly input so the user can copy manually.
 *
 * Ack button unmounts the panel; focus on mount goes to Copy so keyboard
 * users don't need to tab past the body text first.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

interface Props {
  plaintext: string;
  tokenPrefix: string;
  name: string;
  onAck: () => void;
}

export function RevealTokenPanel({ plaintext, name, onAck }: Props) {
  const t = useTranslations("admin.tokens.reveal");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">("idle");
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus the copy button on mount — first thing a keyboard user wants
    // to do, and screen readers will announce the heading as they walk in.
    copyBtnRef.current?.focus();
  }, []);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopyState("copied");
    } catch {
      setCopyState("blocked");
      // Pre-select the fallback input for manual copy.
      const el = fallbackInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }

  return (
    <section
      aria-labelledby="token-reveal-heading"
      className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950"
    >
      <h2 id="token-reveal-heading" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      <p className="mt-2 text-sm">{t("body")}</p>
      <p className="mt-3 text-sm font-medium">{name}</p>
      <code
        data-testid="revealed-token-plaintext"
        aria-live="polite"
        className="mt-3 block break-all rounded-md bg-white p-3 font-mono text-sm dark:bg-neutral-950"
      >
        {plaintext}
      </code>
      {copyState === "blocked" ? (
        <input
          ref={fallbackInputRef}
          readOnly
          value={plaintext}
          aria-label={t("heading")}
          className="mt-2 block h-11 w-full rounded-md border border-neutral-300 bg-white px-3 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      ) : null}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button
          ref={copyBtnRef}
          type="button"
          onClick={onCopy}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 text-base font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {copyState === "copied" ? t("copied") : t("copyButton")}
        </button>
        <button
          type="button"
          onClick={onAck}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white px-4 text-base font-medium dark:border-neutral-700 dark:bg-neutral-900"
        >
          {t("ackButton")}
        </button>
      </div>
      {copyState === "blocked" ? (
        <p role="status" className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          {t("copyBlocked")}
        </p>
      ) : null}
    </section>
  );
}
