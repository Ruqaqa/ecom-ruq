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

  // chunk 1a.3 — includeDeleted matrix.
  describe("includeDeleted (chunk 1a.3)", () => {
    async function seedDeletedProduct(tenantId: string): Promise<string> {
      const id = randomUUID();
      const slug = `deld-${id.slice(0, 8)}`;
      await superDb.execute(sql`
        INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
        VALUES (${id}, ${tenantId}, ${slug},
          ${sql.raw(`'${JSON.stringify({ en: "Removed", ar: "م" })}'::jsonb`)},
          'draft', now())
      `);
      return id;
    }

    it("includeDeleted: false (default) — soft-deleted rows excluded", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      await seedProducts(tenantId, 2);
      const deletedId = await seedDeletedProduct(tenantId);
      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {}),
      );
      const ids = out.items.map((p) => p.id);
      expect(ids).not.toContain(deletedId);
      expect(out.items.length).toBe(2);
    });

    it("includeDeleted: true (owner) — soft-deleted rows included with deletedAt populated", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      await seedProducts(tenantId, 1);
      const deletedId = await seedDeletedProduct(tenantId);
      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", { includeDeleted: true }),
      );
      const found = out.items.find((p) => p.id === deletedId);
      expect(found).toBeDefined();
      expect(found?.deletedAt).toBeInstanceOf(Date);
      expect(out.items.length).toBe(2);
    });

    it("includeDeleted: true (staff) — deleted rows visible but no costPriceMinor (Tier-B preserved)", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      const id = randomUUID();
      const slug = `deld-${id.slice(0, 8)}`;
      await superDb.execute(sql`
        INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor, deleted_at)
        VALUES (${id}, ${tenantId}, ${slug},
          ${sql.raw(`'${JSON.stringify({ en: "Removed", ar: "م" })}'::jsonb`)},
          'draft', 5555, now())
      `);
      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "staff", { includeDeleted: true }),
      );
      const item = out.items.find((p) => p.id === id);
      expect(item).toBeDefined();
      expect(item?.deletedAt).toBeInstanceOf(Date);
      expect((item as Record<string, unknown>).costPriceMinor).toBeUndefined();
    });

    it("includeDeleted: true (customer) — outer role guard rejects (defense-in-depth)", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      let caught: unknown = null;
      try {
        await withTenant(superDb, ctxFor(tenantId), (tx) =>
          listProducts(tx, { id: tenantId }, "customer", { includeDeleted: true }),
        );
      } catch (e) {
        caught = e;
      }
      // The outer `isWriteRole` guard fires first for customer — same
      // shape as the pre-1a.3 list-call rejection.
      expect(caught).toBeTruthy();
      expect(String(caught)).toMatch(/role/i);
    });
  });

  // chunk 1a.3 follow-up — removed-on-top sort + bucketed cursor.
  describe("includeDeleted=true sort + cursor (chunk 1a.3 follow-up)", () => {
    async function seedAt(
      tenantId: string,
      opts: {
        slug?: string;
        updatedAtIso?: string;
        deletedAtSql?: string | null; // raw SQL fragment for deleted_at, e.g. "now() - interval '2 hours'"
      },
    ): Promise<{ id: string; slug: string }> {
      const id = randomUUID();
      const slug = opts.slug ?? `s-${id.slice(0, 8)}`;
      const ua = opts.updatedAtIso ?? new Date().toISOString();
      const da = opts.deletedAtSql ?? null;
      if (da !== null) {
        await superDb.execute(sql`
          INSERT INTO products (id, tenant_id, slug, name, status, created_at, updated_at, deleted_at)
          VALUES (${id}, ${tenantId}, ${slug},
            ${sql.raw(`'${JSON.stringify({ en: "X", ar: "م" })}'::jsonb`)},
            'draft', ${ua}::timestamptz, ${ua}::timestamptz, ${sql.raw(da)})
        `);
      } else {
        await superDb.execute(sql`
          INSERT INTO products (id, tenant_id, slug, name, status, created_at, updated_at)
          VALUES (${id}, ${tenantId}, ${slug},
            ${sql.raw(`'${JSON.stringify({ en: "X", ar: "م" })}'::jsonb`)},
            'draft', ${ua}::timestamptz, ${ua}::timestamptz)
        `);
      }
      return { id, slug };
    }

    it("removed-on-top: includeDeleted=true returns [most-recently-removed, older-removed, live] in that order", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      const live = await seedAt(tenantId, {
        updatedAtIso: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        deletedAtSql: null,
      });
      const olderRemoved = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '2 hours'",
      });
      const recentlyRemoved = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '30 minutes'",
      });

      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", { includeDeleted: true }),
      );
      const orderedIds = out.items.map((p) => p.id);
      expect(orderedIds).toEqual([
        recentlyRemoved.id,
        olderRemoved.id,
        live.id,
      ]);
    });

    it("default sort unchanged (includeDeleted=false): live row only, deleted rows excluded", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      const live = await seedAt(tenantId, { deletedAtSql: null });
      await seedAt(tenantId, { deletedAtSql: "now() - interval '2 hours'" });
      await seedAt(tenantId, { deletedAtSql: "now() - interval '30 minutes'" });

      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {}),
      );
      expect(out.items.map((p) => p.id)).toEqual([live.id]);
    });

    it("cursor pagination across the bucket boundary: page 1 inside deleted, page 2 finishes deleted + crosses to live", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      // 3 deleted rows (descending deletedAt by 1h each — newest first)
      // and 1 live row.
      const d1 = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '30 minutes'",
      });
      const d2 = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '90 minutes'",
      });
      const d3 = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '150 minutes'",
      });
      const liveRow = await seedAt(tenantId, { deletedAtSql: null });

      const page1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {
          includeDeleted: true,
          limit: 2,
        }),
      );
      expect(page1.items.map((p) => p.id)).toEqual([d1.id, d2.id]);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {
          includeDeleted: true,
          limit: 2,
          cursor: page1.nextCursor!,
        }),
      );
      // Page 2 picks up d3 (last deleted) then crosses to liveRow.
      expect(page2.items.map((p) => p.id)).toEqual([d3.id, liveRow.id]);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });

    it("cursor format strictness: a cursor minted under one mode falls back to first page under the other (no throw)", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      await seedAt(tenantId, {
        deletedAtSql: "now() - interval '30 minutes'",
      });
      const live = await seedAt(tenantId, { deletedAtSql: null });

      // Mint a bucket cursor (includeDeleted=true).
      const bucketed = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {
          includeDeleted: true,
          limit: 1,
        }),
      );
      expect(bucketed.nextCursor).not.toBeNull();

      // Submit it under includeDeleted=false → first page (live row only).
      const liveOnly = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {
          cursor: bucketed.nextCursor!,
        }),
      );
      expect(liveOnly.items.map((p) => p.id)).toEqual([live.id]);

      // And: a live cursor minted under includeDeleted=false (limit=0
      // would be too small; need a live row first).
      // Add a second live row so the live-mode listing returns >1.
      const live2 = await seedAt(tenantId, { deletedAtSql: null });
      const liveFirstPage = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", { limit: 1 }),
      );
      expect(liveFirstPage.nextCursor).not.toBeNull();

      // Submit it under includeDeleted=true → first page (bucketed).
      // The deleted row is at the top.
      const reSubmitted = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", {
          includeDeleted: true,
          cursor: liveFirstPage.nextCursor!,
        }),
      );
      // First item is the deleted row; falling back to first page
      // means we see all rows from the top of the bucketed sort.
      expect(reSubmitted.items[0]?.deletedAt).toBeInstanceOf(Date);
      // The two live rows still appear after the deleted bucket.
      const liveIdsInResult = reSubmitted.items
        .filter((p) => p.deletedAt === null)
        .map((p) => p.id);
      expect(liveIdsInResult.sort()).toEqual([live.id, live2.id].sort());
    });

    it("within-bucket tie-breaker: two deleted rows with the same deletedAt and updatedAt order by id DESC", async () => {
      const { listProducts } = await import("@/server/services/products/list-products");
      const tenantId = await makeTenant();
      const a = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '1 hour'",
      });
      const b = await seedAt(tenantId, {
        deletedAtSql: "now() - interval '1 hour'",
      });
      // Force IDENTICAL deleted_at AND updated_at so the only
      // distinguishing key is id. The bucket sort is
      // (deleted_at IS NULL) ASC, deleted_at DESC, updated_at DESC,
      // id DESC — id only tie-breaks when both date keys match.
      await superDb.execute(sql`
        UPDATE products
        SET deleted_at = (SELECT deleted_at FROM products WHERE id = ${a.id}),
            updated_at = (SELECT updated_at FROM products WHERE id = ${a.id})
        WHERE id = ${b.id}
      `);

      const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
        listProducts(tx, { id: tenantId }, "owner", { includeDeleted: true }),
      );
      const ids = out.items.map((p) => p.id);
      // id DESC under postgres uuid semantics — but uuids are 16-byte
      // values so byte-wise compare, not string-wise. JS string sort
      // happens to coincide for hex-only inputs.
      const expected = [a.id, b.id].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0));
      expect(ids).toEqual(expected);
    });
  });
});
