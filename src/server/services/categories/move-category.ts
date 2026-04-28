/**
 * `moveCategory` — sibling-swap reorder service (1a.4.2 follow-up).
 *
 * Replaces the leaky operator-facing "Position" form field. Owners now tap
 * an up/down arrow next to each row on the categories list; the service
 * swaps the row's `position` with that of its immediate sibling neighbour
 * (in the same parent group) in the requested direction.
 *
 * Architectural decisions:
 *   1. **No OCC token.** The move is a closed, bounded operation: the
 *      operator's intent is "shuffle me one slot relative to my current
 *      neighbours", and that intent is re-evaluated against the *current*
 *      DB state on each click. An OCC mismatch error would be a worse UX
 *      than just performing the swap against the latest order.
 *   2. **Per-tenant advisory xact lock** (mirrors `updateCategory`)
 *      serializes concurrent moves so two opposite-direction swaps cannot
 *      race past each other's pre-checks. Cycle/depth invariants are
 *      *unchanged* by a sibling swap — only `position` columns move — so
 *      the lock is the only ordering primitive we need.
 *   3. **Sibling order** matches `listCategories`'s SQL ORDER BY for live
 *      rows under the same parent: `(position ASC, name->>'en' ASC,
 *      id ASC)`. Ties (legacy data has many rows at position=0) are
 *      broken deterministically by name then id, exactly as the list
 *      page renders them.
 *   4. **Tie-break under equal `position`.** When the immediate neighbour
 *      shares this row's position, we don't shuffle the whole group — we
 *      simply set this row's position to `neighbour.position - 1` (move
 *      up) or `neighbour.position + 1` (move down). The neighbour stays
 *      put. This breaks the visual tie deterministically without a full
 *      sibling rebuild.
 *   5. **First-in-group up / last-in-group down → no-op (idempotent).**
 *      Service returns `before === after` and audit observes the no-op.
 *      Mirrors how `setProductCategories` happily accepts the current
 *      set as desired and writes a no-op audit row.
 *   6. **Soft-deleted rows are out-of-band.** Reordering operates on live
 *      siblings only. A soft-deleted row id → NOT_FOUND (same shape as
 *      `updateCategory`).
 *
 * Audit `before` / `after` are the two affected rows' `(id, position)`
 * pairs sorted by id for determinism. Adapter (mutationProcedure /
 * MCP `auditMode:"mutation"`) handles the audit-write itself.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface MoveCategoryTenantInfo {
  id: string;
}

export const MoveCategoryDirectionSchema = z.enum(["up", "down"]);
export type MoveCategoryDirection = z.infer<typeof MoveCategoryDirectionSchema>;

export const MoveCategoryInputSchema = z.object({
  id: z.string().uuid(),
  direction: MoveCategoryDirectionSchema,
});
export type MoveCategoryInput = z.input<typeof MoveCategoryInputSchema>;

export const MoveCategorySnapshotSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
});
export type MoveCategorySnapshot = z.infer<typeof MoveCategorySnapshotSchema>;

export const MoveCategoryResultSchema = z.object({
  before: z.array(MoveCategorySnapshotSchema),
  after: z.array(MoveCategorySnapshotSchema),
  /** True if the row is already at the edge in the requested direction. */
  noop: z.boolean(),
});
export type MoveCategoryResult = z.infer<typeof MoveCategoryResultSchema>;

interface SiblingRow {
  id: string;
  position: number;
}

