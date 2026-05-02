/**
 * `setProductImageAltText` integration tests (chunk 1a.7.1 Block 4).
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { setProductImageAltText } from "@/server/services/images/set-product-image-alt-text";
import { StaleWriteError } from "@/server/audit/error-codes";
import {
  ctxFor,
  makeTenant,
  seedProduct,
  superClient,
  superDb,
} from "./_helpers";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function seedImage(
  tenantId: string,
  productId: string,
  fingerprint: string,
  altText: { en?: string; ar?: string } | null = null,
): Promise<string> {
  const altJson = altText === null ? "NULL" : `'${JSON.stringify(altText)}'::jsonb`;
  const rows = await superDb.execute<{ id: string }>(sql`
    INSERT INTO product_images (
      tenant_id, product_id, position, version, fingerprint_sha256,
      storage_key, original_format, original_width, original_height,
      original_bytes, alt_text
    ) VALUES (
      ${tenantId}, ${productId}, 0, 1, ${fingerprint},
      'k-orig', 'jpeg', 1500, 1500, 1234,
      ${sql.raw(altJson)}
    )
    RETURNING id::text AS id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr[0]!.id;
}

async function readAltText(imageId: string): Promise<unknown> {
  const rows = await superDb.execute<{ alt_text: unknown }>(sql`
    SELECT alt_text FROM product_images WHERE id = ${imageId}
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ alt_text: unknown }> }).rows ?? []);
  return arr[0]!.alt_text;
}

describe("setProductImageAltText", () => {
  it("partial-merges over an existing pair (en-only update preserves ar)", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, "0".repeat(64), {
      en: "old english",
      ar: "نص عربي",
    });

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setProductImageAltText(tx, { id: tenant.id }, "owner", {
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        altText: { en: "new english" },
      }),
    );

    expect(result.altText).toEqual({ en: "new english", ar: "نص عربي" });
    expect(result.before).toEqual({
      imageId,
      hasEn: true,
      hasAr: true,
    });
    expect(result.after).toEqual({
      imageId,
      hasEn: true,
      hasAr: true,
    });

    const stored = await readAltText(imageId);
    expect(stored).toEqual({ en: "new english", ar: "نص عربي" });
  });

  it("clears the column when altText is null", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, "0".repeat(64), {
      en: "english",
      ar: "عربي",
    });

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setProductImageAltText(tx, { id: tenant.id }, "owner", {
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        altText: null,
      }),
    );

    expect(result.altText).toBeNull();
    expect(result.after).toEqual({ imageId, hasEn: false, hasAr: false });
    const stored = await readAltText(imageId);
    expect(stored).toBeNull();
  });

  it("audit shape carries presence flags only — strings never cross", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, "0".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setProductImageAltText(tx, { id: tenant.id }, "owner", {
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        altText: { en: "TOPSECRET-alt", ar: "نص-سري-للغاية" },
      }),
    );

    const before = JSON.stringify(result.before);
    const after = JSON.stringify(result.after);
    expect(before).not.toContain("TOPSECRET");
    expect(after).not.toContain("TOPSECRET");
    expect(before).not.toContain("نص-سري");
    expect(after).not.toContain("نص-سري");
  });

  it("throws NOT_FOUND image_not_found for a missing imageId", async () => {
    const tenant = await makeTenant();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setProductImageAltText(tx, { id: tenant.id }, "owner", {
          imageId: "00000000-0000-4000-8000-000000000000",
          expectedUpdatedAt: new Date().toISOString(),
          altText: null,
        }),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("image_not_found");
  });

  it("throws StaleWriteError on product OCC mismatch", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, "0".repeat(64));

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setProductImageAltText(tx, { id: tenant.id }, "owner", {
          imageId,
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
          altText: null,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
  });
});
