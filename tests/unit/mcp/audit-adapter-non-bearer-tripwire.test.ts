/**
 * O-8 (7.6.6) — mutation-mode tripwire for non-bearer identity.
 *
 * `dispatchTool` with `auditMode:"mutation"` was silently coercing
 * the actor role to `"anonymous"` when the caller identity type was
 * not `"bearer"`. Under the HTTP route this branch is unreachable
 * (anonymous is rejected at the edge), but if a future refactor
 * removed that edge-reject, the audit row would quietly lose fidelity.
 *
 * This test constructs a minimal mutation-mode tool with a no-op
 * `authorize` + an anonymous-identity context, calls `dispatchTool`,
 * and asserts it throws `McpError` with `kind:"internal_error"` BEFORE
 * any DB work. It bypasses the HTTP route entirely — this is the
 * defense-in-depth canary.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { dispatchTool } from "@/server/mcp/audit-adapter";
import { McpError } from "@/server/mcp/errors";
import type { McpRequestContext } from "@/server/mcp/context";
import type { McpTool } from "@/server/mcp/tools/registry";
import type { Tenant } from "@/server/tenant";
import { randomUUID } from "node:crypto";

const tenant: Tenant = {
  id: randomUUID(),
  slug: "t",
  primaryDomain: "t.local",
  defaultLocale: "en",
  senderEmail: "no-reply@t.local",
  name: { en: "T", ar: "ت" },
};

function ctxAnonymous(): McpRequestContext {
  return {
    tenant,
    identity: { type: "anonymous" },
    correlationId: "cid-anon",
  };
}

interface EchoInput {
  x: number;
}
interface EchoOutput {
  x: number;
}

// Mutation-mode tool with a permissive authorize so the request reaches
// the tripwire. Under real deployment, authorize would of course reject
// anonymous — but the tripwire is the belt-and-braces layer.
const mutationTool: McpTool<EchoInput, EchoOutput> = {
  name: "test_mutate",
  description: "tripwire fixture",
  inputSchema: z.object({ x: z.number() }).strict(),
  outputSchema: z.object({ x: z.number() }),
  isVisibleFor: () => true,
  authorize: () => {},
  handler: async (_ctx, input, _tx) => ({ x: input.x }),
};

describe("dispatchTool — mutation-mode non-bearer tripwire", () => {
  it("throws McpError(internal_error) when identity is not bearer", async () => {
    await expect(
      dispatchTool(ctxAnonymous(), mutationTool, { x: 1 }, { auditMode: "mutation" }),
    ).rejects.toMatchObject({
      name: "McpError",
      kind: "internal_error",
    });
  });

  it("the thrown error is an McpError instance (not a generic Error)", async () => {
    await expect(
      dispatchTool(ctxAnonymous(), mutationTool, { x: 1 }, { auditMode: "mutation" }),
    ).rejects.toBeInstanceOf(McpError);
  });
});
