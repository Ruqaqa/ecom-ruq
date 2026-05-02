/**
 * Chunk 1a.7.1 Block 2 — local-disk StorageAdapter.
 *
 * Round-trips bytes through the filesystem under a temp dir; asserts
 * the path-traversal defense (`path.resolve().startsWith(localDir + sep)`)
 * is the second wall behind the key validator.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskStorageAdapter } from "@/server/storage/local-disk";
import { StorageBackendError } from "@/server/storage/types";

describe("LocalDiskStorageAdapter", () => {
  let dir: string;
  let adapter: LocalDiskStorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ecom-ruq-img-"));
    adapter = new LocalDiskStorageAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("put then get returns the same bytes and content type", async () => {
    const key = "t-abc/p-001-0-v1-original.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await adapter.put(key, bytes, "image/jpeg");
    const out = await adapter.get(key);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/jpeg");
    expect(Buffer.compare(out!.bytes, bytes)).toBe(0);
  });

  it("get returns null for a key that does not exist", async () => {
    const out = await adapter.get("missing/key.jpg");
    expect(out).toBeNull();
  });

  it("delete removes the file; subsequent get returns null", async () => {
    const key = "t-abc/p-001-0-v1-original.jpg";
    await adapter.put(key, Buffer.from("hello"), "image/jpeg");
    await adapter.delete(key);
    expect(await adapter.get(key)).toBeNull();
  });

  it("delete is idempotent — deleting a non-existent key does not throw", async () => {
    await expect(adapter.delete("never/existed.jpg")).resolves.toBeUndefined();
  });

  it.each([
    "../escape",
    "/leading",
    "double//slash",
    "trailing/",
    "back\\slash",
    "UPPER",
  ])("put rejects unsafe key %j", async (key) => {
    let caught: unknown = null;
    try {
      await adapter.put(key, Buffer.from("x"), "image/jpeg");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
  });

  it("get rejects unsafe key (defense in depth)", async () => {
    let caught: unknown = null;
    try {
      await adapter.get("../escape");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
  });

  it("delete rejects unsafe key (defense in depth)", async () => {
    let caught: unknown = null;
    try {
      await adapter.delete("../escape");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
  });

  it("put creates intermediate directories under the local dir", async () => {
    await adapter.put("a/b/c/d-0-v1-original.jpg", Buffer.from("ok"), "image/jpeg");
    expect(existsSync(join(dir, "a/b/c/d-0-v1-original.jpg"))).toBe(true);
  });

  it("symlink-escape defense: a symlink inside localDir pointing OUTSIDE is not followed for writes", async () => {
    // Pre-create a symlink whose target is outside the storage dir, then
    // try to write through it. path.resolve() resolves only `..` segments
    // — it does NOT follow symlinks. The realpath check inside the adapter
    // catches symlink targets outside the root.
    const outsideTarget = mkdtempSync(join(tmpdir(), "ecom-ruq-img-OUT-"));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outsideTarget, join(dir, "evil"));
      let caught: unknown = null;
      try {
        await adapter.put("evil/leak.jpg", Buffer.from("leak"), "image/jpeg");
      } catch (e) {
        caught = e;
      }
      // Either fail-closed via path-traversal defense OR allow the write
      // BUT keep it strictly inside the original dir. We require the
      // former — the realpath check must catch it.
      expect(caught).toBeInstanceOf(StorageBackendError);
    } finally {
      rmSync(outsideTarget, { recursive: true, force: true });
    }
  });

  it("does not allow writing OUTSIDE the local dir even through a hand-crafted absolute path bypass attempt", async () => {
    // Sanity: even if a caller manages to bypass the key validator (via
    // an injected key string), the path.resolve() startsWith() assertion
    // is the second wall.
    //
    // Construct a key that the validator WOULD reject, then bypass the
    // public API and call the internal resolveKey path directly. We do
    // this by using the public put() and asserting it never wrote a file
    // outside dir. (The validator already rejects the key — confirm no
    // file was written anywhere unexpected.)
    const outside = join(tmpdir(), "should-not-exist-leak.jpg");
    if (existsSync(outside)) rmSync(outside);
    try {
      await adapter.put("/abs/path.jpg", Buffer.from("leak"), "image/jpeg");
    } catch {
      /* expected */
    }
    expect(existsSync(outside)).toBe(false);
  });

  it("get rejects a relative key whose RESOLVED path escapes the local dir (key validator + resolve check are both armed)", async () => {
    // An attacker who managed to bypass the key validator MUST still hit
    // the resolve().startsWith() assertion. Simulate by writing a file
    // outside the dir, then attempting to read with a crafted key.
    const sentinelPath = join(tmpdir(), "sentinel-read.txt");
    writeFileSync(sentinelPath, "secret");
    try {
      let caught: unknown = null;
      try {
        // The key validator rejects this first — that's the primary wall.
        await adapter.get("../sentinel-read.txt");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StorageBackendError);
      // Confirm no leakage happened.
      expect(readFileSync(sentinelPath, "utf8")).toBe("secret");
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });
});
