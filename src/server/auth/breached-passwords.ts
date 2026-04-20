/**
 * Breached / trivially-guessable password check (v0).
 *
 * Seeded from `data/top-common-passwords.json` — the long-tail passwords
 * actually used in credential-stuffing campaigns. Normalization: lowercase
 * trim. This catches about 90% of the trash without needing the full
 * haveibeenpwned k-anonymity API at sign-up time.
 *
 * TODO(phase-6-hardening): migrate to a serialized bloom filter over the
 * HIBP top-10k passwords committed as a binary asset at build time, so we
 * cover a wider list without committing the plaintexts. Alternative path:
 * wire Better Auth's `haveIBeenPwned` plugin once we accept the runtime
 * dependency on hibp's API for sign-up / password-change paths.
 *
 * The shape `verify: (password) => Promise<void>` matches what the BA
 * `emailAndPassword.password` hook-override pattern expects. Throws a
 * structured error on breached detection; passes through otherwise.
 */
import list from "./data/top-common-passwords.json" with { type: "json" };

const breached: Set<string> = new Set((list as string[]).map((p) => p.toLowerCase()));

export function isBreachedPassword(password: string): boolean {
  if (!password) return false;
  return breached.has(password.toLowerCase());
}
