/**
 * Builds the picker-friendly `CategoryOption[]` from the flat `Category[]`
 * the listCategories service returns. Each option carries:
 *   - id
 *   - depth (1 | 2 | 3)
 *   - parentId
 *   - slug
 *   - fullPath: `{ en, ar }` strings joined with `›` (Latin chevron),
 *     using the localized name at each level with `pickLocalizedName`'s
 *     fallback semantics. Empty/missing segments fall back to `slug` so
 *     a row missing both translations still has a stable display.
 *
 * Used by the create/edit category forms (parent picker) and the
 * product-edit form (multi-pick). Building paths server-side keeps the
 * picker component itself pure-presentational.
 */
import type { Category } from "@/server/services/categories/create-category";
import { pickLocalizedName } from "@/lib/i18n/pick-localized-name";
import { MAX_TREE_DEPTH } from "@/server/services/categories/validate-category-tree";

const PATH_SEP = " › ";

export interface CategoryOption {
  id: string;
  parentId: string | null;
  slug: string;
  depth: 1 | 2 | 3;
  fullPath: { en: string; ar: string };
}

function pickName(
  name: Category["name"] | undefined,
  locale: "en" | "ar",
  fallbackSlug: string,
): string {
  return pickLocalizedName(name ?? null, locale).text ?? fallbackSlug;
}

/**
 * Returns the ids of `nodeId` PLUS every descendant in the tree. Used
 * by the edit-category page to compute `excludeIds` for the parent
 * picker — a category cannot be re-parented under itself or any of
 * its descendants without forming a cycle. Bounded by MAX_TREE_DEPTH,
 * so a BFS by level is at most that many passes over the array.
 */
export function collectSelfAndDescendantIds(
  categories: ReadonlyArray<Category>,
  nodeId: string,
): string[] {
  const out = new Set<string>([nodeId]);
  for (let depth = 0; depth < MAX_TREE_DEPTH; depth++) {
    let added = false;
    for (const c of categories) {
      if (c.parentId !== null && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        added = true;
      }
    }
    if (!added) break;
  }
  return [...out];
}

export function buildCategoryOptions(
  categories: ReadonlyArray<Category>,
): CategoryOption[] {
  const byId = new Map<string, Category>();
  for (const c of categories) byId.set(c.id, c);

  return categories.map((c) => {
    const segments: Array<{ en: string; ar: string }> = [];
    let cur: Category | undefined = c;
    let guard = 0;
    while (cur && guard < MAX_TREE_DEPTH) {
      segments.unshift({
        en: pickName(cur.name, "en", cur.slug),
        ar: pickName(cur.name, "ar", cur.slug),
      });
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      guard += 1;
    }
    return {
      id: c.id,
      parentId: c.parentId,
      slug: c.slug,
      depth: c.depth as 1 | 2 | 3,
      fullPath: {
        en: segments.map((s) => s.en).join(PATH_SEP),
        ar: segments.map((s) => s.ar).join(PATH_SEP),
      },
    };
  });
}
