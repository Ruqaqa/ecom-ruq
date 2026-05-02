/**
 * Chunk 1a.7.1 Block 3 — deriveStorageKey unit tests.
 */
import { describe, it, expect } from "vitest";
import { deriveStorageKey } from "@/server/services/images/derive-key";
import { StorageBackendError } from "@/server/storage";

describe("deriveStorageKey", () => {
  it("emits the descriptive key pattern for a derivative", () => {
    const k = deriveStorageKey({
      tenantSlug: "ruqaqa",
      productSlug: "rode-podmic-ii",
      position: 0,
      version: 1,
      size: "card",
      format: "webp",
    });
    expect(k).toBe("ruqaqa/rode-podmic-ii-0-v1-card.webp");
  });

  it("emits the original key with `original` in the name", () => {
    const k = deriveStorageKey({
      tenantSlug: "ruqaqa",
      productSlug: "rode-podmic-ii",
      position: 2,
      version: 3,
      size: "original",
      format: "jpeg",
    });
    expect(k).toBe("ruqaqa/rode-podmic-ii-2-v3-original.jpg");
  });

  it.each([
    ["UPPER", "p", "uppercase tenant"],
    ["a", "P-Caps", "uppercase product"],
    ["a slug", "p", "spaces"],
    ["", "p", "empty tenant"],
    ["a", "", "empty product"],
    [
      "a",
      "p123456789012345678901234567890123456789012345678901234567890123456789",
      "product slug too long",
    ],
  ])("rejects unsafe slugs (%s, %s) — %s", (tenantSlug, productSlug) => {
    expect(() =>
      deriveStorageKey({
        tenantSlug,
        productSlug,
        position: 0,
        version: 1,
        size: "thumb",
        format: "webp",
      }),
    ).toThrow(StorageBackendError);
  });

  it("rejects negative position / version", () => {
    expect(() =>
      deriveStorageKey({
        tenantSlug: "a",
        productSlug: "b",
        position: -1,
        version: 1,
        size: "thumb",
        format: "webp",
      }),
    ).toThrow(StorageBackendError);
    expect(() =>
      deriveStorageKey({
        tenantSlug: "a",
        productSlug: "b",
        position: 0,
        version: 0,
        size: "thumb",
        format: "webp",
      }),
    ).toThrow(StorageBackendError);
  });
});
