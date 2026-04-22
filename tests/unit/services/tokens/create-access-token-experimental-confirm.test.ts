/**
 * `experimentalToolsConfirm` gate — sub-chunk 7.5 (security H-4).
 *
 * Mirroring the `ownerScopeConfirm` pattern (S-1 in sub-chunk 7.1), any
 * PAT being minted with a non-empty `scopes.tools` array must carry an
 * explicit `experimentalToolsConfirm: true` flag. Experimental grants are
 * a destructive posture (the PAT gets reach into tools that today include
 * the direct-database readonly path, locked-off per 7.4), so the input
 * must be explicit, not a side-effect.
 *
 * When `scopes.tools` is absent or empty, the confirm flag is NOT
 * required — most PATs don't carry tool grants.
 */
import { describe, expect, it } from "vitest";
import { CreateAccessTokenInputSchema } from "@/server/services/tokens/create-access-token";

describe("CreateAccessTokenInputSchema — experimentalToolsConfirm gate (security H-4)", () => {
  it("rejects scopes.tools=['run_sql_readonly'] without experimentalToolsConfirm", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      name: "t",
      scopes: { role: "staff" as const, tools: ["run_sql_readonly"] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("experimentalToolsConfirm");
    }
  });

  it("accepts scopes.tools=['run_sql_readonly'] with experimentalToolsConfirm=true", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      name: "t",
      scopes: { role: "staff" as const, tools: ["run_sql_readonly"] },
      experimentalToolsConfirm: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts scopes without tools — experimentalToolsConfirm not required", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      name: "t",
      scopes: { role: "staff" as const },
    });
    expect(result.success).toBe(true);
  });

  it("accepts scopes with tools: [] — experimentalToolsConfirm not required", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      name: "t",
      scopes: { role: "staff" as const, tools: [] },
    });
    expect(result.success).toBe(true);
  });
});
