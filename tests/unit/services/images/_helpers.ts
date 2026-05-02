/**
 * Shared test helpers for image service integration tests.
 *
 * Each helper is intentionally simple and parallels the variants /
 * categories test fixtures (`makeTenant`, `seedProduct`).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/server/db/schema";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import type { StorageAdapter } from "@/server/storage";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

export const superClient = postgres(DATABASE_URL, { max: 4 });
export const superDb = drizzle(superClient, { schema });

export async function makeTenant(prefix = "img"): Promise<{
  id: string;
  slug: string;
}> {
  const id = randomUUID();
  const slug = `${prefix}-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return { id, slug };
}

export async function seedProduct(tenantId: string): Promise<{
  id: string;
  slug: string;
  updatedAt: Date;
}> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft')
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return { id, slug, updatedAt: new Date(arr[0]!.updated_at) };
}

export async function seedVariant(
  tenantId: string,
  productId: string,
): Promise<{ id: string; updatedAt: Date }> {
  const id = randomUUID();
  const sku = `v-${id.slice(0, 12)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO product_variants (id, tenant_id, product_id, sku, price_minor, currency, stock, option_value_ids, active)
    VALUES (${id}, ${tenantId}, ${productId}, ${sku}, 1000, 'SAR', 0, '[]'::jsonb, true)
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return { id, updatedAt: new Date(arr[0]!.updated_at) };
}

export async function readImageRows(productId: string) {
  const rows = await superDb.execute<{
    id: string;
    position: number;
    version: number;
    storage_key: string;
    fingerprint_sha256: string;
    derivatives: unknown;
  }>(sql`
    SELECT id::text AS id, position, version, storage_key, fingerprint_sha256, derivatives
    FROM product_images
    WHERE product_id = ${productId}
    ORDER BY position, id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<unknown> }).rows ?? []);
  return arr as Array<{
    id: string;
    position: number;
    version: number;
    storage_key: string;
    fingerprint_sha256: string;
    derivatives: unknown;
  }>;
}

export function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

/**
 * In-memory storage adapter for service tests. Tracks every put/delete
 * call so tests can assert on the call ledger without touching the
 * disk or making vendor calls.
 */
export class InMemoryStorageAdapter {
  readonly puts: Array<{ key: string; bytes: Buffer; contentType: string }> = [];
  readonly deletes: string[] = [];
  /** Set to "fail-all" to simulate every adapter.put failing. */
  failMode: "ok" | "fail-all" | "fail-some" = "ok";
  /** When failMode === "fail-some", this counter rotates failure
   *  every Nth call so we can simulate partial failure. */
  failEveryN = 3;

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.puts.push({ key, bytes, contentType });
    if (this.failMode === "fail-all") {
      throw new Error("simulated upload failure");
    }
    if (this.failMode === "fail-some" && this.puts.length % this.failEveryN === 0) {
      throw new Error("simulated upload failure (partial)");
    }
  }

  async get(): Promise<{ bytes: Buffer; contentType: string } | null> {
    return null;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
  }
}

export function inMemoryAdapter(): InMemoryStorageAdapter & StorageAdapter {
  return new InMemoryStorageAdapter() as InMemoryStorageAdapter & StorageAdapter;
}
