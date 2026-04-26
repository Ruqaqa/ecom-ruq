import { findPgErrorRecord } from "@/server/db/pg-errors";

// True if `err` (or any cause up the chain) is a pg unique-violation
// (SQLSTATE 23505) on the named constraint. Used by createCategory and
// updateCategory to detect slug-collision and translate to SlugTakenError
// (the same error class products use — slug-collision is the same domain
// concept across catalog entities).
export function extractPgUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  const rec = findPgErrorRecord(err);
  return rec?.code === "23505" && rec.constraint_name === constraintName;
}
