/**
 * `hardDeleteExpiredCategories` — recovery-window sweeper service
 * (chunk 1a.4.3).
 *
 * Owner-only — bulk + irreversible. Tighter than delete/restore, which
 * are owner+staff. The owner-only gate is BOTH a runtime defense-in-
 * depth check here AND the transport-level role check.
 *
 * Cautious cascade-safety predicate (locked policy):
 *   Exclude any expired category from the purge set if its subtree
 *   contains a still-soft descendant whose `deleted_at` is younger than
 *   30 days (i.e., still inside its own recovery window). The FK cascade
 *   would silently end that descendant's recovery window if the parent
 *   were purged now. So the parent waits — until the next sweep run
 *   after the descendant ages out.
 *
 * `dryRun: true` returns the would-be-purged set without deleting.
 *
 * Audit shape: the wire return is the full {count, ids, slugs?, dryRun},
 * but the audit `after` payload is bounded to {count, ids} by the
 * transport — slugs and dryRun do NOT cross into audit_log (PDPL-
 * undeletable, bilingual fields could carry future buyer PII).
 *
 * FK cascade physically removes descendants whose own removal is also
 * expired AND `product_categories` join rows for purged categories.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface HardDeleteExpiredCategoriesTenantInfo {
  id: string;
}

export const HardDeleteExpiredCategoriesInputSchema = z.object({
  dryRun: z.boolean().default(false),
  // `z.literal(true)` even with dryRun — schema uniformity, mirrors the
  // products sweeper. The op is bulk-irreversible enough that "preview"
  // still requires confirm.
  confirm: z.literal(true),
});
export type HardDeleteExpiredCategoriesInput = z.input<
  typeof HardDeleteExpiredCategoriesInputSchema
>;

export interface HardDeleteCategoriesResult {
  count: number;
  /** Up to 50 ids — UI/audit shows "first 50 of N." */
  ids: string[];
  /** Preview only. Present iff dryRun=true. NEVER recorded in audit. */
  slugs?: string[];
  dryRun: boolean;
}

const PREVIEW_CAP = 50;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function hardDeleteExpiredCategories(
  tx: Tx,
  tenant: HardDeleteExpiredCategoriesTenantInfo,
  role: Role,
  input: HardDeleteExpiredCategoriesInput,
): Promise<HardDeleteCategoriesResult> {
  if (role !== "owner") {
    throw new Error("hardDeleteExpiredCategories: owner-only");
  }
  const parsed = HardDeleteExpiredCategoriesInputSchema.parse(input);

  // Bounded tenant tree (depth ≤ 3, hundreds of rows max). One query for
  // the whole tenant + in-memory cascade-safety walk is simpler to read
  // and reason about than a recursive CTE — CLAUDE.md §7 (explicit
  // patterns over clever abstractions).
  const allRows = await tx
    .select({
      id: categories.id,
      slug: categories.slug,
      parentId: categories.parentId,
      deletedAt: categories.deletedAt,
    })
    .from(categories)
    .where(eq(categories.tenantId, tenant.id));

  const now = Date.now();
  const isExpired = (deletedAt: Date | null) =>
    deletedAt !== null && now - deletedAt.getTime() > WINDOW_MS;
  const isYoung = (deletedAt: Date | null) =>
    deletedAt === null || now - deletedAt.getTime() <= WINDOW_MS;

  const childrenOf = new Map<
    string,
    Array<{ id: string; deletedAt: Date | null }>
  >();
  for (const row of allRows) {
    if (row.parentId !== null) {
      const list = childrenOf.get(row.parentId) ?? [];
      list.push({ id: row.id, deletedAt: row.deletedAt });
      childrenOf.set(row.parentId, list);
    }
  }

  const candidates = allRows.filter((r) => isExpired(r.deletedAt));
  const eligible: Array<{ id: string; slug: string }> = [];
  for (const cand of candidates) {
    let safe = true;
    let frontier: string[] = [cand.id];
    // Walk until the frontier is empty rather than capping at
    // MAX_TREE_DEPTH levels. The walk is naturally bounded by the
    // tenant's row count (already loaded above), and an unbounded loop
    // is the load-bearing safety net for a corrupted or directly-poked
    // tree where some descendant sits below depth 3 — without it, the
    // FK cascade would silently cut a live grandchild's recovery
    // window short. `seen` defends against any cycle a corrupted tree
    // could carry (FKs forbid this, but defense-in-depth).
    const seen = new Set<string>([cand.id]);
    while (safe && frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        const kids = childrenOf.get(id) ?? [];
        for (const k of kids) {
          if (isYoung(k.deletedAt)) {
            safe = false;
            break;
          }
          if (!seen.has(k.id)) {
            seen.add(k.id);
            next.push(k.id);
          }
        }
        if (!safe) break;
      }
      if (!safe) break;
      frontier = next;
    }
    if (safe) eligible.push({ id: cand.id, slug: cand.slug });
  }

  const ids = eligible.slice(0, PREVIEW_CAP).map((r) => r.id);
  const slugsPreview = eligible.slice(0, PREVIEW_CAP).map((r) => r.slug);
  const count = eligible.length;

  if (parsed.dryRun) {
    return { count, ids, slugs: slugsPreview, dryRun: true };
  }
  if (count === 0) {
    return { count: 0, ids: [], dryRun: false };
  }

  // Hard delete. FK cascade on `categories.parent_id` and on
  // `product_categories.category_id` purges descendants (whose own
  // `deleted_at` is by construction also expired — the cascade-safety
  // predicate above guaranteed this) and join rows.
  await tx
    .delete(categories)
    .where(
      and(
        eq(categories.tenantId, tenant.id),
        inArray(
          categories.id,
          eligible.map((r) => r.id),
        ),
      ),
    );
  return { count, ids, dryRun: false };
}
