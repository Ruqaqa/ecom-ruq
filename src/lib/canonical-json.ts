/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Thin wrapper over the `canonicalize` npm package so call sites have a
 * stable, discoverable import name. Deterministic key ordering, stable
 * number serialization (no `1.0` vs `1` drift), stable string escaping.
 *
 * Used by the audit middleware (chunk 6) for input_hash / before_hash /
 * after_hash / row_hash computations. DO NOT hand-roll canonicalization —
 * hash mismatch later turns audit into forensic garbage.
 */
import canonicalize from "canonicalize";

export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("canonicalJson: value is not JSON-serializable");
  return out;
}
