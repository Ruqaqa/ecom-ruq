/**
 * Boot-time and request-time safety guards for real production deployments.
 *
 * "Real production" is distinct from Next.js's `NODE_ENV=production`. The
 * latter is set by `next build` / `next start` — which ALSO runs under the
 * Playwright e2e harness (per CLAUDE.md §1; dev-mode HMR cancels in-flight
 * test navigations on WebKit). We use `APP_ENV` as the deployment-target
 * signal, matching the existing convention in
 * `src/server/auth/rate-limit-auth-hook.ts` and `src/server/auth/audit-hooks.ts`.
 *
 * Real production = `NODE_ENV === "production"` AND `APP_ENV` is NOT in
 * `{"e2e", "seed"}`. Dev (`pnpm dev`) is `NODE_ENV=development` and
 * self-excludes.
 *
 * Guards are deliberately written as free-standing functions (no class,
 * no singleton). Boot-time guards run from `src/instrumentation.ts`;
 * request-time guard (`assertProxyHeaderPresent`) runs from
 * `src/middleware.ts` and `src/server/auth/rate-limit-auth-hook.ts`.
 *
 * All guards throw `ProductionGuardError` with a stable `code` so callers
 * can map to the right transport (503 response body, APIError code, etc.)
 * without regex-matching the message.
 */

const NON_PRODUCTION_APP_ENVS = new Set(["e2e", "seed"]);

export function isRealProduction(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  const appEnv = process.env.APP_ENV;
  if (appEnv && NON_PRODUCTION_APP_ENVS.has(appEnv)) return false;
  return true;
}

export class ProductionGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductionGuardError";
    this.code = code;
  }
}

/**
 * Env flags that MUST NOT be set to their dangerous values in real production.
 * `APP_ENV=e2e|seed` is intentionally NOT in this list: those values are the
 * self-escape-hatch (they flip `isRealProduction()` to false, so the guard
 * would never fire on them). Catching `APP_ENV=e2e` in a real-prod deploy
 * is the job of CI env-lint (Phase 1b Launch infrastructure), not this boot
 * guard.
 */
const DANGEROUS_FLAGS: ReadonlyArray<{
  key: string;
  dangerousValues: ReadonlyArray<string>;
}> = [
  { key: "E2E_AUTH_RATE_LIMIT_DISABLED", dangerousValues: ["1"] },
  { key: "MCP_RUN_SQL_ENABLED", dangerousValues: ["1"] },
];

export function assertDangerousEnvFlagsUnset(): void {
  if (!isRealProduction()) return;
  for (const { key, dangerousValues } of DANGEROUS_FLAGS) {
    const actual = process.env[key];
    if (actual !== undefined && dangerousValues.includes(actual)) {
      throw new ProductionGuardError(
        "dangerous_env_flag_in_production",
        `Refusing to start: ${key}=${actual} must not be set in real production.`,
      );
    }
  }
}

/**
 * The Better Auth connection pool writes to `user`, `account`, `session`,
 * `verification`. If its connection string resolves to `app_user` in
 * production, RLS silently filters those writes to zero rows without
 * raising — Better Auth then reports success to the caller while nothing
 * has actually persisted. Catch the misconfig at boot.
 *
 * Preference order matches `src/server/auth/auth-server.ts`:
 *   1. `DATABASE_URL_BA` — dedicated BA pool (recommended for real prod)
 *   2. `DATABASE_URL_APP` — shared fallback (dev uses this)
 *   3. `DATABASE_URL`     — last-resort fallback
 *
 * The guard parses whichever one resolves and checks the connection user.
 */
export function assertBetterAuthDbRoleSafe(): void {
  if (!isRealProduction()) return;
  const url =
    process.env.DATABASE_URL_BA ??
    process.env.DATABASE_URL_APP ??
    process.env.DATABASE_URL;
  if (!url) {
    throw new ProductionGuardError(
      "ba_db_url_missing",
      "Refusing to start: no database URL configured for Better Auth (DATABASE_URL_BA / DATABASE_URL_APP / DATABASE_URL).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProductionGuardError(
      "ba_db_url_unparseable",
      "Refusing to start: Better Auth database URL is not a parseable URL.",
    );
  }
  // The Postgres driver honors BOTH the URL userinfo AND a `?user=` query
  // parameter; when both are present, the query param wins. Check both —
  // otherwise `postgresql://ba_writer:pw@host/app?user=app_user` would pass
  // the userinfo check but still connect as app_user.
  const userinfoUser = safeDecode(parsed.username);
  const queryUser = safeDecode(parsed.searchParams.get("user") ?? "");
  const effective = queryUser || userinfoUser;
  if (effective === "app_user") {
    throw new ProductionGuardError(
      "ba_db_role_app_user",
      "Refusing to start: Better Auth database URL must not connect as app_user — RLS would silently filter Better Auth writes.",
    );
  }
}

function safeDecode(raw: string): string {
  try {
    // Decode percent-encoding then NFKC-normalize to fold Unicode
    // compatibility variants (e.g. fullwidth underscore) back to the
    // canonical form, so `app＿user` cannot slip past `=== "app_user"`.
    return decodeURIComponent(raw).normalize("NFKC");
  } catch {
    // Malformed percent-encoding — the URL is not usable. Surface as a
    // ProductionGuardError from the caller by returning a sentinel that
    // will not match "app_user" but also signals unparseability upstream;
    // in practice `new URL()` will usually reject these first.
    throw new ProductionGuardError(
      "ba_db_url_unparseable",
      "Refusing to start: Better Auth database URL contains a malformed percent-encoded sequence.",
    );
  }
}

/**
 * Require the reverse proxy to set `x-real-ip` on every incoming request
 * in real production. The per-IP rate-limit bucket at
 * `src/server/auth/rate-limit-auth-hook.ts` reads ONLY this header
 * (deliberately NOT XFF, which attackers can forge). If the proxy is
 * misconfigured and drops it, every caller collapses into a single
 * `unknown-ip` bucket — annoying, not an exfil risk, but worth failing
 * fast on so the operator sees the misconfig at deploy time.
 *
 * Exposed as a function taking a `{ get(name): string | null }` so it
 * works against both `Headers` and `NextRequest.headers`.
 */
export function assertProxyHeaderPresent(headers: {
  get(name: string): string | null;
}): void {
  if (!isRealProduction()) return;
  const xri = headers.get("x-real-ip");
  if (!xri || xri.trim() === "") {
    throw new ProductionGuardError(
      "proxy_header_missing",
      "Refusing request: reverse proxy did not set x-real-ip.",
    );
  }
}

export function runBootGuards(): void {
  assertDangerousEnvFlagsUnset();
  assertBetterAuthDbRoleSafe();
}
