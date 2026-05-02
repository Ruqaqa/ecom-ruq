/**
 * `hardDeleteExpiredProducts` — recovery-window sweeper service.
 *
 * Owner-only — bulk + irreversible (FK cascade purges children). Tighter
 * than delete/restore, which are owner+staff. The owner-only gate is
 * BOTH a runtime defense-in-depth check here AND the transport-level
 * `requireRole({ roles: ["owner"] })` on the tRPC mutation / MCP
 * `authorize`.
 *
 * Tenant-scope invariant: this service runs under the same `withTenant`
 * scope as every other tenant-scoped service. The sweeper purges only
 * the caller's own tenant. Cross-tenant purging — via the future
 * Phase-1b cron — must iterate per-tenant under `withTenant(tenantCtx)`
 * for each tenant, not a single cross-tenant DELETE.
 *
 * Audit shape: the wire return is the full result {count, ids, slugs?,
 * dryRun}. The audit `after` payload is bounded to {count, ids} by the
 * transport — slugs and dryRun do NOT cross into audit_log
 * (PDPL-undeletable, bilingual name fields could carry future buyer
 * PII; bounded shape protects the chain).
 *
 * Chunk 1a.7.1 Block 7 — image cleanup hook. Before the row delete,
 * collect every product_image's storage_key + every derivative key.
 * After the DB cascade fires, best-effort `Promise.allSettled` over
 * `adapter.delete(...)`. Failures are logged to Sentry as
 * `product_purge_storage_orphan` and NEVER thrown — the DB purge stays
 * atomic. There is no job runner in 1a.7.1; manual operator cleanup
 * until Phase 1b's job runner ships.
 */
import { z } from "zod";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";
import { getStorageAdapter, type StorageAdapter } from "@/server/storage";
import { captureMessage, summarizeErrorForObs } from "@/server/obs/sentry";

export interface HardDeleteExpiredTenantInfo {
  id: string;
}

export const HardDeleteExpiredProductsInputSchema = z.object({
  dryRun: z.boolean().default(false),
  // `z.literal(true)` even on dryRun — schema uniformity. The op is
  // bulk-irreversible enough that "preview" still requires confirm.
  confirm: z.literal(true),
});
export type HardDeleteExpiredProductsInput = z.input<
  typeof HardDeleteExpiredProductsInputSchema
>;

export interface HardDeleteResult {
  count: number;
  /** Up to 50 ids — UI/audit can show "first 50 of N." */
  ids: string[];
  /** Preview only. Present iff dryRun=true. NEVER recorded in audit. */
  slugs?: string[];
  dryRun: boolean;
}

export interface HardDeleteServiceDeps {
  /**
   * Storage adapter for the image cleanup hook. Defaults to the
   * factory-resolved adapter at call time. Tests inject a local-disk
   * adapter pointing at a temp dir.
   */
  storage?: StorageAdapter;
}

const PREVIEW_CAP = 50;
const WINDOW = sql`interval '30 days'`;

export async function hardDeleteExpiredProducts(
  tx: Tx,
  tenant: HardDeleteExpiredTenantInfo,
  role: Role,
  input: HardDeleteExpiredProductsInput,
  deps: HardDeleteServiceDeps = {},
): Promise<HardDeleteResult> {
  if (role !== "owner") {
    throw new Error("hardDeleteExpiredProducts: owner-only");
  }
  const parsed = HardDeleteExpiredProductsInputSchema.parse(input);

  // Pick rows whose deletedAt is older than 30 days under this tenant.
  // Tenant scope is enforced application-side AND by RLS once a real
  // app-role caller hits this path.
  const expiredRows = await tx
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenant.id),
        isNotNull(products.deletedAt),
        sql`now() - ${products.deletedAt} > ${WINDOW}`,
      ),
    );

  const count = expiredRows.length;
  const ids = expiredRows.slice(0, PREVIEW_CAP).map((r) => r.id);
  const slugsPreview = expiredRows.slice(0, PREVIEW_CAP).map((r) => r.slug);

  if (parsed.dryRun) {
    return { count, ids, slugs: slugsPreview, dryRun: true };
  }
  if (count === 0) {
    return { count: 0, ids: [], dryRun: false };
  }

  // Collect every storage key for the doomed images BEFORE the row
  // delete fires the FK cascade. We need the keys to feed the storage
  // adapter; once the cascade runs, the rows are gone.
  const expiredProductIds = expiredRows.map((r) => r.id);
  const imageRows = await tx
    .select({
      storageKey: productImages.storageKey,
      derivatives: productImages.derivatives,
    })
    .from(productImages)
    .where(inArray(productImages.productId, expiredProductIds));
  const allKeys: string[] = [];
  for (const row of imageRows) {
    allKeys.push(row.storageKey);
    for (const d of row.derivatives) allKeys.push(d.storageKey);
  }

  // Hard delete — same WHERE so a row that races out of expiry between
  // SELECT and DELETE is still safe (the predicate re-applies).
  await tx
    .delete(products)
    .where(
      and(
        eq(products.tenantId, tenant.id),
        isNotNull(products.deletedAt),
        sql`now() - ${products.deletedAt} > ${WINDOW}`,
      ),
    );

  // Best-effort storage purge — runs outside the row-delete tx (which
  // is already committed by the time the caller's withTenant scope
  // unwinds). Failures are logged, never thrown.
  if (allKeys.length > 0) {
    const adapter = deps.storage ?? getStorageAdapter();
    const settled = await Promise.allSettled(allKeys.map((k) => adapter.delete(k)));
    const failures = settled.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      captureMessage("product_purge_storage_orphan", {
        level: "warning",
        extra: {
          orphanCount: failures.length,
          totalKeys: allKeys.length,
          // Only the COUNT goes to Sentry; the keys themselves derive
          // from tenant slug + product slug and could leak product
          // identifiers. The DB row is already gone — the operator
          // recovers via direct storage admin, not by replaying keys
          // out of Sentry.
          sampleCause: summarizeErrorForObs(
            (failures[0] as PromiseRejectedResult).reason,
          ),
        },
      });
    }
  }

  return { count, ids, dryRun: false };
}
