/**
 * M-1 — `AccessTokenListItemSchema.scopes.tools` is enum-tight.
 *
 * If `TOOL_ALLOWLIST` ever shrinks (a tool is deprecated), old rows
 * whose `scopes.tools` still names the deprecated tool must fail
 * `.parse` rather than quietly display in the admin UI as if live.
 * This is the Tier-B fail-loud posture the output schema must hold.
 *
 * The unit doesn't need a live DB — `.parse` is a pure Zod check.
 */
import { describe, expect, it } from "vitest";
import { AccessTokenListItemSchema } from "@/server/services/tokens/list-access-tokens";

function row(tools: unknown): unknown {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test",
    tokenPrefix: "abcd1234",
    scopes: { role: "owner", tools },
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
  };
}

describe("AccessTokenListItemSchema — scopes.tools enum", () => {
  it("rejects a row whose scopes.tools names a non-allowlisted tool", () => {
    expect(() => AccessTokenListItemSchema.parse(row(["deprecated_tool"]))).toThrow();
  });

  it("accepts a row whose scopes.tools names an allowlisted tool", () => {
    const parsed = AccessTokenListItemSchema.parse(row(["run_sql_readonly"]));
    expect(parsed.scopes.tools).toEqual(["run_sql_readonly"]);
  });

  it("accepts a row whose scopes.tools is absent (tools is optional)", () => {
    const parsed = AccessTokenListItemSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "test",
      tokenPrefix: "abcd1234",
      scopes: { role: "owner" },
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    });
    expect(parsed.scopes.tools).toBeUndefined();
  });
});
