/**
 * `getProductWithVariants` service — chunk 1a.5.1.
 *
 * Composes a single product row with its options, values, and variants.
 * Three queries (no N+1). Role-gated for cost-price (mirrors getProduct).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `gpv-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
): Promise<{ id: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft', 500)
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return { id, updatedAt: new Date(arr[0]!.updated_at) };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("getProductWithVariants", () => {
  it("returns null for a phantom product id", async () => {
    const { getProductWithVariants } = await import(
      "@/server/services/variants/get-product-with-variants"
    );
    const tenantId = await makeTenant();
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      getProductWithVariants(tx, { id: tenantId }, "owner", {
        id: randomUUID(),
      }),
    );
    expect(out).toBeNull();
  });

  it("returns null for a cross-tenant product id (existence-leak guard)", async () => {
    const { getProductWithVariants } = await import(
      "@/server/services/variants/get-product-with-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productB = await seedProduct(tenantB);

    const out = await withTenant(superDb, ctxFor(tenantA), (tx) =>
      getProductWithVariants(tx, { id: tenantA }, "owner", {
        id: productB.id,
      }),
    );
    expect(out).toBeNull();
  });

  it("composes product + options + values + variants in a single read", async () => {
    const { getProductWithVariants } = await import(
      "@/server/services/variants/get-product-with-variants"
    );
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const opts = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          {
            name: { en: "Color", ar: "اللون" },
            values: [
              { value: { en: "Red", ar: "أحمر" } },
              { value: { en: "Blue", ar: "أزرق" } },
            ],
          },
        ],
      }),
    );
    const colorOption = opts.options[0]!;
    const redValueId = colorOption.values[0]!.id;
    const blueValueId = colorOption.values[1]!.id;

    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: opts.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: "SKU-RED",
            priceMinor: 1000,
            stock: 5,
            optionValueIds: [redValueId],
          },
          {
            sku: "SKU-BLUE",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [blueValueId],
          },
        ],
      }),
    );

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      getProductWithVariants(tx, { id: tenantId }, "owner", {
        id: product.id,
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.product.id).toBe(product.id);
    expect(out!.options).toHaveLength(1);
    expect(out!.options[0]!.values).toHaveLength(2);
    expect(out!.variants).toHaveLength(2);
    expect(out!.variants.map((v) => v.sku).sort()).toEqual(
      ["SKU-BLUE", "SKU-RED"],
    );
  });

  it("staff role sees product without costPriceMinor (Tier-B gate)", async () => {
    const { getProductWithVariants } = await import(
      "@/server/services/variants/get-product-with-variants"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      getProductWithVariants(tx, { id: tenantId }, "staff", {
        id: product.id,
      }),
    );
    expect(out).not.toBeNull();
    // Staff does not see costPriceMinor.
    expect(
      Object.prototype.hasOwnProperty.call(out!.product, "costPriceMinor"),
    ).toBe(false);
  });

  it("owner role sees costPriceMinor (Tier-B owner gate)", async () => {
    const { getProductWithVariants } = await import(
      "@/server/services/variants/get-product-with-variants"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      getProductWithVariants(tx, { id: tenantId }, "owner", {
        id: product.id,
      }),
    );
    expect(out).not.toBeNull();
    expect(
      (out!.product as { costPriceMinor?: number }).costPriceMinor,
    ).toBe(500);
  });
});
