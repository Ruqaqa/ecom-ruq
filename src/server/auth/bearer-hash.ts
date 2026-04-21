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
 * Dual-pepper read path (sub-chunk 7.1 S-9):
 *   - `hashBearerToken` always produces the hash under the CURRENT pepper
 *     (used at write-time — issuance). This is the one that hits the DB
 *     unique index, so it must be deterministic per current env.
 *   - `hashBearerTokenAllPeppers` returns an array `[currentHash, ?prevHash]`
 *     where the previous entry is present iff `TOKEN_HASH_PEPPER_PREVIOUS`
 *     is set (same loader rules as the current one). `lookupBearerToken`
 *     uses this array to accept tokens hashed under either pepper during
 *     a rotation window. Tokens issued during the rotation get hashed
 *     under CURRENT only; tokens predating the rotation still resolve.
 *
 * See docs/adr/0001-pat-storage.md for the storage rationale and ADR
 * option-(b) outcome.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const KNOWN_DEV_PATTERNS = [/^change[-_]?me$/i, /^placeholder$/i, /^dev$/i, /^test$/i];
const PEPPER_MIN_BYTES = 32;

function loadPepperByEnvVar(envVar: "TOKEN_HASH_PEPPER" | "TOKEN_HASH_PEPPER_PREVIOUS"): Buffer {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`${envVar} is not set`);
  if (KNOWN_DEV_PATTERNS.some((re) => re.test(raw))) {
    throw new Error(`${envVar} appears to be a placeholder value`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${envVar} is not valid base64`);
  }
  if (decoded.length < PEPPER_MIN_BYTES) {
    throw new Error(
      `${envVar} must decode to at least ${PEPPER_MIN_BYTES} bytes, got ${decoded.length}`,
    );
  }
  if (decoded.every((b) => b === 0)) {
    throw new Error(`${envVar} is all zeros`);
  }
  return decoded;
}

function loadPepper(): Buffer {
  return loadPepperByEnvVar("TOKEN_HASH_PEPPER");
}

function tryLoadPreviousPepper(): Buffer | null {
  if (!process.env.TOKEN_HASH_PEPPER_PREVIOUS) return null;
  try {
    return loadPepperByEnvVar("TOKEN_HASH_PEPPER_PREVIOUS");
  } catch {
    // A malformed PREVIOUS pepper must NOT block valid current-pepper
    // lookups. Returning null keeps the read path alive; the loader has
    // already thrown on issuance paths (which only use the current
    // pepper).
    return null;
  }
}

export function hashBearerToken(plaintext: string): Buffer {
  return createHmac("sha256", loadPepper()).update(plaintext, "utf8").digest();
}

/**
 * Returns all hashes under which a plaintext might be stored. Order is
 * `[current, previous?]`. Lookup path uses this for the DB filter
 * (`tokenHash IN :hashes`) so rotation is seamless.
 */
export function hashBearerTokenAllPeppers(plaintext: string): Buffer[] {
  const hashes: Buffer[] = [
    createHmac("sha256", loadPepper()).update(plaintext, "utf8").digest(),
  ];
  const prev = tryLoadPreviousPepper();
  if (prev) {
    hashes.push(createHmac("sha256", prev).update(plaintext, "utf8").digest());
  }
  return hashes;
}

export function compareHashTimingSafe(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
