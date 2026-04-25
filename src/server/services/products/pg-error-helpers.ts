import { findPgErrorRecord } from "@/server/db/pg-errors";

// True if `err` (or any cause up the chain) is a pg unique-violation
// (SQLSTATE 23505) on the named constraint. Used by createProduct and
// updateProduct to detect slug-collision and translate to SlugTakenError.
export function extractPgUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  const rec = findPgErrorRecord(err);
  return rec?.code === "23505" && rec.constraint_name === constraintName;
}
