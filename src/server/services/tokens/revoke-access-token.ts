/**
 * `revokeAccessToken` — soft-revokes a PAT (sub-chunk 7.1).
 *
 * Shape rules match `createAccessToken`:
 *   - No tx open — adapter passes `tx`.
 *   - No audit write — adapter audit-wraps.
 *   - No `tenantId` / `userId` on input.
 *   - Role gate: owner-only.
 *
 * Destructive-op invariant (CLAUDE.md §2): `confirm: z.literal(true)` is
 * required. Missing/false → validation_failed via Zod.
 *
 * Implementation: `UPDATE access_tokens SET revoked_at = now() WHERE id
 * AND revoked_at IS NULL RETURNING id`. The empty RETURNING collapses
 * row-absent AND already-revoked into one NOT_FOUND branch — this is
 * intentional (an already-revoked token is indistinguishable from a
 * never-existed one to prevent enumeration, and RLS hides cross-tenant
 * tokens the same way).
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { accessTokens } from "@/server/db/schema/tokens";
import { TRPCError } from "@trpc/server";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface RevokeAccessTokenTenantInfo {
  id: string;
}

export const RevokeAccessTokenInputSchema = z.object({
  tokenId: z.string().uuid(),
  confirm: z.literal(true),
});
export type RevokeAccessTokenInput = z.input<typeof RevokeAccessTokenInputSchema>;

export const RevokeAccessTokenOutputSchema = z.object({
  id: z.string().uuid(),
  revoked: z.literal(true),
});
export type RevokeAccessTokenOutput = z.infer<typeof RevokeAccessTokenOutputSchema>;

export async function revokeAccessToken(
  tx: Tx,
  tenant: RevokeAccessTokenTenantInfo,
  _callerUserId: string,
  role: Role,
  input: RevokeAccessTokenInput,
): Promise<RevokeAccessTokenOutput> {
  if (role !== "owner") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "only owners can revoke access tokens",
    });
  }

  const parsed = RevokeAccessTokenInputSchema.parse(input);

  // Tenant scoping: both RLS (under app_user role) AND an explicit
  // `tenantId = tenant.id` predicate. The explicit predicate is the
  // same defense-in-depth pattern `lookupBearerToken` uses: it narrows
  // the RETURNING *before* the RLS policy sees the update, so the
  // cross-tenant path returns empty-RETURNING → NOT_FOUND even under
  // test-superuser connections that bypass RLS. The `revoked_at IS NULL`
  // predicate collapses the already-revoked case into NOT_FOUND,
  // matching enumeration-safe revoke semantics.
  const rows = await tx
    .update(accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accessTokens.id, parsed.tokenId),
        eq(accessTokens.tenantId, tenant.id),
        isNull(accessTokens.revokedAt),
      ),
    )
    .returning({ id: accessTokens.id });

  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "token not found or already revoked",
    });
  }

  return RevokeAccessTokenOutputSchema.parse({ id: row.id, revoked: true });
}
