/**
 * Magic-link token hashing.
 *
 * Better Auth v1.6 exposes `storeToken: { type: 'custom-hasher', hash: (token) => Promise<string> }`
 * on the magic-link plugin. We supply `hashMagicLinkToken` as that hasher so
 * the row written to `verification.value` is HMAC-SHA-256(TOKEN_HASH_PEPPER, token),
 * base64url-encoded. The plaintext token is only in the email the user
 * receives; a DB-only compromise yields no usable magic links.
 *
 * BA v1.6 does NOT expose a matching hash hook for email-verification
 * tokens — those are signed JWTs (HS256 with ctx.secret). Signature
 * verification is equivalent for our threat model (no DB storage of a
 * forgeable value), so no hashing gap exists there. Documented in
 * docs/runbooks/auth.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { hashMagicLinkToken } from "@/server/auth/magic-link-hash";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) {
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  }
});

describe("hashMagicLinkToken", () => {
  it("returns a base64url string", async () => {
    const out = await hashMagicLinkToken("magic-xyz");
    expect(typeof out).toBe("string");
    // 32 bytes → 43 base64url chars (no padding).
    expect(out).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await hashMagicLinkToken("magic-xyz");
    const b = await hashMagicLinkToken("magic-xyz");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await hashMagicLinkToken("magic-xyz");
    const b = await hashMagicLinkToken("magic-abc");
    expect(a).not.toBe(b);
  });

  it("uses TOKEN_HASH_PEPPER (reuses bearer-hash machinery): hash depends on pepper", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.TOKEN_HASH_PEPPER;
    const tok = "same-input";
    const a = await hashMagicLinkToken(tok);
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
    const b = await hashMagicLinkToken(tok);
    env.TOKEN_HASH_PEPPER = prev;
    expect(a).not.toBe(b);
  });
});
