/**
 * Tenant-scoped PAT lookup.
 *
 * Returns the matching access_tokens row for the (rawToken, tenantId) pair,
 * or null if:
 *   - the token's hash is not in the DB (under any active pepper — see S-9),
 *   - the row exists but belongs to a DIFFERENT tenant (cross-tenant reject),
 *   - the row is revoked (`revoked_at IS NOT NULL`),
 *   - the row is past its `expires_at`,
 *   - the bearing user has NO membership row for the tenant any more (S-5
 *     stale-membership fix), OR
 *   - the bearing user's membership role is LOWER than the token's scopes.role
 *     (S-5 demotion fix — the effective role is min(scopes.role, membership.role)).
 *
 * ADR 0001 option (b): Better Auth's bearer plugin is not a PAT hasher;
 * it only converts signed session JWTs into session cookies. PATs therefore
 * have their own lookup path here. MCP and tRPC bearer auth (chunks 6/7)
 * will call `lookupBearerToken` before dispatching to the service layer.
 *
 * S-5 stale-membership resolution: a PAT might have been minted when the
 * bearing user was an owner. If that user is later offboarded (membership
 * row deleted) or demoted (role changed from owner → staff), the token
 * must NOT continue resolving at the old role. We INNER JOIN memberships
 * on (user_id, tenant_id) and compute `effectiveRole =
 * min(scopes.role, membership.role)`. Missing membership row → lookup
 * returns null (fail closed).
 *
 * S-9 dual-pepper read path: during a pepper rotation, tokens stored
 * under the PREVIOUS pepper must still resolve until operators re-mint.
 * `hashBearerTokenAllPeppers` returns `[current, previous?]`; we filter
 * with `inArray(token_hash, hashes)`.
 *
 * This module does NOT:
 *   - update `last_used_at` (belongs on the MCP/tRPC adapter, debounced);
 *   - write an audit row (audit wrap is at the adapter layer);
 *   - enforce tool scopes (higher layers consume `scopes.tools`).
 */
import { and, eq, isNull, or, gt, inArray } from "drizzle-orm";
import { appDb, withPreAuthTenant } from "@/server/db";
import { accessTokens } from "@/server/db/schema/tokens";
import { memberships } from "@/server/db/schema/memberships";
import type { AppDb } from "@/server/db";
import {
  hashBearerTokenAllPeppers,
  compareHashTimingSafe,
} from "./bearer-hash";
import type { MembershipRole } from "./membership";

export interface BearerTokenRow {
  id: string;
  userId: string;
  tenantId: string;
  name: string;
  scopes: unknown;
  /**
   * Effective role = min(scopes.role, membership.role). A PAT minted as
   * owner for a now-staff user resolves as staff; a PAT for a user whose
   * membership was revoked resolves as null (see S-5).
   */
  effectiveRole: MembershipRole;
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

// Role ordering: lower index = higher privilege. `min(a, b)` picks the
// HIGHER index, i.e. the less-privileged role.
const ROLE_RANK: Record<MembershipRole, number> = {
  owner: 0,
  staff: 1,
  support: 2,
};

function minRole(a: MembershipRole, b: MembershipRole): MembershipRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

function parseScopesRole(scopes: unknown): MembershipRole | null {
  if (!scopes || typeof scopes !== "object") return null;
  const role = (scopes as { role?: unknown }).role;
  if (role === "owner" || role === "staff" || role === "support") return role;
  return null;
}

function parseMembershipRole(role: string): MembershipRole | null {
  if (role === "owner" || role === "staff" || role === "support") return role;
  return null;
}

export async function lookupBearerToken(
  rawToken: string,
  tenantId: string,
): Promise<BearerTokenRow | null> {
  if (!rawToken || !tenantId) return null;
  const db = getDb();
  if (!db) return null;

  // S-9: compute hashes under both current + (optional) previous pepper.
  // `inArray` on the unique index remains sargable; Postgres scans twice
  // at most.
  const tokenHashes = hashBearerTokenAllPeppers(rawToken);
  const now = new Date();

  // Pre-auth: set `app.tenant_id` GUC so RLS returns rows when the app
  // connects as the non-superuser `app_user`. The explicit
  // `eq(accessTokens.tenantId, tenantId)` predicate stays — defense in
  // depth on top of RLS.
  const rows = await withPreAuthTenant(db, tenantId, (tx) =>
    tx
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
        membershipRole: memberships.role,
      })
      .from(accessTokens)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, accessTokens.userId),
          eq(memberships.tenantId, accessTokens.tenantId),
        ),
      )
      .where(
        and(
          eq(accessTokens.tenantId, tenantId),
          inArray(accessTokens.tokenHash, tokenHashes),
          isNull(accessTokens.revokedAt),
          or(isNull(accessTokens.expiresAt), gt(accessTokens.expiresAt, now)),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  // Constant-time re-verification of the hash against either pepper in
  // case the DB index ever returned a false positive (cheap belt-and-
  // braces; HMAC-SHA-256 has no known collisions).
  const anyMatch = tokenHashes.some((h) => compareHashTimingSafe(row.tokenHash, h));
  if (!anyMatch) return null;

  const membershipRole = parseMembershipRole(row.membershipRole);
  if (!membershipRole) return null;

  const scopesRole = parseScopesRole(row.scopes);
  const effectiveRole = scopesRole ? minRole(scopesRole, membershipRole) : membershipRole;

  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    name: row.name,
    scopes: row.scopes,
    effectiveRole,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
