/**
 * Three Postgres pools:
 *   - `appDb` — runtime, connects as `app_user`. ALL tenant-scoped work runs inside
 *     `withTenant(appDb, tenantId, fn)`.
 *   - `tenantLookupDb` — read-only, connects as `app_tenant_lookup`. Used ONLY by the
 *     tenant-resolution middleware before `app.tenant_id` is known. SELECT is
 *     limited to a narrow column set via GRANT (see migrations/0001).
 *   - `migratorDb` — connects as `app_migrator`. Used ONLY by `pnpm db:migrate`. Not
 *     loaded at module scope — imported lazily by scripts/db-migrate.ts.
 *
 * withTenant is the only caller of SET app.tenant_id in the codebase. Always
 * SET LOCAL. Never SET (leaks across pooled connections and produces latent
 * cross-tenant leaks that RLS catches only probabilistically). DO NOT optimize
 * reads out of the transaction. SET LOCAL is transaction-scoped; outside a tx it
 * degenerates to a pool-level SET.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import type { AuthedTenantContext } from "@/server/tenant/context";

const appUrl = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
const lookupUrl = process.env.DATABASE_URL_TENANT_LOOKUP ?? process.env.DATABASE_URL;

export const appClient = appUrl ? postgres(appUrl, { max: 10 }) : null;
export const tenantLookupClient = lookupUrl ? postgres(lookupUrl, { max: 5 }) : null;

export const appDb = appClient ? drizzle(appClient, { schema }) : null;
export const tenantLookupDb = tenantLookupClient ? drizzle(tenantLookupClient, { schema }) : null;

export type AppDb = NonNullable<typeof appDb>;
export type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction with `SET LOCAL app.tenant_id = <ctx.tenantId>`.
 * Throws if the GUC fails to take (defense in depth against future code paths
 * that somehow bypass this helper and still try to write to tenant-scoped tables
 * or audit_log).
 *
 * withTenant is the only caller of `SET app.tenant_id` in the codebase. Always
 * `SET LOCAL`. Never `SET`. DO NOT optimize the read path out of the transaction
 * — SET LOCAL is transaction-scoped; outside a tx it is a session-level SET and
 * leaks across pool-recycled connections. RLS may not catch the leak because
 * the stale GUC could happen to match the victim tenant.
 *
 * The `ctx` parameter is `AuthedTenantContext`, a branded type — see
 * src/server/tenant/context.ts. The only way to construct one is through the
 * adapter-layer factory `buildAuthedTenantContext`. Passing a raw string or
 * a user-supplied `tenantId` is a compile-time type error.
 *
 * Flat-only: `withTenant` rejects nested invocations from inside an existing
 * wrapped tx. A service fn that needs DB access receives the existing `tx` as
 * a parameter — never re-enters `withTenant`. The nesting guard uses an
 * in-process WeakSet keyed on the outer `tx` object.
 */
const activeTenantStorage = new AsyncLocalStorage<string>();

export async function withTenant<T>(
  db: AppDb,
  ctx: AuthedTenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const outer = activeTenantStorage.getStore();
  if (outer !== undefined) {
    throw new Error(
      `withTenant is flat-only; already inside a withTenant scope for tenant ${outer}. Service fns must receive the existing tx.`,
    );
  }
  return activeTenantStorage.run(ctx.tenantId, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      const current = await tx.execute<{ tenant: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      const row = Array.isArray(current)
        ? current[0]
        : (current as { rows?: Array<{ tenant: string | null }> }).rows?.[0];
      if (!row || row.tenant !== ctx.tenantId) {
        throw new Error("withTenant: failed to set app.tenant_id GUC");
      }
      return await fn(tx);
    }),
  );
}

/**
 * Pre-auth sibling of `withTenant` — sets `app.tenant_id` GUC for DB
 * queries issued BEFORE a bearer token is verified (and therefore before
 * an `AuthedTenantContext` can be constructed).
 *
 * CALLABLE ONLY FROM these two pre-auth sites:
 *   - `src/server/auth/bearer-lookup.ts`   (PAT → access_tokens + memberships join)
 *   - `src/server/auth/membership.ts`      (session cookie → memberships lookup)
 *
 * Any other callsite is rejected by the R-4 AST-walk invariant in
 * `scripts/check-role-invariants.ts`. Do not route around it.
 *
 * Shares `activeTenantStorage` with `withTenant`, so a pre-auth scope
 * AND a post-auth scope can never nest in either direction.
 *
 * `tenantId` is a raw string (the bearer path cannot yet prove the
 * caller is authenticated for a branded-type factory). We UUID-validate
 * before `SET LOCAL` and fail-closed on non-UUIDs.
 */
// Hex-with-hyphens UUID shape. Deliberately does NOT enforce RFC 4122
// version/variant bits — synthetic IDs from test fixtures and future
// non-v4 generators must still flow through. The goal is to block
// obviously-invalid inputs (`""`, `"not-a-uuid"`) from reaching
// `set_config`; Postgres itself rejects anything that is not a legal
// UUID literal when the value is cast downstream.
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withPreAuthTenant<T>(
  db: AppDb,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_SHAPE.test(tenantId)) {
    throw new Error("withPreAuthTenant: invalid tenantId");
  }
  const outer = activeTenantStorage.getStore();
  if (outer !== undefined) {
    throw new Error(
      "withPreAuthTenant: already inside a tenant-scoped transaction; pre-auth helper cannot nest.",
    );
  }
  return activeTenantStorage.run(tenantId, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const current = await tx.execute<{ tenant: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      const row = Array.isArray(current)
        ? current[0]
        : (current as { rows?: Array<{ tenant: string | null }> }).rows?.[0];
      if (!row || row.tenant !== tenantId) {
        throw new Error("withPreAuthTenant: failed to set app.tenant_id GUC");
      }
      return await fn(tx);
    }),
  );
}

export { schema };
