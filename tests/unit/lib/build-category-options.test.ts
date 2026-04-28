import { describe, it, expect } from "vitest";
import {
  buildCategoryOptions,
  collectSelfAndDescendantIds,
} from "@/lib/categories/build-category-options";
import type { Category } from "@/server/services/categories/create-category";

function cat(opts: Partial<Category>): Category {
  const now = new Date();
  return {
    id: opts.id ?? "id-?",
    slug: opts.slug ?? "slug",
    name: opts.name ?? { en: "X", ar: "س" },
    description: opts.description ?? null,
    parentId: opts.parentId ?? null,
    position: opts.position ?? 0,
    depth: opts.depth ?? 1,
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    deletedAt: opts.deletedAt ?? null,
  } as Category;
}

describe("buildCategoryOptions", () => {
  it("builds full-path joined by ` › ` for a depth-3 row", () => {
    const root = cat({
      id: "r",
      slug: "r",
      name: { en: "Root", ar: "جذر" },
      depth: 1,
    });
    const child = cat({
      id: "c",
      slug: "c",
      name: { en: "Child", ar: "فرع" },
      parentId: "r",
      depth: 2,
    });
    const grand = cat({
      id: "g",
      slug: "g",
      name: { en: "Grand", ar: "حفيد" },
      parentId: "c",
      depth: 3,
    });
    const opts = buildCategoryOptions([root, child, grand]);
    const grandOpt = opts.find((o) => o.id === "g")!;
    expect(grandOpt.fullPath.en).toBe("Root › Child › Grand");
    expect(grandOpt.fullPath.ar).toBe("جذر › فرع › حفيد");
  });

  it("falls back to the other locale when one side is missing", () => {
    const root = cat({
      id: "r",
      slug: "rslug",
      name: { en: "Cameras", ar: "" } as never,
      depth: 1,
    });
    const opts = buildCategoryOptions([root]);
    expect(opts[0]!.fullPath.en).toBe("Cameras");
    // Empty Arabic falls back to English.
    expect(opts[0]!.fullPath.ar).toBe("Cameras");
  });

  it("falls back to slug when both locales are missing", () => {
    const root = cat({
      id: "r",
      slug: "rslug",
      name: { en: "", ar: "" } as never,
      depth: 1,
    });
    const opts = buildCategoryOptions([root]);
    expect(opts[0]!.fullPath.en).toBe("rslug");
    expect(opts[0]!.fullPath.ar).toBe("rslug");
  });

  it("preserves depth + parentId + slug verbatim", () => {
    const root = cat({ id: "r", slug: "r", depth: 1 });
    const child = cat({ id: "c", slug: "c", parentId: "r", depth: 2 });
    const opts = buildCategoryOptions([root, child]);
    const childOpt = opts.find((o) => o.id === "c")!;
    expect(childOpt.depth).toBe(2);
    expect(childOpt.parentId).toBe("r");
    expect(childOpt.slug).toBe("c");
  });
});

describe("collectSelfAndDescendantIds", () => {
  it("includes self when there are no descendants", () => {
    const root = cat({ id: "r", slug: "r" });
    expect(collectSelfAndDescendantIds([root], "r")).toEqual(["r"]);
  });

  it("collects self + child + grandchild for a depth-3 chain", () => {
    const root = cat({ id: "r", slug: "r", depth: 1 });
    const child = cat({ id: "c", slug: "c", parentId: "r", depth: 2 });
    const grand = cat({ id: "g", slug: "g", parentId: "c", depth: 3 });
    const ids = collectSelfAndDescendantIds([root, child, grand], "r");
    expect([...ids].sort()).toEqual(["c", "g", "r"]);
  });

  it("does NOT include unrelated siblings or unrelated subtrees", () => {
    const root = cat({ id: "r", slug: "r", depth: 1 });
    const child = cat({ id: "c", slug: "c", parentId: "r", depth: 2 });
    const sibling = cat({ id: "s", slug: "s", depth: 1 });
    const ids = collectSelfAndDescendantIds([root, child, sibling], "r");
    expect(ids).not.toContain("s");
    expect([...ids].sort()).toEqual(["c", "r"]);
  });
});
