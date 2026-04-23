/**
 * `listAccessTokens` — lists non-revoked PATs under the current tenant.
 *
 * Read path; audit-wrap does NOT cover it (queries are not audited per
 * prd.md §3.7). The service is owner+staff-gated; support/customer/
 * anonymous callers → FORBIDDEN.
 *
 * Tier-B gate: the output Zod schema omits `plaintext` (irrecoverable
 * after issuance, anyway) and `tokenHash` (DB-internal secret material).
 * `.parse` strips both by construction, same mechanism the product
 * service uses.
 *
 * Hard LIMIT 200 — sane cap against a tenant with thousands of tokens
 * which would balloon the admin UI and audit-log surface alike. Phase 1+
 * can add pagination.
 */
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { accessTokens } from "@/server/db/schema/tokens";
import { TOOL_ALLOWLIST } from "@/server/services/tokens/create-access-token";
import { TRPCError } from "@trpc/server";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface ListAccessTokensTenantInfo {
  id: string;
}

const LIST_LIMIT = 200;

export const AccessTokenListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.object({
    role: z.enum(["owner", "staff", "support"]),
    // Tier-B fail-loud: if TOOL_ALLOWLIST ever shrinks (a tool is
    // deprecated), old rows with now-deprecated tool names must
    // fail .parse rather than display in the admin UI as if live.
    tools: z.array(z.enum(TOOL_ALLOWLIST)).optional(),
  }),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
});
export type AccessTokenListItem = z.infer<typeof AccessTokenListItemSchema>;

export const ListAccessTokensOutputSchema = z.array(AccessTokenListItemSchema);

export async function listAccessTokens(
  tx: Tx,
  tenant: ListAccessTokensTenantInfo,
  role: Role,
): Promise<AccessTokenListItem[]> {
  if (role !== "owner" && role !== "staff") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "insufficient role",
    });
  }

  // SELECT only the columns the output schema names — no `plaintext`
  // (which isn't stored anyway) and no `tokenHash` (DB-internal).
  // Explicit `tenantId = tenant.id` predicate is defense-in-depth
  // alongside the RLS policy.
  const rows = await tx
    .select({
      id: accessTokens.id,
      name: accessTokens.name,
      tokenPrefix: accessTokens.tokenPrefix,
      scopes: accessTokens.scopes,
      lastUsedAt: accessTokens.lastUsedAt,
      expiresAt: accessTokens.expiresAt,
      createdAt: accessTokens.createdAt,
    })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tenantId, tenant.id),
        isNull(accessTokens.revokedAt),
      ),
    )
    .orderBy(desc(accessTokens.createdAt))
    .limit(LIST_LIMIT);

  return ListAccessTokensOutputSchema.parse(rows);
}
