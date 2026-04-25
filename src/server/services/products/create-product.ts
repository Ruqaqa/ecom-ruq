/**
 * `createProduct` — the first real service function.
 *
 * Shape rules (enforced here, audited at checkpoint 3):
 *   1. No `withTenant` call — the adapter owns the tx lifecycle.
 *   2. No tx open — the adapter passes `tx` in.
 *   3. No audit write — the adapter (`src/server/trpc/middleware/audit-wrap.ts`)
 *      wraps every mutation uniformly.
 *   4. No transport imports — no NextResponse, Headers, etc.
 *   5. Tenant arrives as a NARROWED projection (`CreateProductTenantInfo`),
 *      not the full `Tenant`. Per architect Low-02: `ctx.tenant.senderEmail`
 *      is benign today but the struct will grow operator-only fields
 *      (billing, outbound API keys) later, and a service handed `Tenant`
 *      might accidentally spread it into an output. Services receive what
 *      they strictly need, nothing more.
 *   6. Role arrives from `ctx.role` (adapter-derived), NEVER from input.
 *      There is no `role` field on `CreateProductInputSchema` — the
 *      adversarial attack surface doesn't exist.
 *   7. The Tier-B output gate is the Zod OUTPUT SCHEMA applied via
 *      `.parse` (not `.safeParse` + spread). The schema, by dropping
 *      unknown keys, is the gate by construction — owner/staff parse
 *      through `ProductOwnerSchema` (which names `costPriceMinor`),
 *      everyone else parses through `ProductPublicSchema` (which omits
 *      it). `.parse` throws on drift, which we prefer to a silent leak.
 */
import { z } from "zod";
import { products } from "@/server/db/schema/catalog";
import { localizedText, localizedTextPartial } from "@/lib/i18n/localized";
import { SlugTakenError } from "@/server/audit/error-codes";
import { extractPgUniqueViolation } from "./pg-error-helpers";
// Slug shape (regex, length, leading/trailing/consecutive-hyphen) lives
// in `@/lib/product-slug` — same module the admin form imports for live
// validation. Per-tenant uniqueness is enforced by pg index
// `products_tenant_slug_unique`; collisions throw `SlugTakenError`.
import { slugSchema } from "@/lib/product-slug";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface CreateProductTenantInfo {
  id: string;
  defaultLocale: "en" | "ar";
}

export const CreateProductInputSchema = z.object({
  slug: slugSchema,
  name: localizedText({ max: 256 }),
  description: localizedTextPartial({ max: 4096 }).nullish(),
  status: z.enum(["draft", "active"]).default("draft"),
  categoryId: z.string().uuid().nullish(),
});
// Caller-facing input type — use `z.input` so `.default()` fields stay
// optional on the caller's side. The internal `parsed` binding uses
// `z.output` / `z.infer` (defaults applied). A tRPC `.input(...)` binding
// consumes this same shape because tRPC accepts caller input through
// `ZodSchema['_input']`.
export type CreateProductInput = z.input<typeof CreateProductInputSchema>;

export const ProductPublicSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.object({ en: z.string(), ar: z.string() }),
  description: z
    .object({ en: z.string().optional(), ar: z.string().optional() })
    .nullish(),
  status: z.enum(["draft", "active"]),
  categoryId: z.string().uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ProductPublic = z.infer<typeof ProductPublicSchema>;

export const ProductOwnerSchema = ProductPublicSchema.extend({
  costPriceMinor: z.number().int().nullable(),
});
export type ProductOwner = z.infer<typeof ProductOwnerSchema>;

/**
 * Creates a product under the tenant in the passed `tx`. Returns the
 * role-gated output shape — owner/staff get `ProductOwner`, everyone else
 * gets `ProductPublic`.
 *
 * The caller (the tRPC adapter) is responsible for:
 *   - opening the tx via `withTenant(db, authedCtx, fn)`,
 *   - sourcing `tenant` from the resolved `ctx.tenant`,
 *   - sourcing `role` from `ctx.membership?.role` / customer fallback.
 */
export async function createProduct(
  tx: Tx,
  tenant: CreateProductTenantInfo,
  role: Role,
  input: CreateProductInput,
): Promise<ProductPublic | ProductOwner> {
  const parsed = CreateProductInputSchema.parse(input);
  let rows;
  try {
    rows = await tx
      .insert(products)
      .values({
        tenantId: tenant.id,
        slug: parsed.slug,
        name: parsed.name,
        description: parsed.description,
        status: parsed.status,
        categoryId: parsed.categoryId,
      })
      .returning();
  } catch (err) {
    // Slug collision → SlugTakenError (closed-set wire message; never
    // echoes the offending slug). Transport adapters translate to their
    // wire shape; the audit mapper recognizes the class.
    if (extractPgUniqueViolation(err, "products_tenant_slug_unique")) {
      throw new SlugTakenError(err);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new Error("createProduct: insert returned no row");

  if (role === "owner" || role === "staff") {
    return ProductOwnerSchema.parse(row);
  }
  return ProductPublicSchema.parse(row);
}
