/**
 * Vitest setup: load `.env.local` before any test module imports run.
 *
 * Vitest doesn't auto-load `.env.local` the way `next dev` does, so tests
 * that exercise real DB / crypto paths (audit writer, withTenant, envelope
 * encryption) silently see `DATABASE_URL_APP`/`HASH_PEPPER`/`DATA_KEK_BASE64`
 * as undefined when invoked from a fresh shell. The result reads like a
 * code bug — callers that gate on `if (!appDb) return` no-op, and failure
 * assertions fire from the wrong cause.
 *
 * This file is a vitest `setupFiles` entry (see vitest.config.ts). It runs
 * once per worker, before test file evaluation, so module-scope `appDb =
 * appClient ? drizzle(...) : null` sees the populated env.
 *
 * `dotenv` already ships as a dev dep (scripts/db-migrate.ts uses it).
 * `path` is repo-root-relative — vitest's cwd is the repo root.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
