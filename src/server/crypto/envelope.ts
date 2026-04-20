/**
 * Tier-A envelope encryption.
 *
 * Outer (KEK): AES-256-GCM keyed by DATA_KEK_BASE64 (32 bytes base64). Wraps a
 * per-tenant random 32-byte DEK that is stored as `tenant_keys.wrapped_dek`.
 *   Wrapping AAD = tenant_id || dek_version (bytes).
 *
 * Inner (DEK): AES-256-GCM keyed by the unwrapped tenant DEK. Encrypts the
 * Tier-A payload, stored as `identity_verifications.payload`.
 *   Payload AAD = tenant_id || identity_verifications.id || dek_version (bytes).
 *
 * Self-describing blob layout. Byte 0 is the format version; the helper below
 * dispatches to the right AEAD on that byte.
 *
 *   format_version = 1  (AES-256-GCM — the only version supported today)
 *     byte 0          = 0x01
 *     bytes 1..12     = 12-byte GCM nonce
 *     bytes 13..N-16  = ciphertext
 *     bytes N-16..N   = 16-byte GCM auth tag
 *
 * A future XChaCha20-Poly1305 bump is format_version = 2 with a different
 * nonce length; the dispatch at byte 0 handles both without schema change.
 *
 * decryptTierA invariant (enforced at the service layer, documented here):
 * returns plaintext only if an audit_log row with operation 'tier_a.read'
 * commits in the enclosing transaction. If the audit insert fails, the tx
 * rolls back and the plaintext is discarded in-process; the caller sees an
 * exception, never the plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FORMAT_VERSION_V1 = 1;

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32;
const KEK_BYTES = 32;

const KNOWN_DEV_PATTERNS = [/^change[-_]?me$/i, /^placeholder$/i, /^dev$/i, /^test$/i];

let cachedKek: Buffer | null = null;

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesFromInt(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

export function assertKekReady(): void {
  loadKek();
}

export function loadKek(): Buffer {
  if (cachedKek) return cachedKek;
  const raw = process.env.DATA_KEK_BASE64;
  if (!raw) throw new Error("DATA_KEK_BASE64 is not set");
  if (KNOWN_DEV_PATTERNS.some((re) => re.test(raw))) {
    throw new Error("DATA_KEK_BASE64 appears to be a placeholder value");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error("DATA_KEK_BASE64 is not valid base64");
  }
  if (decoded.length !== KEK_BYTES) {
    throw new Error(`DATA_KEK_BASE64 must decode to ${KEK_BYTES} bytes, got ${decoded.length}`);
  }
  if (decoded.every((b) => b === 0)) {
    throw new Error("DATA_KEK_BASE64 is all zeros");
  }
  cachedKek = decoded;
  return decoded;
}

export function readFormatVersion(blob: Buffer): number {
  if (blob.length < 1) throw new Error("empty blob");
  return blob.readUInt8(0);
}

function aeadEncryptV1(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION_V1]), nonce, ct, tag]);
}

function aeadDecryptV1(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const MIN_LEN = 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES;
  if (blob.length < MIN_LEN) throw new Error("ciphertext too short");
  const version = blob.readUInt8(0);
  if (version !== FORMAT_VERSION_V1) {
    throw new Error(`unsupported Tier-A format version ${version}`);
  }
  const nonce = blob.subarray(1, 1 + GCM_NONCE_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const ct = blob.subarray(1 + GCM_NONCE_BYTES, blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function wrapDek(dek: Buffer, tenantId: string, dekVersion: number): Buffer {
  const aad = Buffer.concat([uuidToBytes(tenantId), bytesFromInt(dekVersion)]);
  return aeadEncryptV1(loadKek(), dek, aad);
}

export function unwrapDek(wrapped: Buffer, tenantId: string, dekVersion: number): Buffer {
  const aad = Buffer.concat([uuidToBytes(tenantId), bytesFromInt(dekVersion)]);
  return aeadDecryptV1(loadKek(), wrapped, aad);
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function encryptTierAPayload(
  plaintext: Buffer,
  dek: Buffer,
  tenantId: string,
  recordId: string,
  dekVersion: number,
): Buffer {
  const aad = Buffer.concat([uuidToBytes(tenantId), uuidToBytes(recordId), bytesFromInt(dekVersion)]);
  return aeadEncryptV1(dek, plaintext, aad);
}

export function decryptTierAPayload(
  blob: Buffer,
  dek: Buffer,
  tenantId: string,
  recordId: string,
  dekVersion: number,
): Buffer {
  const aad = Buffer.concat([uuidToBytes(tenantId), uuidToBytes(recordId), bytesFromInt(dekVersion)]);
  return aeadDecryptV1(dek, blob, aad);
}
