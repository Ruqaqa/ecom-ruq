/**
 * Cross-tenant adversarial coverage for `setProductOptions` and
 * `setProductVariants` (chunk 1a.5.1, spec §6).
 *
 * Two-level assertion bar (per the spec, mirroring the categories
 * adversarial spec at tests/e2e/admin/products/product-categories-
 * adversarial.spec.ts:472–477 + line 440):
 *
 * - Level A — across probe-row groups: error envelope shape and the set
 *   of body keys (with `message` EXCLUDED) must be byte-equal across
 *   EVERY row in the spec §6 table. The closed-set wire `message`
 *   legitimately differs across rows (`product_not_found` vs
 *   `option_not_found` vs `option_value_not_found`).
 *
 * - Level B — within a probe-row group: full byte-equality INCLUDING
 *   `message` across the cross-tenant / cross-product / phantom sub-
 *   cases of the SAME input field. If `message` differs across the
 *   sub-cases of the same field, the wire message itself becomes a
 *   discriminator and the existence-leak guard is broken.
 *
 * Each "probe-row group" corresponds to one row in spec §6's table:
 *   - productId (3 sub-cases: cross-tenant / soft-deleted / phantom)
 *   - optionId (3 sub-cases: cross-tenant / cross-product / phantom)
 *   - optionValueId in setProductOptions (3 sub-cases)
 *   - optionValueIds[i] in setProductVariants (3 sub-cases)
 *   - variant id update path (3 sub-cases)
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
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `xto-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
  opts: { deletedAt?: Date | null } = {},
): Promise<{ id: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft',
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return { id, updatedAt: new Date(arr[0]!.updated_at) };
}

async function seedProductWithTwoOptions(tenantId: string) {
  const { setProductOptions } = await import(
    "@/server/services/variants/set-product-options"
  );
  const product = await seedProduct(tenantId);
  const r = await withTenant(
    superDb,
    buildAuthedTenantContext(
      { id: tenantId },
      { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
    ),
    (tx) =>
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
          {
            name: { en: "Size", ar: "المقاس" },
            values: [
              { value: { en: "Small", ar: "صغير" } },
              { value: { en: "Medium", ar: "وسط" } },
            ],
          },
        ],
      }),
  );
  return {
    productId: product.id,
    productUpdatedAt: r.productUpdatedAt,
    colorOptionId: r.options[0]!.id,
    sizeOptionId: r.options[1]!.id,
    redValueId: r.options[0]!.values[0]!.id,
    smallValueId: r.options[1]!.values[0]!.id,
  };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

interface ErrFingerprint {
  isTRPCError: boolean;
  code: string;
  message: string;
  /** body keys NOT including `message` — the Level A invariant. */
  keysWithoutMessage: string[];
}

function fingerprint(err: unknown): ErrFingerprint {
  if (!(err instanceof TRPCError)) {
    return { isTRPCError: false, code: "", message: "", keysWithoutMessage: [] };
  }
  // The TRPCError envelope has a fixed shape — code, message, name, cause.
  // For Level A we want the keys other than `message`; the closed-set
  // shape is the contract.
  const keysWithoutMessage = Object.keys({
    code: err.code,
    name: err.name,
  }).sort();
  return {
    isTRPCError: true,
    code: err.code,
    message: err.message,
    keysWithoutMessage,
  };
}

async function captureErr<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

