/**
 * `getProduct` service — read used by the RSC edit page (chunk 1a.2).
 *
 * Contract:
 *   - Tenant-scoped SELECT via withTenant.
 *   - WHERE id = $id, tenant_id = $tenant, deleted_at IS NULL.
 *   - Role-gated SELECT: owner/staff includes cost_price_minor;
 *     everyone else omits it (Tier-B by column-list AND output schema).
 *   - Returns null on no row (the page maps null → notFound()).
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
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const superClient = postgres(DATABASE_URL, { max: 2 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `gp-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(tenantId: string, costPriceMinor: number | null = null): Promise<string> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "X", ar: "س" })}'::jsonb`)},
      'draft', ${costPriceMinor})
  `);
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("getProduct — service", () => {
  it("owner: returns ProductOwner shape with costPriceMinor", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId, 12345);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "owner", { id }),
    );
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ id, costPriceMinor: 12345 });
  });

  it("staff: returns ProductPublic shape (Tier-B stripped — cost-price is owner-only for reads per prd §6.5)", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId, 99);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "staff", { id }),
    );
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).costPriceMinor).toBeUndefined();
  });

  it("customer: returns ProductPublic shape (Tier-B stripped) even when row has cost_price_minor", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    // Canary value chosen to be distinctive in JSON.stringify — random
    // UUIDs are hex and contain frequent two-digit substrings (e.g. "42"
    // collides with hex like "c7133a74-3fc4-4192-…"). 7-digit decimal-only
    // value avoids that class of false positive.
    const id = await seedProduct(tenantId, 9911337);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "customer", { id }),
    );
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).costPriceMinor).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("9911337");
  });

  it("returns null on unknown id", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const phantom = randomUUID();

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "owner", { id: phantom }),
    );
    expect(result).toBeNull();
  });

  it("tenant isolation: returns null when the product belongs to another tenant (SAME shape as not-found — IDOR existence-leak guard)", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const idInB = await seedProduct(tenantB);

    const result = await withTenant(superDb, ctxFor(tenantA), async (tx) =>
      getProduct(tx, { id: tenantA }, "owner", { id: idInB }),
    );
    expect(result).toBeNull();
  });

  it("returns null on a soft-deleted row", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${id}`);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "owner", { id }),
    );
    expect(result).toBeNull();
  });

  it("input schema rejects non-uuid id", async () => {
    const { GetProductInputSchema } = await import("@/server/services/products/get-product");
    expect(() => GetProductInputSchema.parse({ id: "not-a-uuid" })).toThrow();
  });

  it("input schema has no tenantId field (Low-02 invariant)", async () => {
    const { GetProductInputSchema } = await import("@/server/services/products/get-product");
    expect(Object.keys(GetProductInputSchema.shape)).not.toContain("tenantId");
  });

  // chunk 1a.3 — includeDeleted matrix.
  it("includeDeleted: false (default) — soft-deleted row returns null", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${id}`);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "owner", { id }),
    );
    expect(result).toBeNull();
  });

  it("includeDeleted: true (owner) — returns the deleted row with deletedAt populated", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId, 4242);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${id}`);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "owner", { id, includeDeleted: true }),
    );
    expect(result).not.toBeNull();
    expect((result as { id: string; deletedAt: Date | null }).deletedAt).toBeInstanceOf(Date);
    expect((result as { costPriceMinor: number | null }).costPriceMinor).toBe(4242);
  });

  it("includeDeleted: true (staff) — returns the deleted row but no costPriceMinor (Tier-B preserved)", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId, 99);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${id}`);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      getProduct(tx, { id: tenantId }, "staff", { id, includeDeleted: true }),
    );
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).costPriceMinor).toBeUndefined();
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(Date);
  });

  it("includeDeleted: true (customer) — defense-in-depth gate throws", async () => {
    const { getProduct } = await import("@/server/services/products/get-product");
    const tenantId = await makeTenant();
    const id = await seedProduct(tenantId);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${id}`);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        getProduct(tx, { id: tenantId }, "customer", { id, includeDeleted: true }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/includeDeleted/i);
  });
});
