/**
 * `createAccessToken` — PAT issuance service (sub-chunk 7.1).
 *
 * Shape rules (mirrored from `services/products/create-product.ts`):
 *   1. No `withTenant` call — adapter owns the tx lifecycle.
 *   2. No tx open — adapter passes `tx` in.
 *   3. No audit write — adapter (audit-wrap) wraps every mutation.
 *   4. No transport imports.
 *   5. Tenant arrives as narrowed projection (`CreateAccessTokenTenantInfo`).
 *   6. `callerUserId` arrives from ctx (NEVER input). There is no `userId` or
 *      `tenantId` field on `CreateAccessTokenInputSchema` — the adversarial
 *      attack surface does not exist (matches Low-02 invariant).
 *   7. Role gate: owner-only. Non-owner → FORBIDDEN.
 *
 * Security decisions (see sub-chunk 7.1 decision log):
 *   - S-1: minting an owner-scoped PAT requires explicit
 *     `ownerScopeConfirm: true`. Durable owner creds are destructive per
 *     CLAUDE.md §6.
 *   - S-2: `expiresAt` defaults to now+90d ("short-lived" per prd.md §9.5).
 *     Maximum accepted explicit value is now+365d. Caller can pass a value
 *     tighter than 90d via the input.
 *   - S-3: `expiresAt` in the past is rejected (validation_failed).
 *   - S-4: per-tenant issuance rate limit via Redis sliding-window bucket
 *     `pat:issuance:{tenantId}`, 20 issuances/hour. Fail-closed on Redis
 *     outage.
 *
 * Plaintext shape: `eruq_pat_` + 43 chars of base64url-encoded 32 random
 * bytes. `tokenPrefix` = `plaintext.slice(9, 17)` (8 chars of the secret
 * portion, matches the chunk-5 lookup test fixture convention).
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { accessTokens } from "@/server/db/schema/tokens";
import { hashBearerToken } from "@/server/auth/bearer-hash";
import { checkRateLimit } from "@/server/auth/rate-limit";
import { TRPCError } from "@trpc/server";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface CreateAccessTokenTenantInfo {
  id: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;
const ISSUANCE_LIMIT_PER_HOUR = 20;
const ISSUANCE_WINDOW_SECONDS = 3600;

const ScopesSchema = z.object({
  role: z.enum(["owner", "staff", "support"]),
  tools: z.array(z.string()).optional(),
});
export type AccessTokenScopes = z.infer<typeof ScopesSchema>;

/**
 * The Zod input schema. Shape: `{ name, scopes, expiresAt?, ownerScopeConfirm? }`.
 * Superrefine enforces S-1 (owner scope requires explicit confirmation).
 * Refines enforce S-3 (no backdated) + S-2 (<=1y max).
 */
export const CreateAccessTokenInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: ScopesSchema,
    expiresAt: z
      .date()
      .refine((d) => d.getTime() > Date.now(), {
        message: "expiresAt must be in the future",
      })
      .refine((d) => d.getTime() <= Date.now() + MAX_EXPIRY_DAYS * MS_PER_DAY, {
        message: `expiresAt must be <= ${MAX_EXPIRY_DAYS}d from now`,
      })
      .optional(),
    ownerScopeConfirm: z.literal(true).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scopes.role === "owner" && data.ownerScopeConfirm !== true) { // role-lint: input-scopes-role-ok
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerScopeConfirm"],
        message: "minting an owner-scoped PAT requires ownerScopeConfirm=true",
      });
    }
  });
export type CreateAccessTokenInput = z.input<typeof CreateAccessTokenInputSchema>;

/**
 * Output schema — returned to the issuance caller EXACTLY ONCE. Plaintext
 * is a Tier-A-adjacent secret: it must never be audit-logged, which is
 * enforced by the `BELT_AND_BRACES_PII_KEYS` matcher (exact-key on
 * `plaintext` + `tokenHash`).
 */
export const CreateAccessTokenOutputSchema = z.object({
  id: z.string().uuid(),
  plaintext: z.string(),
  tokenPrefix: z.string(),
  name: z.string(),
  scopes: ScopesSchema,
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
});
export type CreateAccessTokenOutput = z.infer<typeof CreateAccessTokenOutputSchema>;

function generatePlaintext(): string {
  // base64url of 32 bytes = 43 chars, no padding.
  return "eruq_pat_" + randomBytes(32).toString("base64url");
}

export async function createAccessToken(
  tx: Tx,
  tenant: CreateAccessTokenTenantInfo,
  callerUserId: string,
  role: Role,
  input: CreateAccessTokenInput,
): Promise<CreateAccessTokenOutput> {
  // Role gate — owner-only. Non-owner → FORBIDDEN. The tRPC `requireMembership`
  // middleware also guards, but the service-layer check is defense-in-depth
  // for MCP / internal-job callers that reuse the service without the
  // tRPC stack.
  if (role !== "owner") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "only owners can mint access tokens",
    });
  }

  // Zod parse — this is the source-of-truth validation (S-1/S-2/S-3).
  const parsed = CreateAccessTokenInputSchema.parse(input);

  // S-4: per-tenant issuance rate limit. Fail-closed on Redis outage
  // (checkRateLimit throws on pipeline null — we re-throw with TOO_MANY).
  const rl = await checkRateLimit({
    bucket: `pat:issuance:${tenant.id}`,
    limit: ISSUANCE_LIMIT_PER_HOUR,
    windowSeconds: ISSUANCE_WINDOW_SECONDS,
  });
  if (!rl.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "PAT issuance rate limit exceeded",
    });
  }

  // Compute plaintext + hash + prefix. Hash is derived from pepper — the
  // loader throws if TOKEN_HASH_PEPPER is missing/placeholder/short, which
  // happens BEFORE the insert so a misconfigured deploy fails loudly.
  const plaintext = generatePlaintext();
  const tokenHash = hashBearerToken(plaintext);
  // `slice(9, 17)` = 8 chars of the secret portion right after `eruq_pat_`.
  const tokenPrefix = plaintext.slice(9, 17);

  const expiresAt =
    parsed.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * MS_PER_DAY);

  // `tenantId` and `userId` come EXCLUSIVELY from the adapter-supplied
  // arguments. There is no field on the input schema that can shadow them.
  const rows = await tx
    .insert(accessTokens)
    .values({
      tenantId: tenant.id,
      userId: callerUserId,
      name: parsed.name,
      tokenHash,
      tokenPrefix,
      scopes: parsed.scopes,
      expiresAt,
    })
    .returning({
      id: accessTokens.id,
      name: accessTokens.name,
      scopes: accessTokens.scopes,
      expiresAt: accessTokens.expiresAt,
      createdAt: accessTokens.createdAt,
    });

  const row = rows[0];
  if (!row) throw new Error("createAccessToken: insert returned no row");

  // Parse through the output schema — drops anything that shouldn't leak.
  return CreateAccessTokenOutputSchema.parse({
    id: row.id,
    plaintext,
    tokenPrefix,
    name: row.name,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  });
}
