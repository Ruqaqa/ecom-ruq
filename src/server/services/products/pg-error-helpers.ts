/**
 * Shared pg-error helpers for the products services.
 *
 * `extractPgUniqueViolation(err, constraint)` peels up to 4 levels of
 * `.cause` looking for a pg DatabaseError with code 23505 whose
 * `constraint_name` matches. Returns true on match. Drizzle wraps pg
 * errors inside its own DrizzleQueryError; postgres-js exposes the
 * SQLSTATE on `code` and the constraint on `constraint_name`.
 *
 * Why a helper: createProduct's slug-collision path and updateProduct's
 * slug-collision path both translate the same DB error into the same
 * typed wire error. Inline duplication in two spots is fine; once the
 * third caller arrives this is the single place to evolve.
 */
const SQLSTATE = /^[A-Z0-9]{5}$/;

export function extractPgUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    const obj = cur as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      typeof obj.code === "string" &&
      SQLSTATE.test(obj.code) &&
      obj.code === "23505" &&
      typeof obj.constraint_name === "string" &&
      obj.constraint_name === constraintName
    ) {
      return true;
    }
    cur = obj.cause;
  }
  return false;
}
