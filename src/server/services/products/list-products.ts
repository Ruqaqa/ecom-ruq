/**
 * Cursor is an opaque base64url of `${updatedAtIso}::${id}`. Garbage
 * cursors silently fall back to the first page — the `?cursor=` param
 * is opaque to operators, so any garbage is equivalent to "start from
 * top". `limit+1` computes `hasMore` without a `count(*)`.
 *
 * Tier-B (`cost_price_minor`) is OWNER-ONLY for reads, in line with
 * prd §6.5 ("operator-only"): owners run margin math, staff don't.
 * Staff and below see `ProductPublicSchema` (no costPriceMinor) even
 * though they can list. The role-list (who's allowed to view at all)
 * stays owner+staff via `isWriteRole` at the entry-point guard; only
 * the COLUMN is owner-only. Gated at BOTH the SELECT column list AND
 * the output schema `.parse`, so the column never crosses the wire
 * for non-owner roles even if either gate is bypassed.
 */
import { z } from "zod";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
import {
  ProductOwnerSchema,
  ProductPublicSchema,
} from "./create-product";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface ListProductsTenantInfo {
  id: string;
}

export const LIST_PRODUCTS_LIMIT_MAX = 100;

export const ListProductsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_PRODUCTS_LIMIT_MAX)
    .default(20),
  cursor: z.string().min(1).optional(),
});
export type ListProductsInput = z.input<typeof ListProductsInputSchema>;

export const ListProductsOutputOwnerSchema = z.object({
  items: z.array(ProductOwnerSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ListProductsOutputOwner = z.infer<
  typeof ListProductsOutputOwnerSchema
>;

export const ListProductsOutputPublicSchema = z.object({
  items: z.array(ProductPublicSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ListProductsOutputPublic = z.infer<
  typeof ListProductsOutputPublicSchema
>;

export type ListProductsOutput =
  | ListProductsOutputOwner
  | ListProductsOutputPublic;

interface DecodedCursor {
  updatedAtIso: string;
  id: string;
}

function encodeCursor(updatedAt: Date, id: string): string {
  const payload = `${updatedAt.toISOString()}::${id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("::");
    if (idx < 0) return null;
    const updatedAtIso = decoded.slice(0, idx);
    const id = decoded.slice(idx + 2);
    if (!updatedAtIso || !id) return null;
    const ts = new Date(updatedAtIso);
    if (Number.isNaN(ts.getTime())) return null;
    // Validate id shape — anything that is not a plausible UUID gets
    // treated as garbage. Keeps a malformed cursor from reaching the
    // DB parser.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { updatedAtIso, id };
  } catch {
    return null;
  }
}

/**
 * Bypasses the role guard. Tests use this to prove the column-level
 * Tier-B gate stands on its own. Production paths must call
 * `listProducts`.
 */
export async function listProductsUnsafe(
  tx: Tx,
  tenant: ListProductsTenantInfo,
  role: Role,
  input: ListProductsInput,
): Promise<ListProductsOutput> {
  const parsed = ListProductsInputSchema.parse(input);
  const decoded = parsed.cursor ? decodeCursor(parsed.cursor) : null;

  const filters = [
    eq(products.tenantId, tenant.id),
    isNull(products.deletedAt),
  ];
  if (decoded) {
    filters.push(
      or(
        lt(products.updatedAt, new Date(decoded.updatedAtIso)),
        and(
          eq(products.updatedAt, new Date(decoded.updatedAtIso)),
          lt(products.id, decoded.id),
        ),
      )!,
    );
  }

  const ownerRole = role === "owner";
  const baseSelect = {
    id: products.id,
    slug: products.slug,
    name: products.name,
    description: products.description,
    status: products.status,
    categoryId: products.categoryId,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
  };
  const selectCols = ownerRole
    ? { ...baseSelect, costPriceMinor: products.costPriceMinor }
    : baseSelect;

  const rows = await tx
    .select(selectCols)
    .from(products)
    .where(and(...filters))
    .orderBy(desc(products.updatedAt), desc(products.id))
    .limit(parsed.limit + 1);

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = hasMore ? page[page.length - 1] : null;
  const nextCursor =
    last && last.updatedAt
      ? encodeCursor(last.updatedAt as Date, last.id as string)
      : null;

  if (ownerRole) {
    return ListProductsOutputOwnerSchema.parse({
      items: page,
      nextCursor,
      hasMore,
    });
  }
  return ListProductsOutputPublicSchema.parse({
    items: page,
    nextCursor,
    hasMore,
  });
}

// Inner role guard is defense-in-depth; the primary gate is at the
// transport (`requireRole` on tRPC, `authorize` on MCP).
export async function listProducts(
  tx: Tx,
  tenant: ListProductsTenantInfo,
  role: Role,
  input: ListProductsInput,
): Promise<ListProductsOutput> {
  if (!isWriteRole(role)) {
    throw new Error("listProducts: role not permitted");
  }
  return listProductsUnsafe(tx, tenant, role, input);
}
