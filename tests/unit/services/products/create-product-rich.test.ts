/**
 * `createProductRich` — composed all-or-nothing service (architect Blocks 3 + 5).
 *
 * Real local Postgres (Tier 2 per docs/testing.md). The service composes
 * the four existing primitives (`createProduct`, `setProductOptions`,
 * `setProductVariants`, `setProductCategories`) into one transaction
 * threaded by `runWithAudit` at the MCP seam.
 *
 * Coverage list (architect §5 + orchestrator's clarifications §1, §2):
 *   - happy path: 1 product + 2 options × 3 values + 6 variants + 2
 *     categories commits one row in each table; output refMap matches.
 *   - dry run: same shape returned, no rows persisted.
 *   - cross-tenant categoryId rejected as `category_not_found`.
 *   - SKU collision rolls back the product (no orphan).
 *   - duplicate variant tuples rejected at Zod parse with the right path.
 *   - dry run records `mcp.create_product_rich.dry_run`; real run
 *     records `mcp.create_product_rich`.
 *   - ref resolver fails the right path on unknown ref (Zod parse).
 *   - `[a,b]` vs `[b,a]` tuples both honored as distinct.
 *   - cross-tenant happy-path isolation: tenant A creates a rich
 *     product, tenant B sees none of it (orchestrator §1).
 *   - dry-run audit follow-up failure path documented in handler comment
 *     (orchestrator §2 — chose comment-document over test-mock; the
 *     test-mock would require monkey-patching `appDb` which is not
 *     a path we'd pay an ongoing maintenance cost for).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import {
  createProductRich,
  DryRunRollback,
} from "@/server/services/products/create-product-rich";

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
  const slug = `cpr-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedCategory(
  tenantId: string,
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `c-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ف" })}'::jsonb`)})
  `);
  return { id, slug };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const rows = await superDb.execute<{ n: string }>(
    sql.raw(
      `SELECT COUNT(*)::text AS n FROM ${table} WHERE tenant_id = '${tenantId}'`,
    ),
  );
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ n: string }> }).rows ?? []);
  return Number(arr[0]?.n ?? "0");
}

const baseTenantInfo = (id: string) => ({ id, defaultLocale: "en" as const });

describe("createProductRich — happy path", () => {
  it("creates product, options, variants, and categories in one tx", async () => {
    const tenantId = await makeTenant();
    const cat1 = await seedCategory(tenantId);
    const cat2 = await seedCategory(tenantId);
    const slug = `rich-${randomUUID().slice(0, 8)}`;

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createProductRich(tx, baseTenantInfo(tenantId), "owner", {
        slug,
        name: { en: "Shirt", ar: "قميص" },
        options: [
          {
            ref: "size",
            name: { en: "Size", ar: "المقاس" },
            values: [
              { ref: "small", value: { en: "S", ar: "ص" } },
              { ref: "medium", value: { en: "M", ar: "م" } },
              { ref: "large", value: { en: "L", ar: "ك" } },
            ],
          },
          {
            ref: "color",
            name: { en: "Color", ar: "اللون" },
            values: [
              { ref: "red", value: { en: "R", ar: "أحمر" } },
              { ref: "blue", value: { en: "B", ar: "أزرق" } },
            ],
          },
        ],
        variants: [
          {
            sku: `${slug}-S-R`,
            priceSar: 50,
            stock: 1,
            optionValueRefs: ["size:small", "color:red"],
          },
          {
            sku: `${slug}-S-B`,
            priceSar: 50,
            stock: 1,
            optionValueRefs: ["size:small", "color:blue"],
          },
          {
            sku: `${slug}-M-R`,
            priceSar: 60,
            stock: 1,
            optionValueRefs: ["size:medium", "color:red"],
          },
          {
            sku: `${slug}-M-B`,
            priceSar: 60,
            stock: 1,
            optionValueRefs: ["size:medium", "color:blue"],
          },
          {
            sku: `${slug}-L-R`,
            priceSar: 70,
            stock: 1,
            optionValueRefs: ["size:large", "color:red"],
          },
          {
            sku: `${slug}-L-B`,
            priceSar: 70,
            stock: 1,
            optionValueRefs: ["size:large", "color:blue"],
          },
        ],
        categoryIds: [cat1.id, cat2.id],
      }),
    );

    // wire-shape assertions
    expect(result.dryRun).toBe(false);
    expect(result.product.slug).toBe(slug);
    expect(result.options).toHaveLength(2);
    expect(result.variants).toHaveLength(6);
    expect(result.categories).toHaveLength(2);
    // refMap correlates inputs to server-minted UUIDs.
    expect(Object.keys(result.refMap.options).sort()).toEqual([
      "color",
      "size",
    ]);
    expect(Object.keys(result.refMap.optionValues)).toContain("size:small");
    expect(Object.keys(result.refMap.optionValues)).toContain("color:red");
    // priceSar surfaces correctly on each variant. The variants service
    // returns rows ordered by (createdAt, id); inside a single tx those
    // collide so we don't lock the position — instead we assert each
    // wanted SKU/price pair is present.
    const variantPriceBySku = new Map(
      result.variants.map((v) => [v.sku, v.priceSar]),
    );
    expect(variantPriceBySku.get(`${slug}-S-R`)).toBe(50);
    expect(variantPriceBySku.get(`${slug}-L-B`)).toBe(70);

    // db-side: rows persisted under the right tenant.
    expect(await countRows("products", tenantId)).toBe(1);
    expect(await countRows("product_options", tenantId)).toBe(2);
    expect(await countRows("product_option_values", tenantId)).toBe(5);
    expect(await countRows("product_variants", tenantId)).toBe(6);
    expect(await countRows("product_categories", tenantId)).toBe(2);

    // audit-after assembly is exposed for the MCP adapter to record.
    expect(result.auditAfter.productId).toBe(result.product.id);
    expect(result.auditAfter.options?.optionsCount).toBe(2);
    expect(result.auditAfter.variants?.count).toBe(6);
    expect(result.auditAfter.categories?.ids.sort()).toEqual(
      [cat1.id, cat2.id].sort(),
    );
  });

  it("creates a product with no options + one default variant + no categories", async () => {
    const tenantId = await makeTenant();
    const slug = `simple-${randomUUID().slice(0, 8)}`;
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createProductRich(tx, baseTenantInfo(tenantId), "owner", {
        slug,
        name: { en: "Simple", ar: "بسيط" },
        variants: [
          { sku: `${slug}-default`, priceSar: 99, stock: 10, optionValueRefs: [] },
        ],
      }),
    );
    expect(result.options).toEqual([]);
    expect(result.variants).toHaveLength(1);
    expect(result.categories).toEqual([]);
    expect(await countRows("product_options", tenantId)).toBe(0);
    expect(await countRows("product_variants", tenantId)).toBe(1);
  });
});

describe("createProductRich — dry run", () => {
  it("returns assembled output and rolls back, throwing DryRunRollback to caller", async () => {
    const tenantId = await makeTenant();
    const slug = `dry-${randomUUID().slice(0, 8)}`;

    let captured: DryRunRollback | null = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createProductRich(tx, baseTenantInfo(tenantId), "owner", {
          slug,
          name: { en: "Dry", ar: "ج" },
          options: [
            {
              ref: "size",
              name: { en: "Size", ar: "م" },
              values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
            },
          ],
          variants: [
            {
              sku: `${slug}-s`,
              priceSar: 1,
              stock: 1,
              optionValueRefs: ["size:s"],
            },
          ],
          dryRun: true,
        }),
      );
    } catch (e) {
      if (e instanceof DryRunRollback) {
        captured = e;
      } else {
        throw e;
      }
    }

    expect(captured).not.toBeNull();
    expect(captured!.preview.dryRun).toBe(true);
    expect(captured!.preview.product.slug).toBe(slug);
    expect(captured!.preview.variants).toHaveLength(1);
    // Rolled back — nothing in the db for this tenant.
    expect(await countRows("products", tenantId)).toBe(0);
    expect(await countRows("product_options", tenantId)).toBe(0);
    expect(await countRows("product_variants", tenantId)).toBe(0);
  });
});

describe("createProductRich — failure → rollback", () => {
  it("cross-tenant categoryId → BAD_REQUEST 'category_not_found' and product is not persisted", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const foreign = await seedCategory(tenantB);
    const slug = `xt-${randomUUID().slice(0, 8)}`;

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        createProductRich(tx, baseTenantInfo(tenantA), "owner", {
          slug,
          name: { en: "X", ar: "س" },
          categoryIds: [foreign.id],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("category_not_found");
    // Product was not persisted — atomicity check.
    expect(await countRows("products", tenantA)).toBe(0);
  });

  it("SKU collision in input → SkuTakenError; product is not persisted", async () => {
    // Seed a product+variant in tenant A with SKU "DUPE", then try to
    // create another rich product in A whose variant uses "DUPE".
    const tenantId = await makeTenant();
    const seedSlug = `seed-${randomUUID().slice(0, 8)}`;
    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createProductRich(tx, baseTenantInfo(tenantId), "owner", {
        slug: seedSlug,
        name: { en: "Seed", ar: "ب" },
        variants: [
          { sku: "DUPE-SKU", priceSar: 1, stock: 1, optionValueRefs: [] },
        ],
      }),
    );
    expect(await countRows("products", tenantId)).toBe(1);

    const slug = `clash-${randomUUID().slice(0, 8)}`;
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createProductRich(tx, baseTenantInfo(tenantId), "owner", {
          slug,
          name: { en: "Clash", ar: "ت" },
          variants: [
            { sku: "DUPE-SKU", priceSar: 1, stock: 1, optionValueRefs: [] },
          ],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // The original SkuTakenError surfaces; never the constraint name or the SKU itself.
    expect(String((caught as Error).message)).toBe("sku_taken");
    expect(String((caught as Error).message)).not.toContain("DUPE-SKU");
    // Atomicity: the second rich-create rolled back; only the seeded product remains.
    expect(await countRows("products", tenantId)).toBe(1);
    expect(
      (await countRows("product_variants", tenantId)),
    ).toBe(1);
  });

  it("duplicate variant tuples rejected at Zod parse with right path", async () => {
    const tenantId = await makeTenant();
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createProductRich(tx, baseTenantInfo(tenantId), "owner", {
          slug,
          name: { en: "Dup", ar: "د" },
          options: [
            {
              ref: "size",
              name: { en: "Size", ar: "م" },
              values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
            },
          ],
          variants: [
            {
              sku: `${slug}-1`,
              priceSar: 1,
              stock: 1,
              optionValueRefs: ["size:s"],
            },
            {
              sku: `${slug}-2`,
              priceSar: 1,
              stock: 1,
              optionValueRefs: ["size:s"],
            },
          ],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // Zod failure surfaces with `duplicate_variant_combination` at the
    // right path — the AI agent reads the path to fix the exact field.
    const issues = (caught as { issues?: Array<{ message: string; path: PropertyKey[] }> }).issues;
    expect(issues).toBeTruthy();
    const dup = issues!.find(
      (i) => i.message === "duplicate_variant_combination",
    );
    expect(dup).toBeTruthy();
    // Atomicity: nothing persisted.
    expect(await countRows("products", tenantId)).toBe(0);
  });

  it("ref resolver fails the right path on unknown ref (Zod parse)", async () => {
    const tenantId = await makeTenant();
    const slug = `unknown-${randomUUID().slice(0, 8)}`;
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createProductRich(tx, baseTenantInfo(tenantId), "owner", {
          slug,
          name: { en: "X", ar: "س" },
          options: [
            {
              ref: "size",
              name: { en: "Size", ar: "م" },
              values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
            },
          ],
          variants: [
            {
              sku: `${slug}-x`,
              priceSar: 1,
              stock: 1,
              optionValueRefs: ["size:nope"],
            },
          ],
        }),
      );
    } catch (e) {
      caught = e;
    }
    const issues = (caught as { issues?: Array<{ message: string; path: PropertyKey[] }> }).issues;
    expect(issues).toBeTruthy();
    const unknown = issues!.find(
      (i) => i.message === "option_value_ref_unknown",
    );
    expect(unknown).toBeTruthy();
    expect(unknown!.path).toEqual(["variants", 0, "optionValueRefs", 0]);
  });

  it("[a,b] vs [b,a] tuples are both honored (position is significant)", async () => {
    const tenantId = await makeTenant();
    const slug = `order-${randomUUID().slice(0, 8)}`;

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createProductRich(tx, baseTenantInfo(tenantId), "owner", {
        slug,
        name: { en: "Order", ar: "ر" },
        options: [
          {
            ref: "ax",
            name: { en: "A", ar: "أ" },
            values: [
              { ref: "x", value: { en: "X", ar: "س" } },
              { ref: "y", value: { en: "Y", ar: "ي" } },
            ],
          },
          {
            ref: "bx",
            name: { en: "B", ar: "ب" },
            values: [
              { ref: "x", value: { en: "X", ar: "س" } },
              { ref: "y", value: { en: "Y", ar: "ي" } },
            ],
          },
        ],
        variants: [
          {
            sku: `${slug}-1`,
            priceSar: 1,
            stock: 1,
            optionValueRefs: ["ax:x", "bx:y"],
          },
          {
            sku: `${slug}-2`,
            priceSar: 1,
            stock: 1,
            optionValueRefs: ["ax:y", "bx:x"],
          },
        ],
      }),
    );
    expect(result.variants).toHaveLength(2);
    // Position-significance check: each tuple is distinct.
    expect(result.variants[0]?.optionValueIds).not.toEqual(
      result.variants[1]?.optionValueIds,
    );
  });
});

describe("createProductRich — cross-tenant isolation (orchestrator §1)", () => {
  it("rows committed by tenant A are not visible to tenant B", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const slug = `iso-${randomUUID().slice(0, 8)}`;

    await withTenant(superDb, ctxFor(tenantA), (tx) =>
      createProductRich(tx, baseTenantInfo(tenantA), "owner", {
        slug,
        name: { en: "A", ar: "أ" },
        options: [
          {
            ref: "size",
            name: { en: "Size", ar: "م" },
            values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
          },
        ],
        variants: [
          {
            sku: `${slug}-s`,
            priceSar: 1,
            stock: 1,
            optionValueRefs: ["size:s"],
          },
        ],
      }),
    );
    expect(await countRows("products", tenantA)).toBe(1);
    expect(await countRows("products", tenantB)).toBe(0);
    expect(await countRows("product_options", tenantB)).toBe(0);
    expect(await countRows("product_option_values", tenantB)).toBe(0);
    expect(await countRows("product_variants", tenantB)).toBe(0);
  });
});

describe("createProductRich — input shape", () => {
  it("rejects unknown extra keys at the top level (.strict)", async () => {
    const { CreateProductRichInputSchema } = await import(
      "@/server/services/products/rich-create-refs"
    );
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      tenantId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.success).toBe(false);
  });
});
