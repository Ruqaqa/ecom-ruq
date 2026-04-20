/**
 * Membership resolution.
 *
 * A membership is an (tenant, user, role) tuple. Customers do NOT get a
 * membership row (prd.md §3.6 — users belong to the platform, a single
 * user can shop across multiple tenants). Admin users get one per tenant
 * with a role of `owner | staff | support`.
 *
 * Returns `null` for users without a membership — for customers this is
 * the legitimate state, not an error. Callers that require admin-scoped
 * authorization MUST check the return value and treat null as "deny".
 *
 * This module is the seam chunk 6's tRPC context and chunk 7's MCP
 * handlers call after `resolveRequestIdentity` resolves a userId. We
 * intentionally do NOT read `app.tenant_id` — the caller passes tenantId
 * explicitly so this works even before `withTenant` has set the GUC.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/server/db";
import { memberships } from "@/server/db/schema/memberships";
import type { AppDb } from "@/server/db";

export type MembershipRole = "owner" | "staff" | "support";

export interface Membership {
  id: string;
  role: MembershipRole;
  userId: string;
  tenantId: string;
}

let dbOverride: AppDb | null = null;

export function __setMembershipDbForTests(db: AppDb | null): void {
  dbOverride = db;
}

function getDb(): AppDb | null {
  return dbOverride ?? appDb;
}

export async function resolveMembership(
  userId: string,
  tenantId: string,
): Promise<Membership | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      id: memberships.id,
      role: memberships.role,
      userId: memberships.userId,
      tenantId: memberships.tenantId,
    })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.role !== "owner" && row.role !== "staff" && row.role !== "support") {
    // Defensive — a future enum widening should update this narrow shape
    // explicitly rather than silently passing unknown roles through.
    return null;
  }
  return { id: row.id, role: row.role, userId: row.userId, tenantId: row.tenantId };
}
