/**
 * PAT bearer-token hashing.
 *
 * HMAC-SHA-256(TOKEN_HASH_PEPPER, raw_token_bytes). The pepper lives outside
 * the DB (env-only, reused from chunk 4's boot-check loader), so a DB-only
 * compromise (SELECT * on access_tokens) does not yield usable credentials.
 *
 * Pepper loader semantics:
 *   - Reads TOKEN_HASH_PEPPER via process.env on every call (no module-scope
 *     cache). This lets integration tests rotate the pepper and observe
 *     different output without process restart.
 *   - Rejects empty / placeholder / short (<32 bytes) values.
 *
 * See docs/adr/0001-pat-storage.md for the storage rationale and ADR
 * option-(b) outcome.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const KNOWN_DEV_PATTERNS = [/^change[-_]?me$/i, /^placeholder$/i, /^dev$/i, /^test$/i];
const PEPPER_MIN_BYTES = 32;

function loadPepper(): Buffer {
  const raw = process.env.TOKEN_HASH_PEPPER;
  if (!raw) throw new Error("TOKEN_HASH_PEPPER is not set");
  if (KNOWN_DEV_PATTERNS.some((re) => re.test(raw))) {
    throw new Error("TOKEN_HASH_PEPPER appears to be a placeholder value");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error("TOKEN_HASH_PEPPER is not valid base64");
  }
  if (decoded.length < PEPPER_MIN_BYTES) {
    throw new Error(`TOKEN_HASH_PEPPER must decode to at least ${PEPPER_MIN_BYTES} bytes, got ${decoded.length}`);
  }
  if (decoded.every((b) => b === 0)) {
    throw new Error("TOKEN_HASH_PEPPER is all zeros");
  }
  return decoded;
}

export function hashBearerToken(plaintext: string): Buffer {
  return createHmac("sha256", loadPepper()).update(plaintext, "utf8").digest();
}

export function compareHashTimingSafe(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