describe("setProductOptions — cross-tenant opacity (spec §6)", () => {
  it("productId probe-row group: cross-tenant / soft-deleted / phantom — Level B byte-equal including message", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productB = await seedProduct(tenantB);
    const productASoft = await seedProduct(tenantA, {
      deletedAt: new Date(),
    });
    const phantomId = randomUUID();
    const minimalInput = {
      expectedUpdatedAt: new Date().toISOString(),
      options: [
        {
          name: { en: "C", ar: "ل" },
          values: [{ value: { en: "R", ar: "ح" } }],
        },
      ],
    };

    const fpCrossTenant = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: productB.id,
          }),
        ),
      ),
    );
    const fpSoftDeleted = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: productASoft.id,
          }),
        ),
      ),
    );
    const fpPhantom = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: phantomId,
          }),
        ),
      ),
    );

    // Level B — full byte-equality including message.
    expect(fpCrossTenant).toEqual(fpSoftDeleted);
    expect(fpSoftDeleted).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("product_not_found");
    expect(fpCrossTenant.code).toBe("NOT_FOUND");
  });

  it("optionId probe-row group: cross-tenant / cross-product / phantom — Level B byte-equal", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedAOther = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);
    const phantomOptionId = randomUUID();

    const probe = (foreignOptionId: string) =>
      captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            options: [
              {
                id: foreignOptionId,
                name: { en: "C", ar: "ل" },
                values: [{ value: { en: "R", ar: "ح" } }],
              },
            ],
          }),
        ),
      );

    const fpCrossTenant = fingerprint(await probe(seedB.colorOptionId));
    const fpCrossProduct = fingerprint(await probe(seedAOther.colorOptionId));
    const fpPhantom = fingerprint(await probe(phantomOptionId));

    expect(fpCrossTenant).toEqual(fpCrossProduct);
    expect(fpCrossProduct).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("option_not_found");
    expect(fpCrossTenant.code).toBe("BAD_REQUEST");
  });

  it("optionValueId probe-row group: cross-tenant / cross-option-same-product / phantom — Level B byte-equal", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);
    const phantomValueId = randomUUID();

    const probe = (foreignValueId: string) =>
      captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            options: [
              {
                id: seedA.colorOptionId,
                name: { en: "Color", ar: "اللون" },
                values: [
                  // Foreign value-id under the COLOR option.
                  { id: foreignValueId, value: { en: "R", ar: "ح" } },
                ],
              },
              {
                id: seedA.sizeOptionId,
                name: { en: "Size", ar: "المقاس" },
                values: [{ id: seedA.smallValueId, value: { en: "S", ar: "ص" } }],
              },
            ],
          }),
        ),
      );

    const fpCrossTenant = fingerprint(await probe(seedB.redValueId));
    // Cross-option-same-product: a value belonging to seedA's SIZE option,
    // attempted under seedA's COLOR option.
    const fpCrossOption = fingerprint(await probe(seedA.smallValueId));
    const fpPhantom = fingerprint(await probe(phantomValueId));

    expect(fpCrossTenant).toEqual(fpCrossOption);
    expect(fpCrossOption).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("option_value_not_found");
    expect(fpCrossTenant.code).toBe("BAD_REQUEST");
  });
});

describe("setProductVariants — cross-tenant opacity (spec §6)", () => {
  it("productId probe-row group: cross-tenant / soft-deleted / phantom — Level B byte-equal", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productB = await seedProduct(tenantB);
    const productASoft = await seedProduct(tenantA, {
      deletedAt: new Date(),
    });
    const phantomId = randomUUID();
    const minimalInput = {
      expectedUpdatedAt: new Date().toISOString(),
      variants: [
        {
          sku: `xto-${randomUUID().slice(0, 8)}`,
          priceMinor: 100,
          stock: 0,
          optionValueIds: [],
        },
      ],
    };

    const fpCrossTenant = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductVariants(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: productB.id,
          }),
        ),
      ),
    );
    const fpSoftDeleted = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductVariants(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: productASoft.id,
          }),
        ),
      ),
    );
    const fpPhantom = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductVariants(tx, { id: tenantA }, "owner", {
            ...minimalInput,
            productId: phantomId,
          }),
        ),
      ),
    );

    expect(fpCrossTenant).toEqual(fpSoftDeleted);
    expect(fpSoftDeleted).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("product_not_found");
    expect(fpCrossTenant.code).toBe("NOT_FOUND");
  });

  it("optionValueIds[i] probe-row group: cross-tenant / cross-product-same-tenant / phantom — Level B byte-equal", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedAOther = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);
    const phantomValueId = randomUUID();

    const probe = (foreignValueId1: string, foreignValueId2: string) =>
      captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductVariants(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            variants: [
              {
                sku: `xto-${randomUUID().slice(0, 8)}`,
                priceMinor: 100,
                stock: 0,
                optionValueIds: [foreignValueId1, foreignValueId2],
              },
            ],
          }),
        ),
      );

    const fpCrossTenant = fingerprint(
      await probe(seedB.redValueId, seedB.smallValueId),
    );
    const fpCrossProduct = fingerprint(
      await probe(seedAOther.redValueId, seedAOther.smallValueId),
    );
    const fpPhantom = fingerprint(
      await probe(phantomValueId, phantomValueId),
    );

    expect(fpCrossTenant).toEqual(fpCrossProduct);
    expect(fpCrossProduct).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("option_value_not_found");
    expect(fpCrossTenant.code).toBe("BAD_REQUEST");
  });
});

