/**
 * tRPC v11 initialization.
 *
 * superjson transformer so Date / Map / BigInt round-trip cleanly between
 * the web client and the server. `Context` is our per-request shape from
 * ./context.
 *
 * `mutationProcedure` is the audit-wrapped procedure used by every
 * mutation. Queries use `publicProcedure` directly — they are NOT
 * audit-wrapped by design (prd.md §3.7: reads of Tier-B/Tier-C fields
 * are not logged; a read-audit channel would stretch the per-tenant
 * advisory-lock window on the audit hash chain).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { TRPCContext } from "./context";

/**
 * Error formatter extracts Zod field errors into `error.data.zodError` so
 * the client can render inline messages beneath the offending input. We
 * only surface `fieldErrors` (not `formErrors`) because our Zod schemas
 * don't use top-level refinements that would populate the latter. The
 * audit path is unaffected — `audit-wrap.ts` maps the error to
 * `validation_failed` via `mapErrorToAuditCode` and writes only field
 * PATHS (not values) per the High-01 invariant.
 */
const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? { fieldErrors: error.cause.flatten().fieldErrors } : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export { TRPCError };

// `mutationProcedure` lives in `./middleware/audit-wrap.ts` and is imported
// directly from there by callers. It is NOT re-exported here to avoid a
// load-order cycle (audit-wrap imports from this file).
