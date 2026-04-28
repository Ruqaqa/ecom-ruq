/**
 * `move_category_up` / `move_category_down` MCP tools — unit tests.
 *
 * Mirrors the update-category MCP tool tests:
 *   - Visibility on owner / staff; hidden for support / anon.
 *   - Authorize rejects support and anonymous.
 *   - `.strict()` on input rejects unknown keys.
 *   - tx-null tripwire throws McpError("internal_error").
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  moveCategoryUpTool,
  moveCategoryDownTool,
} from "@/server/mcp/tools/move-category";
import { McpError } from "@/server/mcp/errors";
import type { McpRequestContext } from "@/server/mcp/context";
import type { Tenant } from "@/server/tenant";

const tenant: Tenant = {
  id: randomUUID(),
  slug: "t",
  primaryDomain: "t.local",
  defaultLocale: "en",
  senderEmail: "no-reply@t.local",
  name: { en: "T", ar: "ت" },
};

function ctxBearer(role: "owner" | "staff" | "support"): McpRequestContext {
  return {
    tenant,
    identity: {
      type: "bearer",
      userId: "u-1",
      tokenId: "tok-1",
      role,
      scopes: { role, tools: ["move_category_up", "move_category_down"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

const ctxAnon: McpRequestContext = {
  tenant,
  identity: { type: "anonymous" },
  correlationId: "cid-anon",
  auditOverride: {},
};

const tools = [
  ["up", moveCategoryUpTool],
  ["down", moveCategoryDownTool],
] as const;

describe.each(tools)("%s tool — visibility + authorize", (label, tool) => {
  it(`${label}: visible for owner / staff; hidden otherwise`, () => {
    expect(tool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(tool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(tool.isVisibleFor(ctxBearer("support"))).toBe(false);
    expect(tool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it(`${label}: authorize rejects support / anon`, () => {
    try {
      tool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      tool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe.each(tools)("%s tool — input schema .strict()", (label, tool) => {
  it(`${label}: rejects extra key direction (set internally, not on the wire)`, () => {
    expect(
      tool.inputSchema.safeParse({ id: randomUUID(), direction: "up" }).success,
    ).toBe(false);
  });
  it(`${label}: rejects extra key tenantId`, () => {
    expect(
      tool.inputSchema.safeParse({
        id: randomUUID(),
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it(`${label}: accepts minimal valid input`, () => {
    expect(
      tool.inputSchema.safeParse({ id: randomUUID() }).success,
    ).toBe(true);
  });
});

describe.each(tools)("%s tool — handler tripwire", (label, tool) => {
  it(`${label}: throws McpError('internal_error') on tx=null`, async () => {
    try {
      await tool.handler(ctxBearer("owner"), { id: randomUUID() }, null);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("internal_error");
    }
  });
});

describe("tool naming", () => {
  it("up tool is named move_category_up", () => {
    expect(moveCategoryUpTool.name).toBe("move_category_up");
  });
  it("down tool is named move_category_down", () => {
    expect(moveCategoryDownTool.name).toBe("move_category_down");
  });
});
