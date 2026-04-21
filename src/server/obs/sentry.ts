/**
 * Minimal Sentry shim.
 *
 * Sentry initialization is a Phase 0 prereq that has not landed yet
 * (prd.md §0 — account + DSN deferred). Call sites already exist —
 * chiefly the audit-wrap failure path, which logs `audit_write_failure`
 * when a best-effort failure audit cannot itself be persisted. Rather
 * than sprinkle TODOs, we route through this shim now and swap the body
 * for the real `@sentry/node` client in one edit later.
 *
 * Unit tests inject a spy via `__setSentryForTests` — never via module
 * mocking — so the public API matches what the real client will offer.
 */
export interface SentryLike {
  captureMessage(
    name: string,
    options?: {
      level?: "error" | "warning" | "info";
      tags?: Record<string, string | undefined>;
      extra?: Record<string, unknown>;
    },
  ): void;
}

const consoleSentry: SentryLike = {
  captureMessage(name, options) {
    // Structured single-line log so a future tail/jq pipeline can parse it.
    // Real Sentry will replace this entirely.
    console.error(
      JSON.stringify({
        sentry: name,
        level: options?.level ?? "error",
        tags: options?.tags ?? {},
        extra: options?.extra ?? {},
      }),
    );
  },
};

let override: SentryLike | null = null;

export function captureMessage(...args: Parameters<SentryLike["captureMessage"]>): void {
  (override ?? consoleSentry).captureMessage(...args);
}

/** Test-only seam. Pass null to restore the console-backed default. */
export function __setSentryForTests(s: SentryLike | null): void {
  override = s;
}
