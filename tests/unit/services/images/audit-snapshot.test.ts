/**
 * Audit-snapshot helpers for the image pipeline (chunk 1a.7.1).
 *
 * The wire return for image services carries the full row (admin UI
 * needs storage keys + derivative ledger); the append-only audit chain
 * receives a BOUNDED snapshot. Per the architect's brief + security
 * sign-off, the per-image audit shape is:
 *   { imageId, fingerprintSha256, position, derivativeCount,
 *     derivativeSizes (sorted+deduped), originalFormat, productId }
 *
 * Storage keys NEVER cross into audit. Alt-text strings NEVER cross —
 * setProductImageAltText audits only `{ imageId, hasEn, hasAr }`.
 */
import { describe, it, expect } from "vitest";
import {
  buildImageAuditSnapshot,
  buildAltTextAuditSnapshot,
  buildCoverSwapAuditSnapshot,
  buildVariantCoverAuditSnapshot,
  type ImageAuditInput,
} from "@/server/services/images/audit-snapshot";
import type { ImageDerivative } from "@/server/db/schema/_types";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VARIANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FP_A = "0".repeat(64);
const FP_B = "1".repeat(64);

function deriv(
  size: ImageDerivative["size"],
  format: ImageDerivative["format"],
  storageKey: string,
): ImageDerivative {
  return { size, format, width: 100, height: 100, storageKey, bytes: 1234 };
}

function fullDerivativeSet(): ImageDerivative[] {
  const sizes: ImageDerivative["size"][] = [
    "thumb",
    "card",
    "page",
    "zoom",
    "share",
  ];
  const formats: ImageDerivative["format"][] = ["avif", "webp", "jpeg"];
  const out: ImageDerivative[] = [];
  for (const s of sizes) {
    for (const f of formats) {
      out.push(deriv(s, f, `secret-key-${s}-${f}.${f}`));
    }
  }
  return out;
}

describe("buildImageAuditSnapshot", () => {
  it("captures imageId, fingerprintSha256, position, derivativeCount, sorted+deduped sizes, originalFormat, productId", () => {
    const input: ImageAuditInput = {
      imageId: IMAGE_A,
      fingerprintSha256: FP_A,
      position: 2,
      derivatives: fullDerivativeSet(),
      originalFormat: "jpeg",
      productId: PRODUCT_ID,
    };

    const snap = buildImageAuditSnapshot(input);

    expect(snap.imageId).toBe(IMAGE_A);
    expect(snap.fingerprintSha256).toBe(FP_A);
    expect(snap.position).toBe(2);
    expect(snap.derivativeCount).toBe(15);
    // Sizes sorted alphabetically, deduped (one entry per size though
    // there are 3 formats per size).
    expect(snap.derivativeSizes).toEqual([
      "card",
      "page",
      "share",
      "thumb",
      "zoom",
    ]);
    expect(snap.originalFormat).toBe("jpeg");
    expect(snap.productId).toBe(PRODUCT_ID);
  });

  it("derivativeSizes is empty when no derivatives are present (delete-image audit shape)", () => {
    const snap = buildImageAuditSnapshot({
      imageId: IMAGE_A,
      fingerprintSha256: FP_A,
      position: 0,
      derivatives: [],
      originalFormat: "png",
      productId: PRODUCT_ID,
    });
    expect(snap.derivativeCount).toBe(0);
    expect(snap.derivativeSizes).toEqual([]);
  });

  it("snapshot key set is locked — no extra fields, no storage keys, no alt-text", () => {
    const snap = buildImageAuditSnapshot({
      imageId: IMAGE_A,
      fingerprintSha256: FP_A,
      position: 0,
      derivatives: fullDerivativeSet(),
      originalFormat: "webp",
      productId: PRODUCT_ID,
    });
    expect(Object.keys(snap).sort()).toEqual([
      "derivativeCount",
      "derivativeSizes",
      "fingerprintSha256",
      "imageId",
      "originalFormat",
      "position",
      "productId",
    ]);
  });

  it("contains no storage keys (PDPL guard — keys never cross into audit)", () => {
    const snap = buildImageAuditSnapshot({
      imageId: IMAGE_A,
      fingerprintSha256: FP_A,
      position: 0,
      derivatives: fullDerivativeSet(),
      originalFormat: "jpeg",
      productId: PRODUCT_ID,
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("secret-key-");
    expect(serialized).not.toMatch(/"storageKey"/);
    expect(serialized).not.toMatch(/"width"/);
    expect(serialized).not.toMatch(/"height"/);
    expect(serialized).not.toMatch(/"bytes"/);
  });

  it("dedupes sizes correctly even if a derivative list omits some formats", () => {
    const partial: ImageDerivative[] = [
      deriv("thumb", "avif", "k1"),
      deriv("thumb", "webp", "k2"),
      deriv("page", "jpeg", "k3"),
    ];
    const snap = buildImageAuditSnapshot({
      imageId: IMAGE_A,
      fingerprintSha256: FP_A,
      position: 0,
      derivatives: partial,
      originalFormat: "jpeg",
      productId: PRODUCT_ID,
    });
    expect(snap.derivativeCount).toBe(3);
    expect(snap.derivativeSizes).toEqual(["page", "thumb"]);
  });
});

describe("buildAltTextAuditSnapshot", () => {
  it("emits { imageId, hasEn:true, hasAr:true } when both sides are populated", () => {
    const snap = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: { en: "english copy", ar: "نص عربي" },
    });
    expect(snap).toEqual({
      imageId: IMAGE_A,
      hasEn: true,
      hasAr: true,
    });
  });

  it("emits { hasEn:true, hasAr:false } when only en is set", () => {
    const snap = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: { en: "english only" },
    });
    expect(snap).toEqual({
      imageId: IMAGE_A,
      hasEn: true,
      hasAr: false,
    });
  });

  it("emits { hasEn:false, hasAr:true } when only ar is set", () => {
    const snap = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: { ar: "عربي فقط" },
    });
    expect(snap).toEqual({
      imageId: IMAGE_A,
      hasEn: false,
      hasAr: true,
    });
  });

  it("emits { hasEn:false, hasAr:false } when altText is null", () => {
    const snap = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: null,
    });
    expect(snap).toEqual({
      imageId: IMAGE_A,
      hasEn: false,
      hasAr: false,
    });
  });

  it("treats empty-string and undefined as 'absent' (no false-positive presence flag)", () => {
    const snapEmptyEn = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: { en: "", ar: "ar" },
    });
    expect(snapEmptyEn).toEqual({
      imageId: IMAGE_A,
      hasEn: false,
      hasAr: true,
    });
  });

  it("never echoes the alt-text strings themselves (PDPL guard)", () => {
    const snap = buildAltTextAuditSnapshot({
      imageId: IMAGE_A,
      altText: { en: "TOPSECRET-EN-COPY", ar: "نص-سري-للغاية" },
    });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("TOPSECRET");
    expect(serialized).not.toContain("نص-سري");
    expect(Object.keys(snap).sort()).toEqual(["hasAr", "hasEn", "imageId"]);
  });
});

