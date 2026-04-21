/**
 * `dispatchTool(ctx, tool, input, config)` — read-vs-mutate contract.
 *
 * Phase 7.2 scope:
 *   - config.auditMode === "none" → no `withTenant` / `insertAuditInTx`
 *     / `writeAuditInOwnTx` invocation on either success OR failure.
 *     The handler still runs, the last_used_at debounce still fires.
 *     (Mutation-mode audit behavior lands properly in 7.3 integration
 *     tests against a real DB.)
 *   - Error from authorize() / handler is re-thrown verbatim (the
 *     transport translates to JSON-RPC; raw err.message is NOT in the
 *     audit row).
 *
 * These tests spy on the `@/server/db` withTenant export and the
 * `@/server/audit/write` module to verify the zero-audit invariant.
 * Real DB work lives in the block-7 Part D integration matrix.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { dispatchTool } from "@/server/mcp/audit-adapter";
import { McpError } from "@/server/mcp/errors";
import type { McpRequestContext } from "@/server/mcp/context";
import type { McpTool } from "@/server/mcp/tools/registry";
import type { Tenant } from "@/server/tenant";
import { randomUUID } from "node:crypto";
import { __setRedisForTests } from "@/server/auth/last-used-debounce";

const tenant: Tenant = {
  id: randomUUID(),
  slug: "t",
  primaryDomain: "t.local",
  defaultLocale: "en",
  senderEmail: "no-reply@t.local",
  name: { en: "T", ar: "ت" },
};

function ctxBearer(): McpRequestContext {
  return {
    tenant,
    identity: {
      type: "bearer",
      userId: "u-1",
      tokenId: "tok-1",
      role: "owner",
      scopes: { role: "owner" },
    },
    correlationId: "cid-1",
  };
}

interface EchoInput {
  x: number;
}
interface EchoOutput {
  x: number;
}
const echoTool: McpTool<EchoInput, EchoOutput> = {
  name: "echo",
  description: "echo for tests",
  inputSchema: z.object({ x: z.number() }).strict(),
  outputSchema: z.object({ x: z.number() }),
  isVisibleFor: () => true,
  authorize: () => {},
  // 7.3 extended the handler signature to `(ctx, input, tx: Tx | null)`.
  // The third arg is null for auditMode:"none" dispatches (reads don't
  // open withTenant). Tests that care about tx-threading assert it
  // inside the handler via an accumulator — see the test cases below.
  handler: async (_ctx, input, _tx) => ({ x: input.x }),
};

afterEach(() => {
  vi.restoreAllMocks();
  __setRedisForTests(null);
});

describe("dispatchTool — read path (auditMode='none')", () => {
  it("returns the parsed output on success without touching withTenant or audit writes", async () => {
    const dbMod = await import("@/server/db");
    const writeMod = await import("@/server/audit/write");
    const withTenantSpy = vi.spyOn(dbMod, "withTenant");
    const insertSpy = vi.spyOn(writeMod, "insertAuditInTx");
    const failSpy = vi.spyOn(writeMod, "writeAuditInOwnTx");

    // Stub Redis so the debounce doesn't touch real Redis during unit test.
    // `SET NX EX` returns null the second time; first call returns OK.
    const setFn = vi.fn(() => "OK");
    __setRedisForTests({ set: setFn } as never);

    const out = await dispatchTool(ctxBearer(), echoTool, { x: 7 }, { auditMode: "none" });
    expect(out).toEqual({ x: 7 });
    expect(withTenantSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(failSpy).not.toHaveBeenCalled();
  });

  it("re-throws authorize failures (McpError) WITHOUT writing a failure audit row in 'none' mode", async () => {
    const writeMod = await import("@/server/audit/write");
    const failSpy = vi.spyOn(writeMod, "writeAuditInOwnTx");

    const denied: McpTool<EchoInput, EchoOutput> = {
      ...echoTool,
      authorize: () => {
        throw new McpError("unauthorized", "bearer required");
      },
    };
    await expect(
      dispatchTool(ctxBearer(), denied, { x: 1 }, { auditMode: "none" }),
    ).rejects.toBeInstanceOf(McpError);
    expect(failSpy).not.toHaveBeenCalled();
  });

  it("re-throws handler failures WITHOUT writing audit rows in 'none' mode", async () => {
    const writeMod = await import("@/server/audit/write");
    const failSpy = vi.spyOn(writeMod, "writeAuditInOwnTx");

    const broken: McpTool<EchoInput, EchoOutput> = {
      ...echoTool,
      handler: async () => {
        throw new Error("eruq_pat_SECRETLEAK_DO_NOT_AUDIT_ME");
      },
    };
    await expect(
      dispatchTool(ctxBearer(), broken, { x: 1 }, { auditMode: "none" }),
    ).rejects.toThrow();
    expect(failSpy).not.toHaveBeenCalled();
  });

  it("threads tx=null into the handler for auditMode='none' tools (read path never opens withTenant)", async () => {
    // Step 3 invariant: the dispatcher's contract with McpTool.handler
    // is `(ctx, input, tx: Tx | null)` — for auditMode:"none" tools,
    // tx is null (withTenant is never opened; reads are not audited
    // per prd.md §3.7). A future refactor that accidentally passed
    // something non-null here would break the ping tool's no-DB
    // guarantee.
    let seenTx: unknown = "unset";
    const sensing: McpTool<EchoInput, EchoOutput> = {
      ...echoTool,
      handler: async (_ctx, input, tx) => {
        seenTx = tx;
        return { x: input.x };
      },
    };
    __setRedisForTests({ set: vi.fn(() => "OK") } as never);
    await dispatchTool(ctxBearer(), sensing, { x: 1 }, { auditMode: "none" });
    expect(seenTx).toBeNull();
  });

  it("parses input STRICTLY — extra keys throw before the handler runs", async () => {
    const saw: Array<EchoInput> = [];
    const watching: McpTool<EchoInput, EchoOutput> = {
      ...echoTool,
      handler: async (_ctx, input, _tx) => {
        saw.push(input);
        return { x: input.x };
      },
    };
    await expect(
      dispatchTool(
        ctxBearer(),
        watching,
        { x: 1, extraKey: "junk" },
        { auditMode: "none" },
      ),
    ).rejects.toThrow();
    expect(saw.length).toBe(0);
  });
});
