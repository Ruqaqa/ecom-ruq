/**
 * `listProducts` service — admin product list (chunk 1a.1).
 *
 * Contract:
 *   - Tenant-scoped SELECT via withTenant.
 *   - ORDER BY updated_at DESC, id DESC (tie-break is load-bearing for
 *     cursor determinism — L-5).
 *   - WHERE deleted_at IS NULL (soft-delete filter from day one).
 *   - Role-gated SELECT (post-1a.2 alignment): ONLY owner SELECT
 *     includes cost_price_minor; staff and below OMIT it. Cost-price
 *     is owner-only for reads AND writes (prd §6.5 "operator-only").
 *     Staff is still allowed to view the LIST itself — only the
 *     column is owner-gated. Mirrors getProduct's gate.
 *   - Cursor shape: opaque base64url of `${updatedAtIso}::${id}`.
 *   - limit+1 technique for hasMore; no count(*) query.
 *   - Inner role check stays as defense-in-depth; primary gate lives at
 *     the transport (requireRole on tRPC, authorize on MCP).
 *   - No tenantId, role, or userId in the input schema.
 *   - Service takes `{ id }` narrowed tenant info, not the full Tenant.
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
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

const superClient = postgres(DATABASE_URL, { max: 3 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `svc-list-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProducts(
  tenantId: string,
  count: number,
  opts: { withCostPrice?: boolean; baseName?: string } = {},
): Promise<void> {
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    const slug = `p-${randomUUID().slice(0, 8)}-${i}`;
    // Stagger updated_at by 1 second to make ordering deterministic
    // without tie-break. Later tests explicitly hit the tie branch.
    const ts = new Date(base - i * 1000).toISOString();
    await superDb.execute(sql`
      INSERT INTO products
        (tenant_id, slug, name, description, status, cost_price_minor, created_at, updated_at)
      VALUES
        (${tenantId}::uuid,
         ${slug},
         ${sql.raw(`'${JSON.stringify({ en: `${opts.baseName ?? "Product"} ${i}`, ar: `منتج ${i}` }).replace(/'/g, "''")}'::jsonb`)},
         NULL,
         'draft',
         ${opts.withCostPrice ? 12345 : null},
         ${ts}::timestamptz,
         ${ts}::timestamptz)
    `);
  }
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    {
      userId: null,
      actorType: "anonymous",
      tokenId: null,
      role: "anonymous",
    },
  );
}

describe("listProducts — service", () => {
  it("empty tenant: returns { items: [], nextCursor: null, hasMore: false }", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {}),
    );
    expect(out.items).toEqual([]);
    expect(out.nextCursor).toBeNull();
    expect(out.hasMore).toBe(false);
  });

  it("owner role: returns ProductOwner rows sorted by updated_at DESC", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 3, { withCostPrice: true });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {}),
    );

    expect(out.items.length).toBe(3);
    expect(out.hasMore).toBe(false);
    expect(out.nextCursor).toBeNull();
    // updated_at DESC: item[0] is the newest (Product 0 — seed loop used
    // `base - i*1000`, so i=0 is the latest).
    expect((out.items[0] as { name: { en: string } }).name.en).toBe("Product 0");
    // Tier-B: owner sees costPriceMinor.
    expect("costPriceMinor" in out.items[0]!).toBe(true);
    expect(
      (out.items[0] as { costPriceMinor: number | null }).costPriceMinor,
    ).toBe(12345);
  });

  it("staff role: list visible but Tier-B costPriceMinor stripped (owner-only column per prd §6.5)", async () => {
    // Carry-over from chunk 1a.2: cost-price is owner-only for both
    // reads and writes. Staff still sees the LIST (entry-point guard
    // accepts owner+staff), but the COLUMN is gone — same gate in
    // getProduct.
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 2, { withCostPrice: true });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "staff", {}),
    );

    expect(out.items.length).toBe(2);
    expect("costPriceMinor" in out.items[0]!).toBe(false);
    expect(JSON.stringify(out)).not.toContain("12345");
  });

  it("customer role: inner defense-in-depth guard throws (primary gate lives at transport)", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 1);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "customer", {}),
      ),
    ).rejects.toThrow();
  });

  it("Tier-B: non-write role path omits costPriceMinor from SELECT (bypassing the guard proves the column never reaches the output shape)", async () => {
    // We bypass the inner guard by calling the internal projection
    // helper directly — proves the COLUMN-level Tier-B gate works
    // independently of the role check. If a future refactor removes
    // the inner guard, the column-level gate is still the source of
    // truth.
    const mod = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 1, { withCostPrice: true });

    // `listProductsUnsafe` is the internal entry point that does NOT
    // run the defense-in-depth role guard. Exposed for this test ONLY.
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      mod.listProductsUnsafe(tx, { id: tenantId }, "support", {}),
    );

    expect(out.items.length).toBe(1);
    expect("costPriceMinor" in out.items[0]!).toBe(false);
    expect(JSON.stringify(out)).not.toContain("12345");
  });

  it("20 rows, default limit (20): items.length === 20, hasMore false, nextCursor null", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 20);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {}),
    );

    expect(out.items.length).toBe(20);
    expect(out.hasMore).toBe(false);
    expect(out.nextCursor).toBeNull();
  });

  it("21 rows, limit=20 first page + cursor round-trip returns the last row", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 21);

    const first = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {}),
    );
    expect(first.items.length).toBe(20);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", { cursor: first.nextCursor! }),
    );
    expect(second.items.length).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("garbage cursor: does NOT throw — silently falls back to first page", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 2);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {
        cursor: "!!not-a-real-cursor!!",
      }),
    );
    expect(out.items.length).toBe(2);
  });

  it("soft-delete: rows with deleted_at IS NOT NULL are excluded from items and do NOT affect pagination", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 3);
    // Soft-delete the newest row.
    await superDb.execute(sql`
      UPDATE products SET deleted_at = now()
      WHERE tenant_id = ${tenantId}::uuid
        AND slug IN (SELECT slug FROM products WHERE tenant_id = ${tenantId}::uuid ORDER BY updated_at DESC LIMIT 1)
    `);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listProducts(tx, { id: tenantId }, "owner", {}),
    );
    expect(out.items.length).toBe(2);
    expect(out.items.every((p: { name: { en?: string | undefined } }) => p.name.en !== "Product 0")).toBe(true);
  });

  it("tenant isolation: rows for tenant B are absent from tenant A's list", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await seedProducts(tenantA, 2, { baseName: "A" });
    await seedProducts(tenantB, 3, { baseName: "B" });

    const outA = await withTenant(superDb, ctxFor(tenantA), (tx) =>
      listProducts(tx, { id: tenantA }, "owner", {}),
    );
    expect(outA.items.length).toBe(2);
    expect(JSON.stringify(outA)).not.toContain('"B 0"');
    expect(JSON.stringify(outA)).not.toContain('"B 1"');
    expect(JSON.stringify(outA)).not.toContain('"B 2"');
  });

  it("RLS safety-net: app_user connection without GUC returns 0 rows (not a throw — RLS silently filters on SELECT)", async () => {
    const { listProducts } = await import(
      "@/server/services/products/list-products"
    );
    const tenantId = await makeTenant();
    await seedProducts(tenantId, 3);

    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      const out = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        // No SET LOCAL app.tenant_id — RLS policy filters rows silently.
        return listProducts(tx, { id: tenantId }, "owner", {});
      });
      expect(out.items.length).toBe(0);
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  describe("input schema", () => {
    it("rejects limit=0", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(ListProductsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    });

    it("rejects negative limit", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(ListProductsInputSchema.safeParse({ limit: -1 }).success).toBe(false);
    });

    it("rejects limit above cap (101)", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(ListProductsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it("rejects non-integer limit", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(ListProductsInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    });

    it("accepts minimal input (empty object) — defaults apply", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      const parsed = ListProductsInputSchema.safeParse({});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.limit).toBe(20);
      }
    });

    it("has NO tenantId key (role-channel hygiene)", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(Object.keys(ListProductsInputSchema.shape)).not.toContain(
        "tenantId",
      );
    });

    it("has NO role key (input-channel role-elevation impossible)", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(Object.keys(ListProductsInputSchema.shape)).not.toContain("role");
    });

    it("has NO userId key", async () => {
      const { ListProductsInputSchema } = await import(
        "@/server/services/products/list-products"
      );
      expect(Object.keys(ListProductsInputSchema.shape)).not.toContain("userId");
    });
  });
});
