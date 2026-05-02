/**
 * Chunk 1a.7.1 Block 2 — getStorageAdapter() factory.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { LocalDiskStorageAdapter } from "@/server/storage/local-disk";
import { BunnyCdnStorageAdapter } from "@/server/storage/bunnycdn";

const ENV_KEYS = [
  "IMAGE_STORAGE_BACKEND",
  "IMAGE_STORAGE_LOCAL_DIR",
  "BUNNY_STORAGE_ZONE",
  "BUNNY_STORAGE_REGION",
  "BUNNY_STORAGE_PASSWORD",
];

describe("getStorageAdapter() factory", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns LocalDiskStorageAdapter by default (backend unset)", async () => {
    const { getStorageAdapter } = await import("@/server/storage");
    const a = getStorageAdapter();
    expect(a).toBeInstanceOf(LocalDiskStorageAdapter);
  });

  it("returns LocalDiskStorageAdapter when IMAGE_STORAGE_BACKEND=local", async () => {
    process.env.IMAGE_STORAGE_BACKEND = "local";
    const { getStorageAdapter } = await import("@/server/storage");
    expect(getStorageAdapter()).toBeInstanceOf(LocalDiskStorageAdapter);
  });

  it("returns BunnyCdnStorageAdapter when bunny is fully configured", async () => {
    process.env.IMAGE_STORAGE_BACKEND = "bunny";
    process.env.BUNNY_STORAGE_ZONE = "z1";
    process.env.BUNNY_STORAGE_REGION = "ny";
    process.env.BUNNY_STORAGE_PASSWORD = "pw";
    const { getStorageAdapter } = await import("@/server/storage");
    expect(getStorageAdapter()).toBeInstanceOf(BunnyCdnStorageAdapter);
  });

  it.each([
    ["BUNNY_STORAGE_ZONE", { BUNNY_STORAGE_REGION: "ny", BUNNY_STORAGE_PASSWORD: "pw" }],
    ["BUNNY_STORAGE_REGION", { BUNNY_STORAGE_ZONE: "z1", BUNNY_STORAGE_PASSWORD: "pw" }],
    ["BUNNY_STORAGE_PASSWORD", { BUNNY_STORAGE_ZONE: "z1", BUNNY_STORAGE_REGION: "ny" }],
  ])(
    "throws when bunny is selected but %s is unset",
    async (_missing, present) => {
      process.env.IMAGE_STORAGE_BACKEND = "bunny";
      for (const [k, v] of Object.entries(present)) process.env[k] = v;
      const { getStorageAdapter } = await import("@/server/storage");
      expect(() => getStorageAdapter()).toThrow(/bunny/i);
    },
  );

  it("rejects unknown backend value", async () => {
    process.env.IMAGE_STORAGE_BACKEND = "s3";
    const { getStorageAdapter } = await import("@/server/storage");
    expect(() => getStorageAdapter()).toThrow(/IMAGE_STORAGE_BACKEND/);
  });
});