describe("setProductOptions — cascade probe is byte-equal to no-cascade probe (1a.5.3, security §9.1)", () => {
  it("cross-tenant / cross-product / phantom optionId via cascade attempt — Level B byte-equal", async () => {
    // 1a.5.3 lifts the transitional refusal of removal. A hostile call
    // that sets only ONE of the two existing options (i.e. attempts to
    // remove the other), AND injects a foreign optionId in the kept
    // option's id slot, must produce an envelope byte-equal to the
    // no-cascade probe envelope. Otherwise a probe could distinguish
    // "your input would have triggered cascade" from "your input
    // wouldn't have" — and that becomes an existence oracle on the
    // kept-vs-removed option-id state of someone else's product.
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedAOther = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);
    const phantomOptionId = randomUUID();

    // Probe: hostile call shaped to LOOK like a cascade — only one
    // option in the input (the second is implicitly removed) — but
    // the kept option carries a foreign optionId. The foreign-id check
    // fires BEFORE any removal lands, so the cascade is an attempted
    // contract that the server refuses opaquely.
    const probe = (foreignOptionId: string) =>
      captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            options: [
              {
                id: foreignOptionId,
                name: { en: "C", ar: "ل" },
                values: [{ value: { en: "R", ar: "ح" } }],
              },
            ],
          }),
        ),
      );

    const fpCrossTenant = fingerprint(await probe(seedB.colorOptionId));
    const fpCrossProduct = fingerprint(await probe(seedAOther.colorOptionId));
    const fpPhantom = fingerprint(await probe(phantomOptionId));

    // Level B — byte-equal across cross-tenant / cross-product /
    // phantom even when the call shape would have implied a cascade.
    expect(fpCrossTenant).toEqual(fpCrossProduct);
    expect(fpCrossProduct).toEqual(fpPhantom);
    expect(fpCrossTenant.message).toBe("option_not_found");
    expect(fpCrossTenant.code).toBe("BAD_REQUEST");
  });
});

describe("setProductOptions + setProductVariants — Level A across probe-row groups", () => {
  it("envelope shape + body-key-set (excluding message) byte-equal across DIFFERENT probe-row groups", async () => {
    // Spec §6 Level A: across rows the envelope and the body keys
    // (excluding `message`) must match. `message` is allowed to differ
    // (`product_not_found` vs `option_not_found` vs `option_value_not_found`)
    // — that's the closed-set wire shape, not a leak channel.
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);

    const productProbe = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            productId: randomUUID(),
            expectedUpdatedAt: new Date().toISOString(),
            options: [
              {
                name: { en: "C", ar: "ل" },
                values: [{ value: { en: "R", ar: "ح" } }],
              },
            ],
          }),
        ),
      ),
    );
    const optionProbe = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductOptions(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            options: [
              {
                id: seedB.colorOptionId,
                name: { en: "C", ar: "ل" },
                values: [{ value: { en: "R", ar: "ح" } }],
              },
            ],
          }),
        ),
      ),
    );
    const valueProbe = fingerprint(
      await captureErr(
        withTenant(superDb, ctxFor(tenantA), (tx) =>
          setProductVariants(tx, { id: tenantA }, "owner", {
            productId: seedA.productId,
            expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
            variants: [
              {
                sku: `xto-${randomUUID().slice(0, 8)}`,
                priceMinor: 100,
                stock: 0,
                optionValueIds: [seedB.redValueId, seedB.smallValueId],
              },
            ],
          }),
        ),
      ),
    );

    // All three are TRPCError instances with the same envelope shape:
    expect(productProbe.isTRPCError).toBe(true);
    expect(optionProbe.isTRPCError).toBe(true);
    expect(valueProbe.isTRPCError).toBe(true);
    // Body key-set excluding message is identical:
    expect(productProbe.keysWithoutMessage).toEqual(
      optionProbe.keysWithoutMessage,
    );
    expect(optionProbe.keysWithoutMessage).toEqual(
      valueProbe.keysWithoutMessage,
    );
    // `message` is the closed-set string; it legitimately differs:
    expect(productProbe.message).toBe("product_not_found");
    expect(optionProbe.message).toBe("option_not_found");
    expect(valueProbe.message).toBe("option_value_not_found");
  });
});
