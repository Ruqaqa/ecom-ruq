/**
 * `audit-wrap` — THE adapter-level audit middleware, attached to
 * `mutationProcedure` only. Queries do NOT flow through audit-wrap per
 * prd.md §3.7: "Reads of Tier-B and Tier-C fields are not audit-logged
 * (would drown the log in noise)". Tier-A read audit lands when Nafath
 * does (Phase 7), through a different surface.
 *
 * Why mutations-only and not "for consistency":
 *   - every mutation is forensically interesting (who changed what, when);
 *     every page view is not.
 *   - a read-audit channel would inflate the hash chain per request and
 *     stretch the per-tenant advisory-lock window — violating the
 *     bounded-window invariant that 0003's trigger relies on.
 *
 * Why closed-set error codes (see ../../audit/error-codes):
 *   - audit_log is append-only and PDPL-un-deletable. A leaked
 *     `err.message` containing an email, national ID, or row value
 *     cannot be scrubbed later. The closed set bounds what the column
 *     can ever hold.
 *
 * Why NO retry loop on writeAuditInOwnTx failure:
 *   - the original TRPCError is already bubbling up to the caller. A
 *     retry loop would mask real DB outages and mislead the operator.
 *     Sentry capture (via `src/server/obs/sentry.ts` shim) is the right
 *     signal for "audit couldn't write"; the caller still sees the
 *     real error.
 *
 * Why the failure path writes only `failedPaths` (not raw input):
 *   - raw input on a validation failure is, by definition, data a caller
 *     tried to submit but didn't pass the schema. On sign-up that body
 *     can contain a plaintext password; we do NOT want it hashed into
 *     the chain (un-scrubbable) OR stored in audit_payloads. The field
 *     path ("name.en") is enough forensic signal. Non-validation
 *     failures write no input at all; the full body, if needed, lives
 *     in Sentry `extra`, not in the chain.
 */
import { randomUUID } from "node:crypto";
import { middleware, publicProcedure, TRPCError } from "../init";
import { appDb, type Tx } from "@/server/db";
import {
  buildAuthedTenantContext,
  type AuthedSession,
  type AuthedTenantContext,
} from "@/server/tenant/context";
import {
  mapErrorToAuditCode as mapErrorToAuditCodeShared,
  inputForFailure as inputForFailureShared,
} from "@/server/audit/adapter-wrap";
import { runWithAudit } from "@/server/audit/run-with-audit";
import type { TRPCContext } from "../context";
import { deriveRole } from "../ctx-role";

/**
 * Context override contributed by `auditWrap`. Downstream procedures (and
 * the `requireRole` middleware it composes with) see these fields
 * on `ctx`. On non-mutation paths where we short-circuit, `tx` /
 * `authedCtx` are null — the narrow type reflects that so consumers
 * handle both states.
 *
 * `auditPayloads` is a mutable holder a procedure can write to when its
 * wire-return shape and its audit shape diverge — e.g. updateProduct
 * returns a Tier-B-stripped wire shape but wants the full pre/post row
 * recorded in the audit chain. Procedures that don't set it fall back
 * to using the wire return as both `result` and `after` (no `before`).
 */
export interface AuditWrapAuditPayloads {
  /** Override for the `after` audit payload. Falls back to the wire return. */
  after?: unknown;
  /** Optional `before` audit payload — recorded as `audit_payloads.kind = 'before'`. */
  before?: unknown;
}

export interface AuditWrapContextOverride {
  tx: Tx | null;
  authedCtx: AuthedTenantContext | null;
  correlationId: string | null;
  auditPayloads: AuditWrapAuditPayloads | null;
}

const EMPTY_OVERRIDE: AuditWrapContextOverride = {
  tx: null,
  authedCtx: null,
  correlationId: null,
  auditPayloads: null,
};

function deriveActor(ctx: Pick<TRPCContext, "identity">): {
  actorType: "user" | "system" | "anonymous";
  actorId: string | null;
  tokenId: string | null;
} {
  if (ctx.identity.type === "anonymous") {
    return { actorType: "anonymous", actorId: null, tokenId: null };
  }
  return {
    actorType: "user",
    actorId: ctx.identity.userId,
    tokenId: ctx.identity.type === "bearer" ? ctx.identity.tokenId : null,
  };
}