describe("buildCoverSwapAuditSnapshot", () => {
  it("captures both image refs + before/after positions", () => {
    const snap = buildCoverSwapAuditSnapshot({
      productId: PRODUCT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
      oldCoverOldPosition: 0,
      newCoverOldPosition: 3,
    });
    expect(snap).toEqual({
      productId: PRODUCT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
      oldCoverOldPosition: 0,
      newCoverOldPosition: 3,
    });
  });

  it("supports a no-op swap (target image is already the cover)", () => {
    const snap = buildCoverSwapAuditSnapshot({
      productId: PRODUCT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_A,
      oldCoverOldPosition: 0,
      newCoverOldPosition: 0,
    });
    expect(snap.oldCoverImageId).toBe(snap.newCoverImageId);
  });

  it("snapshot key set is locked — no derivative ledger, no storage keys", () => {
    const snap = buildCoverSwapAuditSnapshot({
      productId: PRODUCT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
      oldCoverOldPosition: 0,
      newCoverOldPosition: 2,
    });
    expect(Object.keys(snap).sort()).toEqual([
      "newCoverImageId",
      "newCoverOldPosition",
      "oldCoverImageId",
      "oldCoverOldPosition",
      "productId",
    ]);
  });
});

describe("buildVariantCoverAuditSnapshot", () => {
  it("captures variantId and before/after coverImageId", () => {
    const snap = buildVariantCoverAuditSnapshot({
      variantId: VARIANT_ID,
      oldCoverImageId: null,
      newCoverImageId: IMAGE_A,
    });
    expect(snap).toEqual({
      variantId: VARIANT_ID,
      oldCoverImageId: null,
      newCoverImageId: IMAGE_A,
    });
  });

  it("supports clearing the cover (newCoverImageId = null)", () => {
    const snap = buildVariantCoverAuditSnapshot({
      variantId: VARIANT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: null,
    });
    expect(snap.newCoverImageId).toBeNull();
    expect(snap.oldCoverImageId).toBe(IMAGE_A);
  });

  it("snapshot key set is locked", () => {
    const snap = buildVariantCoverAuditSnapshot({
      variantId: VARIANT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
    });
    expect(Object.keys(snap).sort()).toEqual([
      "newCoverImageId",
      "oldCoverImageId",
      "variantId",
    ]);
  });

  it("identical input produces an identical shape (forensic-comparable)", () => {
    const a = buildVariantCoverAuditSnapshot({
      variantId: VARIANT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
    });
    const b = buildVariantCoverAuditSnapshot({
      variantId: VARIANT_ID,
      oldCoverImageId: IMAGE_A,
      newCoverImageId: IMAGE_B,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// FP_B is referenced indirectly so it stays an export-shaped local
// constant (TypeScript noUnusedLocals).
void FP_B;
