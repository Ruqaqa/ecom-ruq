/**
 * Chunk 1a.7.1 Block 2 — storage adapter contract.
 *
 * Three-method interface, deliberately minimal. `list` is OUT (security
 * M-1: an enumeration surface widens the blast radius and the storefront
 * never needs it — the DB ledger is authoritative for what files exist).
 *
 * StorageBackendError carries an OPAQUE code only. The underlying vendor
 * error / cause is attached via `cause` so observability code can read
 * it (with `summarizeErrorForObs`) without ever surfacing it on the wire.
 *
 * `assertSafeStorageKey` is shared by both backends and the upstream
 * key-derivation service. Defense in depth: validation lives at the
 * producer (deriveStorageKey) AND at every backend method.
 *
 * Allowed key chars: [a-z0-9./-]. Periods are allowed because keys carry
 * a file extension (`.jpg`, `.webp`, `.avif`); the path-traversal threat
 * is the literal `..` segment, which has its own explicit rejection
 * separate from the char allowlist.
 */

export interface StorageAdapter {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export type StorageOpaqueCode = "upload_failed" | "fetch_failed" | "delete_failed";

export class StorageBackendError extends Error {
  readonly opaqueCode: StorageOpaqueCode;
  constructor(opaqueCode: StorageOpaqueCode, cause?: unknown) {
    super(opaqueCode);
    this.name = "StorageBackendError";
    this.opaqueCode = opaqueCode;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const SAFE_KEY_CHARS = /^[a-z0-9./-]+$/;

/**
 * Throws StorageBackendError("upload_failed") on rejection. The opaque
 * code is "upload_failed" regardless of which backend method is the
 * caller — the validator runs before any wire op, so attributing it to
 * a specific method would be wrong, and the caller treats every
 * StorageBackendError the same way (Sentry capture + opaque wire shape).
 *
 * Returns void on success.
 */
export function assertSafeStorageKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageBackendError("upload_failed", "key:empty");
  }
  // Order matters: explicit rejections first so a violation produces a
  // helpful internal-debug `cause` even though the wire shape is opaque.
  if (key.startsWith("/")) {
    throw new StorageBackendError("upload_failed", "key:leading-slash");
  }
  if (key.endsWith("/")) {
    throw new StorageBackendError("upload_failed", "key:trailing-slash");
  }
  if (key.includes("//")) {
    throw new StorageBackendError("upload_failed", "key:double-slash");
  }
  if (key.includes("\\")) {
    throw new StorageBackendError("upload_failed", "key:backslash");
  }
  if (key.includes("\0")) {
    throw new StorageBackendError("upload_failed", "key:nul");
  }
  // Reject any segment that starts with `.`. Catches `..` (path
  // traversal — the primary threat), `....` (would slip past an exact
  // `..` check), and `.hidden` patterns (no legitimate use case in our
  // key namespace). Architect-ratified belt-and-braces atop the char
  // allowlist.
  for (const seg of key.split("/")) {
    if (seg.length === 0) {
      // Inner empty segment — leading/trailing/double slashes are
      // already caught above, but a malformed split should fail closed.
      throw new StorageBackendError("upload_failed", "key:empty-segment");
    }
    if (seg.startsWith(".")) {
      throw new StorageBackendError("upload_failed", "key:leading-dot-segment");
    }
  }
  if (!SAFE_KEY_CHARS.test(key)) {
    throw new StorageBackendError("upload_failed", "key:bad-char");
  }
}
