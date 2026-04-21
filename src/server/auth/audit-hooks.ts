/**
 * Better Auth `databaseHooks` audit call sites.
 *
 * Block 7 wires the five auth events (signup, verify-email, magic-link
 * request, magic-link consume, session create, session revoke) into the
 * adapter-level audit writer. Every row is structural only — never
 * caller-supplied email/password/etc. The closed-set `after` shape is
 * enforced by `scripts/check-e2e-coverage.ts`'s auth-audit lint.
 *
 * Tenant resolution option B (CP8 Phase 2): when the BA ctx is null
 * (internal code paths, dev seed scripts) OR `resolveTenant` returns
 * null (unknown host), we SKIP the audit write entirely and fire a
 * Sentry `audit_write_failure` alert with `reason:
 * tenant_resolution_lost_at_hook`. `APP_ENV=seed` suppresses the
 * Sentry send so dev seed scripts don't flood the alert channel.
 *
 * Hash-chain notes:
 *  - Five separate `writeAuditInOwnTx` calls per magic-link-first-
 *    consume each grab the per-tenant `pg_advisory_xact_lock`. Under
 *    contention this 4x-multiplies the lock window for one user-facing
 *    event. See docs/runbooks/auth.md "Four-row shape on magic-link-
 *    first-consume" note.
 *  - All auth.* operations use a fresh `correlationId` per call site
 *    EXCEPT the magic-link consume write on session.create.after,
 *    which shares the correlationId with its parent session.create
 *    row so operators can join the two.
 */
import { randomUUID } from "node:crypto";
import type { GenericEndpointContext } from "better-auth";
import { writeAuditInOwnTx } from "@/server/audit/write";
import { resolveTenant } from "@/server/tenant";

