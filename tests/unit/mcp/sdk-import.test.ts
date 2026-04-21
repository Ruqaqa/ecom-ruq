/**
 * Smoke test — the MCP SDK's two entry points we actually import resolve
 * to callable class constructors. This catches a future SDK major-version
 * reorganization in CI rather than at runtime when the MCP route is first
 * hit. If this test red-lines, the SDK pin changed shape and the MCP
 * route + tool registry need to be revisited.
 */
import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

describe("@modelcontextprotocol/sdk import smoke", () => {
  it("exports Server as a constructor (class)", () => {
    expect(typeof Server).toBe("function");
  });

  it("exports WebStandardStreamableHTTPServerTransport as a constructor (class)", () => {
    expect(typeof WebStandardStreamableHTTPServerTransport).toBe("function");
  });
});
