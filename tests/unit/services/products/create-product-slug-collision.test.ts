/**
 * createProduct surfaces a domain `SlugTakenError` on pg 23505 instead
 * of letting the DatabaseError bubble as a generic 500. Transport
 * adapters translate to their wire shape (tRPC: CONFLICT 'slug_taken';
 * MCP: 'conflict' kind via the audit mapper).
 *
 * Asserts:
 *   - the service throws a SlugTakenError (not TRPCError; per CLAUDE.md
 *     §2 service code stays transport-neutral).
 *   - the error message is exactly 'slug_taken' — no slug echo.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { SlugTakenError } from "@/server/audit/error-codes";

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
  it("a duplicate slug surfaces SlugTakenError (not a 500, no slug echo)", async () => {
    const { createProduct } = await import("@/server/services/products/create-product");
    const tenantId = await makeTenant();
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const input = { slug, name: { en: "X", ar: "س" } };

    // First insert succeeds.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", input),
    );

    // Second insert: same slug, same tenant → pg 23505 → SlugTakenError.
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", input),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlugTakenError);
    expect((caught as Error).message).toBe("slug_taken");

    // The wire message must NOT echo the slug value back.
    expect((caught as Error).message).not.toContain(slug);
  });
});
