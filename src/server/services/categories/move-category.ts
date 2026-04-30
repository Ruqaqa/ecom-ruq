/**
 * `moveCategory` — sibling reorder service (1a.4.2 follow-up).
 *
 * Replaces the leaky operator-facing "Position" form field. Owners tap an
 * up/down arrow on the list page; the row moves exactly one slot within
 * its parent group.
 *
 * Architectural decisions:
 *   1. **No OCC token.** Re-evaluating against current DB state on each
 *      click is the right semantic; an OCC mismatch error would be hostile
 *      UX for "shuffle me one slot."
 *   2. **Per-tenant advisory xact lock** (mirrors `updateCategory`)
 *      serializes concurrent moves so two opposite-direction swaps cannot
 *      race past each other's pre-checks.
 *   3. **Sibling order** matches `listCategories`'s SQL ORDER BY for live
 *      rows under the same parent: `(position ASC, name->>'en' ASC,
 *      id ASC)`. Ties are broken by name then id, exactly as the list
 *      page renders them.
 *   4. **Tied positions self-heal lazily.** Many legacy rows share
 *      `position = 0` because nobody set one. Naive "set subject to
 *      neighbour ± 1" leapfrogs the entire tied block in one tap.
 *      Instead: if any two siblings in this parent group share a position,
 *      renumber the whole live sibling group with stride 10 in current
 *      render order, then swap subject and neighbour positions. Atomic
 *      with the move, no migration, self-healing on first interaction
 *      with each tied group. Stride 10 leaves room for future single-slot
 *      moves without re-renumbering until the next tie cluster forms.
 *   5. **First-in-group up / last-in-group down → no-op (idempotent).**
 *   6. **Soft-deleted rows are out-of-band.** A soft-deleted row id →
 *      NOT_FOUND (same shape as `updateCategory`).
 *
 * Audit `before` / `after` carry every row whose position actually
 * changed (just two when no ties; the renumbered group when ties got
 * healed), sorted by id for determinism. The audit log reflects the
 * actual data change.
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

  // 4. Compute target positions for the whole sibling group.
  //
  //    Build the desired final render order (subject and neighbour
  //    swapped). If any two siblings in the *current* group share a
  //    position, renumber the whole final order at stride 10 — this
  //    self-heals legacy ties so subsequent moves work in pure swap
  //    mode. Otherwise plain swap (subject and neighbour exchange
  //    positions; the rest of the group is untouched).
  const finalOrder = [...siblings];
  [finalOrder[subjectIdx], finalOrder[neighbourIdx]] = [
    finalOrder[neighbourIdx]!,
    finalOrder[subjectIdx]!,
  ];

  let hasTies = false;
  for (let i = 0; i + 1 < siblings.length; i++) {
    if (siblings[i]!.position === siblings[i + 1]!.position) {
      hasTies = true;
      break;
    }
  }

  const STRIDE = 10;
  const targetPositions = new Map<string, number>();
  if (hasTies) {
    finalOrder.forEach((row, i) => {
      targetPositions.set(row.id, i * STRIDE);
    });
  } else {
    targetPositions.set(subject.id, neighbour.position);
    targetPositions.set(neighbour.id, subject.position);
  }

  // 5. Compute the actual diff and apply UPDATEs only for rows whose
  //    position changed. The advisory lock above serializes concurrent
  //    reorders so we don't need OCC clauses on these UPDATEs.
  interface Change {
    id: string;
    oldPosition: number;
    newPosition: number;
  }
  const changes: Change[] = [];
  for (const sib of siblings) {
    const newPos = targetPositions.get(sib.id);
    if (newPos !== undefined && newPos !== sib.position) {
      changes.push({
        id: sib.id,
        oldPosition: sib.position,
        newPosition: newPos,
      });
    }
  }

  for (const c of changes) {
    await tx
      .update(categories)
      .set({ position: c.newPosition, updatedAt: sql`now()` })
      .where(
        and(
          eq(categories.id, c.id),
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
        ),
      );
  }

  // 6. Audit payload — every row whose position changed, sorted by id.
  const before: MoveCategorySnapshot[] = changes
    .map((c) => ({ id: c.id, position: c.oldPosition }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const after: MoveCategorySnapshot[] = changes
    .map((c) => ({ id: c.id, position: c.newPosition }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return MoveCategoryResultSchema.parse({ before, after, noop: false });
}
