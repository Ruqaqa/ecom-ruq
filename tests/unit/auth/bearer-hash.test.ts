/**
 * PAT bearer-token hashing.
 *
 * - hashBearerToken produces HMAC-SHA-256(TOKEN_HASH_PEPPER, token).
 * - Output is 32 bytes (Buffer length).
 * - Same token always produces the same hash (deterministic).
 * - compareHashTimingSafe rejects wrong-length or mismatched values.
 *
 * ADR 0001 picks option (b): Better Auth's bearer plugin converts signed
 * session JWTs to cookies; it is NOT a PAT hasher. PATs therefore have
 * their own hash + lookup path. See docs/adr/0001-pat-storage.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { hashBearerToken, compareHashTimingSafe } from "@/server/auth/bearer-hash";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  // Set BEFORE any hash call; distinct pepper value from chunk-4 audit tests
  // so we prove the pepper is actually consumed.
  env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
});

describe("hashBearerToken", () => {
  it("returns a 32-byte buffer", () => {
    const h = hashBearerToken("eruq_pat_abc123");
    expect(h.length).toBe(32);
  });

  it("is deterministic", () => {
    const a = hashBearerToken("eruq_pat_abc123");
    const b = hashBearerToken("eruq_pat_abc123");
    expect(a.equals(b)).toBe(true);
  });

  it("differs when the token differs", () => {
    const a = hashBearerToken("eruq_pat_abc123");
    const b = hashBearerToken("eruq_pat_abc124");
    expect(a.equals(b)).toBe(false);
  });

  it("uses TOKEN_HASH_PEPPER: changing pepper changes the hash", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.TOKEN_HASH_PEPPER;
    const tok = "eruq_pat_xyz";
    const hashA = hashBearerToken(tok);
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
    // Invalidate the cached pepper in the module by re-requiring or
    // using the exported reset hook. We read through the env each call.
    const hashB = hashBearerToken(tok);
    env.TOKEN_HASH_PEPPER = prev;
    expect(hashA.equals(hashB)).toBe(false);
  });
});

describe("compareHashTimingSafe", () => {
  it("returns true for equal buffers", () => {
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(32, 0xaa);
    expect(compareHashTimingSafe(a, b)).toBe(true);
  });

  it("returns false for differing buffers", () => {
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(32, 0xbb);
    expect(compareHashTimingSafe(a, b)).toBe(false);
  });

  it("returns false for different-length buffers (timing-safe)", () => {
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(16, 0xaa);
    expect(compareHashTimingSafe(a, b)).toBe(false);
  });
});
