/**
 * Better Auth magic-link `storeToken.type: 'custom-hasher'` implementation.
 *
 * BA writes the hasher's output to `verification.value`. We write a
 * base64url-encoded HMAC-SHA-256(TOKEN_HASH_PEPPER, token). This means:
 *   - DB-only compromise yields hashes, not usable magic links.
 *   - The plaintext token only lives in the email the user receives.
 *   - BA's own verification path hashes the incoming plaintext the same way
 *     and looks up the row by the hashed value — so as long as both sides
 *     use the same hasher, the round-trip works.
 *
 * Kept distinct from bearer-hash's `hashBearerToken` purely because BA
 * expects a string return type (its own `defaultKeyHasher` returns
 * base64url string); sharing the underlying HMAC keeps operational
 * simplicity. See docs/adr/0001-pat-storage.md for the pepper rationale
 * and docs/runbooks/auth.md for the BA hash-hook integration notes.
 */
import { hashBearerToken } from "./bearer-hash";

export async function hashMagicLinkToken(token: string): Promise<string> {
  return hashBearerToken(token).toString("base64url");
}