function deriveSession(ctx: Pick<TRPCContext, "identity" | "membership">): AuthedSession {
  const i = ctx.identity;
  if (i.type === "anonymous") {
    return { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" };
  }
  return {
    userId: i.userId,
    actorType: "user",
    tokenId: i.type === "bearer" ? i.tokenId : null,
    // Single source of truth — see ../ctx-role.ts. Do not inline the
    // `ctx.membership?.role ?? 'customer'` derivation here.
    role: deriveRole(ctx),
  };
}

/**
 * Re-export the transport-neutral mapper so existing importers (tests +
 * siblings) keep working after the adapter-wrap split (sub-chunk 7.2
 * Part A). tRPC middleware and MCP audit adapter both delegate to the
 * same byte-equivalent mapping.
 */
export const mapErrorToAuditCode = mapErrorToAuditCodeShared;
const inputForFailure = inputForFailureShared;

export const auditWrap = middleware(async ({ ctx, path, type, getRawInput, next }) => {
  if (type !== "mutation") return next({ ctx: EMPTY_OVERRIDE });
  if (!appDb) {
    // No DB configured; skip audit entirely (dev with no services). Not a
    // failure — callers still run. Provide the override shape for type
    // consistency; callers still see null tx/authedCtx.
    return next({ ctx: EMPTY_OVERRIDE });
  }

  const correlationId = randomUUID();
  const actor = deriveActor(ctx);
  const session = deriveSession(ctx);
  const authedCtx = buildAuthedTenantContext(ctx.tenant, session);

  let capturedRawInput: unknown = undefined;
  try {
    capturedRawInput = await getRawInput();
  } catch {
    capturedRawInput = undefined;
  }

  // Capture the tRPC `next(...)` MiddlewareResult so we can return the
  // original envelope (incl. `ok: true`, `ctx`, etc.) to tRPC's caller.
  // The shared `runWithAudit` only cares about the unwrapped value +
  // the `after` audit payload; the `ok:false` rethrow keeps the failure
  // path identical to the pre-7.3 behavior (outer tx rolls back + a
  // single failure audit row is written).
  type MiddlewareResult = Awaited<ReturnType<typeof next>>;
  let capturedResult: MiddlewareResult | null = null;

  // Mutable holder a procedure can populate to override the audit
  // shape — see AuditWrapAuditPayloads.
  const auditPayloads: AuditWrapAuditPayloads = {};

  await runWithAudit<MiddlewareResult>({
    db: appDb,
    authedCtx,
    tenantId: ctx.tenant.id,
    operation: path,
    actor,
    correlationId,
    successInput: capturedRawInput,
    onFailure: (err) => ({
      errorCode: mapErrorToAuditCode(err),
      // Never pass capturedRawInput on the failure path. Only Zod field-
      // paths (or nothing) reach the audit chain.
      failureInput: inputForFailure(err),
    }),
    work: async (tx: Tx) => {
      const override: AuditWrapContextOverride = {
        tx,
        authedCtx,
        correlationId,
        auditPayloads,
      };
      const result = await next({ ctx: override });
      if (!result.ok) throw result.error;
      capturedResult = result;
      // Procedure-set `after` overrides the wire return (e.g.
      // updateProduct sets the full Tier-B row even when the wire
      // return is the role-gated subset).
      const after =
        auditPayloads.after !== undefined ? auditPayloads.after : result.data;
      return {
        result,
        after,
        ...(auditPayloads.before !== undefined
          ? { before: auditPayloads.before }
          : {}),
      };
    },
  });

  // If runWithAudit returned normally, capturedResult is populated
  // (the `work` thunk always sets it before returning on the success
  // branch). Guard defensively: an unexpected path where runWithAudit
  // returned without invoking work would indicate a broken contract
  // in the shared core — throw rather than hand callers null.
  if (capturedResult === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "auditWrap invariant broken: runWithAudit returned without work result",
    });
  }
  return capturedResult;
});

/**
 * Narrows the nullable auditWrap override fields to non-null for
 * procedures that are ONLY invoked as mutations. The auditWrap runtime
 * invariant is that tx/authedCtx/correlationId are always populated when
 * `type === 'mutation'`; the nullable override shape exists for tRPC's
 * type-system constraint that all `next(...)` calls within a middleware
 * must contribute the same context-override shape. This second
 * middleware asserts the invariant at runtime and narrows at the type
 * level so downstream procedures can use `ctx.tx` / `ctx.authedCtx`
 * without null-checks.
 */
/**
 * The adapter-level audit wrap. Mutations only — queries do NOT audit per
 * prd.md §3.7. Callers compose further: e.g.,
 *   `mutationProcedure.use(requireRole({ roles: ['owner','staff'] }))`.
 *
 * The `.unstable_pipe` on `auditWrap` narrows the override from the
 * nullable shape (required by tRPC for cross-branch type consistency) to
 * the runtime-invariant non-null shape. Mutations always run through the
 * main `auditWrap` body where tx/authedCtx/correlationId are populated;
 * the nullable fallback branches are type-only safety. The pipe asserts
 * at runtime so a future bug that tripped the invariant would throw a
 * 500 rather than hand a service a null `tx`.
 */
const narrowMutationContext = auditWrap.unstable_pipe(async ({ ctx, next, type }) => {
  if (type !== "mutation") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "mutationProcedure invoked as non-mutation",
    });
  }
  if (
    ctx.tx === null ||
    ctx.authedCtx === null ||
    ctx.correlationId === null ||
    ctx.auditPayloads === null
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "auditWrap invariant broken: ctx.tx / authedCtx / correlationId / auditPayloads missing",
    });
  }
  return next({
    ctx: {
      tx: ctx.tx,
      authedCtx: ctx.authedCtx,
      correlationId: ctx.correlationId,
      auditPayloads: ctx.auditPayloads,
    },
  });
});

export const mutationProcedure = publicProcedure.use(narrowMutationContext);
