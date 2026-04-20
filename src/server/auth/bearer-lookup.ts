/**
 * Tenant-scoped PAT lookup.
 *
 * Returns the matching access_tokens row for the (rawToken, tenantId) pair,
 * or null if:
 *   - the token's hash is not in the DB,
 *   - the row exists but belongs to a DIFFERENT tenant (cross-tenant reject),
 *   - the row is revoked (`revoked_at IS NOT NULL`),
 *   - the row is past its `expires_at`.
 *
 * ADR 0001 option (b): Better Auth's bearer plugin is not a PAT hasher;
 * it only converts signed session JWTs into session cookies. PATs therefore
 * have their own lookup path here. MCP and tRPC bearer auth (chunks 6/7)
 * will call `lookupBearerToken` before dispatching to the service layer.
 *
 * This module does NOT:
 *   - update `last_used_at` (that belongs on the MCP/tRPC adapter, debounced
 *     per docs/adr/0001-pat-storage.md §Issuance and revocation);
 *   - write an audit row (audit wrap is at the adapter layer — see
 *     src/server/services/README.md);
 *   - enforce scopes / role checks (higher layers consume the `scopes` field).
 *
 * RLS: the `access_tokens` table has `FOR ALL TO app_user USING tenant_id =
 * current_setting('app.tenant_id')`. Because the lookup happens BEFORE the
 * tenant GUC can be trusted (the caller is authenticating to a tenant —
 * that's what we're verifying), we use a narrow SELECT that ALSO filters
 * by tenant_id explicitly. Running as the superuser in dev bypasses RLS,
 * but the explicit `eq(tenantId)` predicate makes this safe under the
 * `app_user` role too because rows for OTHER tenants are filtered by
 * predicate before the policy sees them. A future hardening (chunk 7)
 * can split this off to a dedicated role with a policy-only narrow grant.
 */
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { appDb } from "@/server/db";
import { accessTokens } from "@/server/db/schema/tokens";
import type { AppDb } from "@/server/db";
import { hashBearerToken, compareHashTimingSafe } from "./bearer-hash";

export interface BearerTokenRow {
  id: string;
  userId: string;
  tenantId: string;
  name: string;
  scopes: unknown;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

let dbOverride: AppDb | null = null;

export function __setBearerLookupDbForTests(db: AppDb | null): void {
  dbOverride = db;
}

function getDb(): AppDb | null {
  return dbOverride ?? appDb;
}

export async function lookupBearerToken(
  rawToken: string,
  tenantId: string,
): Promise<BearerTokenRow | null> {
  if (!rawToken || !tenantId) return null;
  const db = getDb();
  if (!db) return null;

  const tokenHash = hashBearerToken(rawToken);
  const now = new Date();

  const rows = await db
    .select({
      id: accessTokens.id,
      userId: accessTokens.userId,
      tenantId: accessTokens.tenantId,
      name: accessTokens.name,
      scopes: accessTokens.scopes,
      tokenHash: accessTokens.tokenHash,
      lastUsedAt: accessTokens.lastUsedAt,
      expiresAt: accessTokens.expiresAt,
      revokedAt: accessTokens.revokedAt,
      createdAt: accessTokens.createdAt,
    })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tenantId, tenantId),
        eq(accessTokens.tokenHash, tokenHash),
        isNull(accessTokens.revokedAt),
        or(isNull(accessTokens.expiresAt), gt(accessTokens.expiresAt, now)),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // Constant-time re-verification of the hash in case the DB index ever
  // returned a false positive (e.g. pathological collision). HMAC-SHA-256
  // has no known collisions, so this is belt-and-braces, not a real
  // defense — but it is cheap and matches the timing-safe habit.
  if (!compareHashTimingSafe(row.tokenHash, tokenHash)) return null;

  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    name: row.name,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
