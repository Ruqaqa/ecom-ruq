/**
 * `scopes.tools` allowlist — sub-chunk 7.5 (security H-1).
 *
 * The set of tools a PAT can carry must be a closed enum. The allowlist
 * lives alongside `CreateAccessTokenInputSchema` so a grep over the
 * service file is the single source of truth. A new tool gets added to
 * the allowlist when it ships a registered entry AND is owner-reachable.
 *
 * Today's allowlist: `run_sql_readonly` (the only tool that consumes
 * `scopes.tools` — see sub-chunk 7.4). Arbitrary strings, case mismatches,
 * whitespace variants, and oversized arrays are all rejected.
 */
import { describe, expect, it } from "vitest";
import { CreateAccessTokenInputSchema } from "@/server/services/tokens/create-access-token";

describe("CreateAccessTokenInputSchema — scopes.tools allowlist (security H-1)", () => {
  function input(tools: unknown) {
    return {
      name: "t",
      scopes: { role: "staff" as const, tools },
      // experimentalToolsConfirm REQUIRED when tools is non-empty array —
      // we include it on every case so the tests isolate the allowlist
      // surface. The `experimentalToolsConfirm` requirement itself is
      // covered by the sibling test file.
      experimentalToolsConfirm: true,
    };
  }

  it("accepts an empty tools array", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      name: "t",
      scopes: { role: "staff" as const, tools: [] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the canonical allowlisted tool run_sql_readonly", () => {
    const result = CreateAccessTokenInputSchema.safeParse(input(["run_sql_readonly"]));
    expect(result.success).toBe(true);
  });

  it("rejects a tool that is not on the allowlist", () => {
    const result = CreateAccessTokenInputSchema.safeParse(input(["drop_database"]));
    expect(result.success).toBe(false);
  });

  it("rejects an uppercase variant (case-sensitive match)", () => {
    const result = CreateAccessTokenInputSchema.safeParse(input(["RUN_SQL_READONLY"]));
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace variant", () => {
    const result = CreateAccessTokenInputSchema.safeParse(input(["run sql readonly"]));
    expect(result.success).toBe(false);
  });

  it("rejects an array with 33 entries (exceeds max=32)", () => {
    const big = Array.from({ length: 33 }, () => "run_sql_readonly");
    const result = CreateAccessTokenInputSchema.safeParse(input(big));
    expect(result.success).toBe(false);
  });
});
