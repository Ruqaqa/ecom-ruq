/**
 * Chunk 1a.7.1 Block 2 — storage key validation.
 *
 * Both backends AND the upstream key-derivation service must reject:
 *   - any segment starting with `.` (covers `..`, `....`, `.hidden`)
 *   - leading `/`
 *   - double `//`
 *   - trailing `/`
 *   - NUL byte
 *   - backslash
 *   - any char outside [a-z0-9./-]
 *   - empty string
 *
 * Single dot WITHIN a segment is allowed because keys carry a file
 * extension (`.jpg`, `.webp`, `.avif`); the path-traversal threat is a
 * `..` SEGMENT, not the `.` character per se. The leading-dot-segment
 * rule defeats both `..` and `....` (which would slip past an exact
 * `..` match) plus blocks hidden-file conventions that have no
 * legitimate use in our key namespace.
 *
 * The function is shared and pure — `assertSafeStorageKey(key)` throws
 * StorageBackendError on rejection. Defense in depth: validation lives
 * here AND in deriveStorageKey() on the producer side.
 */
import { describe, it, expect } from "vitest";
import {
  assertSafeStorageKey,
  StorageBackendError,
} from "@/server/storage/types";

describe("assertSafeStorageKey", () => {
  it.each([
    ["", "empty"],
    ["..", "single-segment .."],
    ["x/../y", "embedded .."],
    ["....", "four-dot segment slips past exact `..` check"],
    [".hidden", "leading dot (hidden-file convention)"],
    ["a/.hidden/b", "hidden segment in middle"],
    [".env.local", "leading-dot with extension"],
    ["/leading-slash", "leading slash"],
    ["double//slash", "double slash"],
    ["trailing/", "trailing slash"],
    ["a\x00b", "embedded NUL byte"],
    ["back\\slash", "backslash"],
    ["UPPERCASE", "uppercase letter"],
    ["space in-key", "ASCII space"],
    ["weird@char", "punctuation outside the allowlist"],
    ["aéb", "non-ASCII character"],
  ])("rejects %j (%s)", (key) => {
    let caught: unknown = null;
    try {
      assertSafeStorageKey(key);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
  });

  it.each([
    ["t-abc/p-001-0-v1-original.jpg", "real key with extension"],
    ["a/b-0-v1-thumb.webp", "thumb webp"],
    ["t-abc/p-001-0-v1-share.avif", "share avif"],
    ["only-one-segment.jpg", "single-segment with extension"],
    ["a-b-c", "no extension is fine"],
    ["nested/deeply/safe-key.jpg", "deeper nesting"],
  ])("accepts %j (%s)", (key) => {
    expect(() => assertSafeStorageKey(key)).not.toThrow();
  });

  it("encodes opaque error code on rejection", () => {
    let caught: StorageBackendError | null = null;
    try {
      assertSafeStorageKey("../etc/passwd");
    } catch (e) {
      caught = e as StorageBackendError;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
    expect(caught?.opaqueCode).toBe("upload_failed");
  });
});