async function resolveTenantFromCtx(
  ctx: GenericEndpointContext | null,
): Promise<{ id: string } | null> {
  if (ctx == null) return null;
  const req = ctx.request;
  if (!req) return null;
  let host: string | null = null;
  try {
    host = new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
  const tenant = await resolveTenant(host);
  return tenant ? { id: tenant.id } : null;
}

async function onTenantResolutionFailure(
  operation: string,
  userId: string | null,
  ctx: GenericEndpointContext | null,
): Promise<void> {
  if (process.env.APP_ENV === "seed") return;
  const { captureMessage } = await import("@/server/obs/sentry");
  let host = "ctx-null";
  if (ctx?.request) {
    try {
      host = new URL(ctx.request.url).host;
    } catch {
      host = "ctx-bad-url";
    }
  }
  captureMessage("audit_write_failure", {
    level: "error",
    tags: {
      reason: "tenant_resolution_lost_at_hook",
      operation,
    },
    extra: { user_id: userId, host },
  });
}

interface UserShape {
  id: string;
  email?: string;
  emailVerified?: boolean;
}

interface SessionShape {
  id: string;
  userId: string;
}

interface VerificationShape {
  id: string;
  identifier: string;
}

/** BA `databaseHooks.user.create.after` — audits the signup-success event. */
export const userCreateAfter = async (
  user: UserShape,
  ctx: GenericEndpointContext | null,
): Promise<void> => {
  const tenant = await resolveTenantFromCtx(ctx);
  if (!tenant) {
    await onTenantResolutionFailure("auth.signup", user.id, ctx);
    return;
  }
  await writeAuditInOwnTx({
    tenantId: tenant.id,
    operation: "auth.signup",
    actorType: "user",
    actorId: user.id,
    tokenId: null,
    outcome: "success",
    correlationId: randomUUID(),
    // Structural only — user.email must NOT land in the chain.
    after: { userId: user.id },
  });
};

/**
 * BA `databaseHooks.user.update.after` — audits email verification
 * flips. Fires on every user update; we filter for
 * `emailVerified === true` and accept some theoretical over-audit
 * (see block-7 brief rationale: our current update paths are narrow,
 * Tier-C noise is harmless, Phase 1a can narrow further).
 */
export const userUpdateAfter = async (
  user: UserShape,
  ctx: GenericEndpointContext | null,
): Promise<void> => {
  if (user.emailVerified !== true) return;
  const tenant = await resolveTenantFromCtx(ctx);
  if (!tenant) {
    await onTenantResolutionFailure("auth.verify-email", user.id, ctx);
    return;
  }
  await writeAuditInOwnTx({
    tenantId: tenant.id,
    operation: "auth.verify-email",
    actorType: "user",
    actorId: user.id,
    tokenId: null,
    outcome: "success",
    correlationId: randomUUID(),
    after: { userId: user.id, verifiedAt: new Date().toISOString() },
  });
};

/**
 * BA `databaseHooks.verification.create.after` — fires on every
 * verification row write (email-verification token, magic-link token,
 * future password-reset token). We audit only the magic-link-request
 * path; signup's verification-token creation is covered by
 * `userCreateAfter`, and password-reset lands later.
 *
 * Empty `after` (no fields) — timing-attack safe. BA's own branching
 * is uniform (it writes the row whether the email exists or not), so
 * audit emission here does not leak user existence.
 */
export const verificationCreateAfter = async (
  _verification: VerificationShape,
  ctx: GenericEndpointContext | null,
): Promise<void> => {
  if (ctx?.path !== "/sign-in/magic-link") return;
  const tenant = await resolveTenantFromCtx(ctx);
  if (!tenant) {
    await onTenantResolutionFailure("auth.magic-link.request", null, ctx);
    return;
  }
  await writeAuditInOwnTx({
    tenantId: tenant.id,
    operation: "auth.magic-link.request",
    actorType: "anonymous",
    actorId: null,
    tokenId: null,
    outcome: "success",
    correlationId: randomUUID(),
    after: {},
  });
};

/**
 * BA `databaseHooks.session.create.after` — one hook, two possible
 * audit writes:
 *
 *  1. Always: `auth.session.create` (any successful session creation).
 *  2. Additionally when `ctx.path === '/magic-link/verify'`:
 *     `auth.magic-link.consume` sharing the same correlationId as the
 *     session.create row, so operators can join the two.
 *
 * `isNewUser` detection (magic-link-first-consume creating a fresh
 * user inline) requires cross-hook state and is deferred to Phase 4.
 * Block 7 emits the consume row unconditionally when the session came
 * from a magic-link verify.
 */
export const sessionCreateAfter = async (
  session: SessionShape,
  ctx: GenericEndpointContext | null,
): Promise<void> => {
  const tenant = await resolveTenantFromCtx(ctx);
  if (!tenant) {
    await onTenantResolutionFailure("auth.session.create", session.userId, ctx);
    return;
  }
  const correlationId = randomUUID();
  await writeAuditInOwnTx({
    tenantId: tenant.id,
    operation: "auth.session.create",
    actorType: "user",
    actorId: session.userId,
    tokenId: null,
    outcome: "success",
    correlationId,
    after: { userId: session.userId, sessionId: session.id },
  });

  if (ctx?.path === "/magic-link/verify") {
    await writeAuditInOwnTx({
      tenantId: tenant.id,
      operation: "auth.magic-link.consume",
      actorType: "user",
      actorId: session.userId,
      tokenId: null,
      outcome: "success",
      correlationId,
      after: { userId: session.userId, sessionId: session.id },
    });
  }
};

export type RevokeReason = "user_signout" | "system" | "unknown";

function deriveRevokeReason(ctx: GenericEndpointContext | null): RevokeReason {
  if (ctx == null) return "system";
  if (ctx.path === "/sign-out") return "user_signout";
  return "unknown";
}

/**
 * BA `databaseHooks.session.delete.after` — audits session revocations.
 * Reason enum derived from ctx.path. `admin_revoke` branch lands with
 * the Phase-4 `/admin/revoke-session` endpoint.
 */
export const sessionDeleteAfter = async (
  session: SessionShape,
  ctx: GenericEndpointContext | null,
): Promise<void> => {
  const tenant = await resolveTenantFromCtx(ctx);
  if (!tenant) {
    await onTenantResolutionFailure("auth.session.revoke", session.userId, ctx);
    return;
  }
  await writeAuditInOwnTx({
    tenantId: tenant.id,
    operation: "auth.session.revoke",
    actorType: "user",
    actorId: session.userId,
    tokenId: null,
    outcome: "success",
    correlationId: randomUUID(),
    after: {
      userId: session.userId,
      sessionId: session.id,
      reason: deriveRevokeReason(ctx),
    },
  });
};
