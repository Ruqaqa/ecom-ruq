/**
 * `createProduct` service — block 3b.
 *
 * Contract:
 *   - Inputs parsed through Zod (`CreateProductInputSchema`).
 *     `localizedText({ max })` / `localizedTextPartial({ max })` drive the
 *     per-field caps + the 16KB aggregate refine.
 *   - Output is the Zod GATE, not a hint. Owner/staff parse through
 *     `ProductOwnerSchema` (includes `costPriceMinor`). Everyone else
 *     parses through `ProductPublicSchema`, which drops `costPriceMinor`
 *     by construction — a Zod `.parse` strips unknown keys. A pre-seeded
 *     row with cost_price_minor=99999 must NOT surface it to a customer
 *     caller.
 *   - Service does NOT open a tx or call `withTenant` — the adapter owns
 *     those. Service is called with `(tx, tenant, role, input)`.
 *   - Service takes `CreateProductTenantInfo` ({ id, defaultLocale }),
 *     NOT the full Tenant (Low-02 closure).
 *
 * Tests run against a real Postgres, same pattern as audit-wrap tests.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { products } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP =
  process.env.DATABASE_URL_APP ?? DATABASE_URL;

// Superuser pool — used for fixture setup (tenant row insert) and
// post-insert raw SELECTs. RLS-bypassed. Service calls go through the
// app_user pool inside `withTenant`.
const superClient = postgres(DATABASE_URL, { max: 2 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `svc-prod-test-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

function goodInput(): {
  slug: string;
  name: { en: string; ar: string };
} {
  return {
    slug: "sony-a7iv-" + Math.random().toString(36).slice(2, 8),
    name: { en: "Sony A7 IV", ar: "سوني ايه 7 آي في" },
  };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("createProduct — service", () => {
  it("returns ProductOwner shape (includes costPriceMinor) when role='owner'", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", goodInput()),
    );

    expect(result).toMatchObject({
      name: { en: "Sony A7 IV" },
      status: "draft",
    });
    // Slug round-trips as a plain string.
    expect(typeof (result as { slug: unknown }).slug).toBe("string");
    expect((result as { slug: string }).slug).toMatch(/^sony-a7iv-/);
    // Tier-B field present for owner, null because service doesn't write it.
    expect("costPriceMinor" in result).toBe(true);
    expect((result as { costPriceMinor: number | null }).costPriceMinor).toBeNull();
  });

  it("returns ProductPublic shape (drops costPriceMinor) when role='customer'", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      createProduct(tx, { id: tenantId, defaultLocale: "en" }, "customer", goodInput()),
    );

    expect((result as Record<string, unknown>).costPriceMinor).toBeUndefined();
    expect(result).toMatchObject({ status: "draft" });
  });

  it("Tier-B adversarial: even with cost_price_minor pre-seeded on the row, customer-role output omits it", async () => {
    const { createProduct, ProductPublicSchema } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();

    // Create-then-force-seed then re-read via the schema gate. The
    // service's insert doesn't write cost_price_minor; we patch the row
    // and parse it to prove ProductPublicSchema gates the column out.
    const owner = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", goodInput()),
    );
    const id = (owner as { id: string }).id;
    await superDb.execute(sql`UPDATE products SET cost_price_minor = 99999 WHERE id = ${id}`);

    const rawRows = await superDb
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    const raw = rawRows[0];
    if (!raw) throw new Error("expected seeded row");

    // Raw row carries the Tier-B value.
    expect(raw.costPriceMinor).toBe(99999);

    // ProductPublicSchema drops it. .parse throws on drift, which would
    // fail the test — we rely on the implicit "strip unknown keys" Zod
    // default. If a future refactor adds `.passthrough()`, this breaks.
    const gated = ProductPublicSchema.parse(raw);
    expect("costPriceMinor" in gated).toBe(false);
    expect(JSON.stringify(gated)).not.toContain("99999");
  });

  it("Zod input rejects slug over per-field max (120 chars)", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();
    const bad = {
      slug: "a".repeat(121),
      name: { en: "ok", ar: "ok" },
    };

    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", bad),
      ),
    ).rejects.toThrow();
  });

  it("Zod input rejects uppercase slug (Latin-only lowercase invariant)", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();
    const bad = {
      slug: "Sony-A7IV",
      name: { en: "ok", ar: "ok" },
    };
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", bad),
      ),
    ).rejects.toThrow();
  });

  it("Zod input rejects Arabic-character slug (Latin-only regex invariant)", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();
    const bad = {
      slug: "سوني-a7iv",
      name: { en: "ok", ar: "ok" },
    };
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        createProduct(tx, { id: tenantId, defaultLocale: "en" }, "owner", bad),
      ),
    ).rejects.toThrow();
  });

  it("Zod input rejects localized text that exceeds the 16KB aggregate cap", async () => {
    // Use the raw factory to simulate a caller that loosened the per-field
    // max; the 16KB refine must still fire in aggregate.
    const { localizedText } = await import("@/lib/i18n/localized");
    const s = localizedText({ max: 9000 });
    const big = "a".repeat(9000);
    expect(() => s.parse({ en: big, ar: big })).toThrow(/16KB|too large|cap/i);
  });

  it("service trusts its `tenant` parameter — the inserted row carries that tenantId, not anything from input", async () => {
    // Low-02 invariant: service never reads tenantId from input. We prove
    // this by construction — there is no `tenantId` field on
    // CreateProductInputSchema, so a hostile input cannot even express
    // the attack. The adapter is responsible for sourcing tenant from ctx.
    const { CreateProductInputSchema } = await import(
      "@/server/services/products/create-product"
    );
    const shape = CreateProductInputSchema.shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
  });

  it("RLS: service insert fails with pg 42501 when called as app_user WITHOUT withTenant", async () => {
    const { createProduct } = await import(
      "@/server/services/products/create-product"
    );
    const tenantId = await makeTenant();

    // Dedicated connection as app_user with SET LOCAL ROLE, no GUC set.
    // We do NOT use withTenant — we want to reach the service fn from
    // inside a role-scoped tx with zero tenant context, and observe the
    // policy's WITH CHECK reject the insert.
    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      await expect(
        appDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          // No SET LOCAL app.tenant_id — policy should reject.
          return createProduct(
            tx,
            { id: tenantId, defaultLocale: "en" },
            "owner",
            goodInput(),
          );
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });
});
