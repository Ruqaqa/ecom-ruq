// pg / postgres-js errors are wrapped by Drizzle and re-wrapped by
// TRPCError, so the error we see is up to a few `.cause` levels deep.
// This walker peels the chain looking for a postgres error record (one
// that exposes a SQLSTATE on `code`). Returns the matched record or
// undefined.
//
// Centralized here so the audit mapper and the products' service-layer
// helpers share a single peel implementation. Lifting beyond this file
// would force a tighter abstraction (e.g., a "peel any cause chain"
// utility) that isn't justified by current call sites.

const SQLSTATE = /^[A-Z0-9]{5}$/;
const MAX_CAUSE_DEPTH = 4;

export interface PgErrorRecord {
  code: string;
  constraint_name?: string;
}

export function findPgErrorRecord(err: unknown): PgErrorRecord | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const obj = cur as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (typeof obj.code === "string" && SQLSTATE.test(obj.code)) {
      const rec: PgErrorRecord = { code: obj.code };
      if (typeof obj.constraint_name === "string") {
        rec.constraint_name = obj.constraint_name;
      }
      return rec;
    }
    cur = obj.cause;
  }
  return undefined;
}
