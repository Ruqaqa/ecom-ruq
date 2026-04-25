/**
 * Carry-over fix from chunk 1a.2: createProduct must surface a typed
 * CONFLICT 'slug_taken' instead of letting the pg 23505 DatabaseError
 * bubble out as a 500. The mapErrorToAuditCode layer already maps pg
 * 23505 to the audit closed-set 'conflict', but the wire-level
 * TRPCError code was previously INTERNAL_SERVER_ERROR — clients had
 * to grep err.message to detect the duplicate.
 *
 * Asserts:
 *   - the error is a TRPCError with code === 'CONFLICT'
 *   - message is exactly 'slug_taken' (closed-set, not interpolated;
 *     never echoes the offending slug back to the wire)
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

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const superClient = postgres(DATABASE_URL, { max: 2 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slugTag = `cp-coll-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slugTag}, ${slugTag + ".local"}, 'en', ${"no-reply@" + slugTag + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("createProduct — slug collision", () => {
  it("a duplicate slug surfaces TRPCError CONFLICT 'slug_taken' (not a 500)", async () => {
    const { createProduct } = await import("@/server/services/products/create-product");
    const tenantId = await makeTenant();
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const input = { slug, name: { en: "X", ar: "س" } };

    // First insert succeeds.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", input),
    );

    // Second insert: same slug, same tenant → pg 23505 →
    // TRPCError CONFLICT 'slug_taken'.
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", input),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("CONFLICT");
    expect((caught as TRPCError).message).toBe("slug_taken");

    // The wire message must NOT echo the slug value back (no
    // operator-supplied data crosses the surface).
    expect((caught as TRPCError).message).not.toContain(slug);
  });
});
