/**
 * Cursor format depends on the list mode:
 *
 *   - `includeDeleted=false` (default, storefront + admin live-only):
 *       opaque base64url of `${updatedAtIso}::${id}`.
 *       Sort: `updated_at DESC, id DESC` — single bucket.
 *
 *   - `includeDeleted=true` (admin "Show removed" toggle):
 *       opaque base64url of `${bucket}::${sortDateIso}::${id}` where
 *       `bucket` is `"d"` (deleted) or `"l"` (live), and `sortDateIso`
 *       is the row's `deleted_at` for `"d"` rows or `updated_at` for
 *       `"l"` rows. Sort: `(deleted_at IS NULL) ASC, deleted_at DESC
 *       NULLS LAST, updated_at DESC, id DESC` — soft-deleted bucket
 *       first (most-recently-removed at the top), live bucket second.
 *
 * Garbage cursors (wrong shape, malformed ISO, non-UUID id, OR a
 * cursor minted under one mode and re-submitted under the other)
 * silently fall back to the first page. The `?cursor=` param is
 * opaque to operators; "start from the top" is the only sensible
 * fallback. `limit+1` computes `hasMore` without a `count(*)`.
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
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
// `includeDeleted: true` is owner-or-staff only — same gate as the
// listing entry-point. Defense-in-depth alongside the transport gate.
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
  // Admin "Show removed" toggle. Default false: storefront and admin
  // default views never see soft-deleted rows. Owner/staff only when
  // true (gated below + at the transport).
  includeDeleted: z.boolean().default(false),
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

// Two cursor shapes, one per list mode (see file docstring). Decoder
// returns the variant matching the shape; mismatches between cursor
// shape and current mode fall back to the first page (caller passes
// the cursor unchanged through the toggle).
interface DecodedLiveCursor {
  kind: "live";
  updatedAtIso: string;
  id: string;
}
interface DecodedBucketCursor {
  kind: "bucket";
  bucket: "d" | "l";
  sortDateIso: string;
  id: string;
}
type DecodedCursor = DecodedLiveCursor | DecodedBucketCursor;

const UUID_RE = /^[0-9a-f-]{36}$/i;

function encodeLiveCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}::${id}`, "utf8").toString(
    "base64url",
  );
}

function encodeBucketCursor(bucket: "d" | "l", sortDate: Date, id: string): string {
  return Buffer.from(
    `${bucket}::${sortDate.toISOString()}::${id}`,
    "utf8",
  ).toString("base64url");
}

function isValidIso(s: string): boolean {
  if (!s) return false;
  const ts = new Date(s);
  return !Number.isNaN(ts.getTime());
}

function decodeCursor(raw: string): DecodedCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("::");
  // Bucket cursor: `${bucket}::${sortDateIso}::${id}` (3 segments).
  if (parts.length === 3) {
    const [bucket, sortDateIso, id] = parts;
    if (bucket !== "d" && bucket !== "l") return null;
    if (!isValidIso(sortDateIso!)) return null;
    if (!UUID_RE.test(id!)) return null;
    return { kind: "bucket", bucket, sortDateIso: sortDateIso!, id: id! };
  }
  // Live cursor: `${updatedAtIso}::${id}` (2 segments).
  if (parts.length === 2) {
    const [updatedAtIso, id] = parts;
    if (!isValidIso(updatedAtIso!)) return null;
    if (!UUID_RE.test(id!)) return null;
    return { kind: "live", updatedAtIso: updatedAtIso!, id: id! };
  }
  return null;
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
  const rawDecoded = parsed.cursor ? decodeCursor(parsed.cursor) : null;
  // Cross-mode cursor → garbage → first page. A live-cursor submitted
  // under includeDeleted=true (or vice versa) cannot be interpreted in
  // the other view's sort order without skipping/duplicating rows.
  const decoded =
    rawDecoded === null
      ? null
      : parsed.includeDeleted && rawDecoded.kind === "bucket"
        ? rawDecoded
        : !parsed.includeDeleted && rawDecoded.kind === "live"
          ? rawDecoded
          : null;

  const filters = [eq(products.tenantId, tenant.id)];
  if (!parsed.includeDeleted) {
    filters.push(isNull(products.deletedAt));
  }

  if (decoded && decoded.kind === "live") {
    // Live-only mode: continue strict updated_at DESC, id DESC.
    const cursorTs = new Date(decoded.updatedAtIso);
    filters.push(
      or(
        lt(products.updatedAt, cursorTs),
        and(eq(products.updatedAt, cursorTs), lt(products.id, decoded.id)),
      )!,
    );
  } else if (decoded && decoded.kind === "bucket") {
    const cursorTs = new Date(decoded.sortDateIso);
    if (decoded.bucket === "d") {
      // Still inside the deleted bucket OR crossing into the live
      // bucket: (deletedAt < $ts) OR (deletedAt = $ts AND id < $id) OR
      // (deletedAt IS NULL — i.e. the entire live bucket is "after"
      // any deleted row in the bucketed sort).
      filters.push(
        or(
          and(isNotNull(products.deletedAt), lt(products.deletedAt, cursorTs)),
          and(
            isNotNull(products.deletedAt),
            eq(products.deletedAt, cursorTs),
            lt(products.id, decoded.id),
          ),
          isNull(products.deletedAt),
        )!,
      );
    } else {
      // bucket === "l": cursor is in the live bucket. We've already
      // exhausted the deleted bucket; only live rows past this point.
      filters.push(isNull(products.deletedAt));
      filters.push(
        or(
          lt(products.updatedAt, cursorTs),
          and(eq(products.updatedAt, cursorTs), lt(products.id, decoded.id)),
        )!,
      );
    }
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
    deletedAt: products.deletedAt,
  };
  const selectCols = ownerRole
    ? { ...baseSelect, costPriceMinor: products.costPriceMinor }
    : baseSelect;

  // ORDER BY depends on the mode:
  //   - includeDeleted=false: updated_at DESC, id DESC (unchanged)
  //   - includeDeleted=true:  bucket asc (deleted first, live second),
  //     deleted_at DESC NULLS LAST, updated_at DESC, id DESC
  // The bucket key `(deleted_at IS NULL) ASC` puts FALSE (deleted) ahead
  // of TRUE (live) — pg sorts FALSE < TRUE.
  const orderBy = parsed.includeDeleted
    ? [
        sql`(${products.deletedAt} IS NULL) ASC`,
        sql`${products.deletedAt} DESC NULLS LAST`,
        desc(products.updatedAt),
        desc(products.id),
      ]
    : [desc(products.updatedAt), desc(products.id)];

  const rows = await tx
    .select(selectCols)
    .from(products)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(parsed.limit + 1);

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = hasMore ? page[page.length - 1] : null;
  let nextCursor: string | null = null;
  if (last) {
    if (parsed.includeDeleted) {
      const isDeleted = last.deletedAt !== null;
      const sortDate = (isDeleted ? last.deletedAt : last.updatedAt) as Date;
      nextCursor = encodeBucketCursor(
        isDeleted ? "d" : "l",
        sortDate,
        last.id as string,
      );
    } else if (last.updatedAt) {
      nextCursor = encodeLiveCursor(last.updatedAt as Date, last.id as string);
    }
  }

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