export async function moveCategory(
  tx: Tx,
  tenant: MoveCategoryTenantInfo,
  role: Role,
  input: MoveCategoryInput,
): Promise<MoveCategoryResult> {
  if (!isWriteRole(role)) {
    throw new Error("moveCategory: role not permitted");
  }
  const parsed = MoveCategoryInputSchema.parse(input);

  // Serialize concurrent reorders within the tenant. Same advisory key
  // as `updateCategory` because a re-parent in flight would invalidate
  // our sibling-set snapshot below.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('categories_tree:' || ${tenant.id}))`,
  );

  // 1. Resolve the row, get its parentId. NOT_FOUND for cross-tenant /
  //    soft-deleted / phantom — same opaque shape regardless.
  const subjectRows = await tx
    .select({
      id: categories.id,
      parentId: categories.parentId,
      position: categories.position,
    })
    .from(categories)
    .where(
      and(
        eq(categories.id, parsed.id),
        eq(categories.tenantId, tenant.id),
        isNull(categories.deletedAt),
      ),
    )
    .limit(1);
  const subject = subjectRows[0];
  if (!subject) {
    throw new TRPCError({ code: "NOT_FOUND", message: "category_not_found" });
  }

  // 2. Pull the live sibling group, ordered the same way `listCategories`
  //    renders them. Tie-break by name->>'en' then id matches the SQL
  //    ORDER BY in the list page.
  const parentFilter =
    subject.parentId === null
      ? isNull(categories.parentId)
      : eq(categories.parentId, subject.parentId);

  const siblingRows = await tx
    .select({ id: categories.id, position: categories.position })
    .from(categories)
    .where(
      and(
        eq(categories.tenantId, tenant.id),
        isNull(categories.deletedAt),
        parentFilter,
      ),
    )
    .orderBy(
      asc(categories.position),
      sql`${categories.name}->>'en' ASC`,
      asc(categories.id),
    );

  const siblings: SiblingRow[] = siblingRows.map((r) => ({
    id: r.id,
    position: r.position,
  }));

  const subjectIdx = siblings.findIndex((s) => s.id === subject.id);
  if (subjectIdx === -1) {
    // Defensive — the live-row probe above passed but the sibling scan
    // didn't see it. Same NOT_FOUND shape; should be unreachable.
    throw new TRPCError({ code: "NOT_FOUND", message: "category_not_found" });
  }

  const neighbourIdx =
    parsed.direction === "up" ? subjectIdx - 1 : subjectIdx + 1;
  const isEdge =
    parsed.direction === "up"
      ? subjectIdx === 0
      : subjectIdx === siblings.length - 1;

  // 3. Edge tap → idempotent no-op. before = after = both rows' current
  //    positions (use the subject alone since there's nothing to swap
  //    with; audit consumers see a deterministic no-op marker).
  if (isEdge) {
    const snap: MoveCategorySnapshot = {
      id: subject.id,
      position: subject.position,
    };
    return MoveCategoryResultSchema.parse({
      before: [snap],
      after: [snap],
      noop: true,
    });
  }

  const neighbour = siblings[neighbourIdx]!;

  // 4. Compute the new positions.
  //    - When positions differ: straightforward swap.
  //    - When positions are equal (legacy data, ties): move the subject
  //      one slot past the neighbour without disturbing the neighbour.
  //      `up` → neighbour.position - 1, `down` → neighbour.position + 1.
  let subjectNewPos: number;
  let neighbourNewPos: number;
  if (subject.position !== neighbour.position) {
    subjectNewPos = neighbour.position;
    neighbourNewPos = subject.position;
  } else {
    subjectNewPos =
      parsed.direction === "up" ? neighbour.position - 1 : neighbour.position + 1;
    neighbourNewPos = neighbour.position;
  }

  // 5. Apply both updates inside the same tx. The advisory lock above
  //    serializes concurrent reorders so we don't need OCC clauses on
  //    these UPDATEs.
  if (subjectNewPos !== subject.position) {
    await tx
      .update(categories)
      .set({ position: subjectNewPos, updatedAt: sql`now()` })
      .where(
        and(
          eq(categories.id, subject.id),
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
        ),
      );
  }
  if (neighbourNewPos !== neighbour.position) {
    await tx
      .update(categories)
      .set({ position: neighbourNewPos, updatedAt: sql`now()` })
      .where(
        and(
          eq(categories.id, neighbour.id),
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
        ),
      );
  }

  // 6. Audit payload. Sort by id for determinism.
  const before: MoveCategorySnapshot[] = [
    { id: subject.id, position: subject.position },
    { id: neighbour.id, position: neighbour.position },
  ].sort((a, b) => a.id.localeCompare(b.id));
  const after: MoveCategorySnapshot[] = [
    { id: subject.id, position: subjectNewPos },
    { id: neighbour.id, position: neighbourNewPos },
  ].sort((a, b) => a.id.localeCompare(b.id));

  return MoveCategoryResultSchema.parse({ before, after, noop: false });
}
