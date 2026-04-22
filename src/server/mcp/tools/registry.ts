/**
 * Tool registry — sub-chunk 7.2.
 *
 * A tool is a Zod-typed, ctx-aware capability exposed to MCP clients.
 * Every tool MUST declare:
 *   - name (unique per registry)
 *   - description (safe-by-construction; human-readable)
 *   - inputSchema (`.strict()` enforces no extra keys)
 *   - outputSchema (`.parse`-d before return so the wire body is
 *     guaranteed-shape)
 *   - isVisibleFor(ctx): whether this tool shows up in `tools/list` for
 *     this caller. Ping is bearer-only; anonymous callers should never
 *     see it exists.
 *   - authorize(ctx): throws `McpError("unauthorized"|"forbidden")` if
 *     the caller can't invoke. Defense-in-depth — the HTTP route also
 *     rejects anonymous up front.
 *   - handler(ctx, input): the service call. Audit wrap is the
 *     dispatcher's responsibility (Block 7 part B), not the tool's.
 *
 * `registerTools(server, ctx)` wires `tools/list` + `tools/call` onto
 * the SDK's low-level `Server`. For each list call, we filter by
 * `isVisibleFor`. For each call, we:
 *   1. authorize
 *   2. `inputSchema.parse(raw)` (strict)
 *   3. handler(ctx, parsedInput)
 *   4. `outputSchema.parse(result)` (shape lock)
 *
 * Authorize-before-parse is deliberate: an unauthorized caller should
 * not learn which input shapes are valid.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import type { McpRequestContext } from "../context";
import { McpError } from "../errors";
import type { Tx } from "@/server/db";
import { dispatchTool, type ToolAuditConfig } from "../audit-adapter";
import { pingTool } from "./ping";
import { createProductTool } from "./create-product";
import { runSqlReadonlyTool } from "./run-sql-readonly";

export interface McpTool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  isVisibleFor(ctx: McpRequestContext): boolean;
  authorize(ctx: McpRequestContext): void;
  /**
   * Tool handler. `tx` is the tenant-scoped transaction opened by the
   * shared `runWithAudit` core when the tool is registered with
   * `auditMode:"mutation"`; it is `null` for non-mutation tools (reads
   * like `ping`, which skip withTenant entirely). Mutation-mode
   * handlers that receive `tx === null` should throw — `dispatchTool`
   * surfaces this as `internal_error` via the McpError exhaustive
   * switch, mirroring tRPC's `narrowMutationContext` invariant.
   */
  handler(ctx: McpRequestContext, input: TInput, tx: Tx | null): Promise<TOutput>;
}

interface RegisteredTool {
  tool: McpTool<unknown, unknown>;
  audit: ToolAuditConfig;
}

// Audit mode is declared at the registry (not on the tool itself) so
// auditing policy is one-grep visible. `ping` is a read → "none"; 7.3's
// `create_product` will register with "mutation".
export const ALL_TOOLS: ReadonlyArray<RegisteredTool> = [
  { tool: pingTool as McpTool<unknown, unknown>, audit: { auditMode: "none" } },
  {
    tool: createProductTool as McpTool<unknown, unknown>,
    audit: { auditMode: "mutation" },
  },
  // 7.4 — `run_sql_readonly` registered but locked off. It's a read
  // (reads don't audit per prd §3.7) so `auditMode:"none"`. Its
  // `authorize` unconditionally refuses with `forbidden`; the shared
  // adapter's Decision-1 widening writes a failure audit row for that
  // refusal regardless of `auditMode`.
  {
    tool: runSqlReadonlyTool as McpTool<unknown, unknown>,
    audit: { auditMode: "none" },
  },
];

// Zod 4 ships a built-in `z.toJSONSchema` that emits JSON Schema 2020-12.
// We strip the top-level `$schema` draft marker since MCP's `tools/list`
// expects a plain Tool object, not a standalone JSON Schema document —
// the draft URI on a nested fragment confuses some downstream clients
// and adds noise on the wire.
function zodToJsonSchema(input: ZodType<unknown>): Record<string, unknown> {
  const compiled = z.toJSONSchema(input) as Record<string, unknown>;
  if ("$schema" in compiled) {
    const { $schema: _omit, ...rest } = compiled;
    return rest;
  }
  return compiled;
}

export function registerTools(
  server: Server,
  ctx: McpRequestContext,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visible = ALL_TOOLS.filter((entry) => entry.tool.isVisibleFor(ctx));
    return {
      tools: visible.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        // Compile the tool's Zod input schema to JSON Schema so MCP
        // clients (Claude Desktop, Claude Code) can introspect parameter
        // shapes. `.strict()` at the tool boundary flows through as
        // `additionalProperties: false` — tool authors MUST keep using
        // `.strict()` on every tool's `inputSchema` so hostile extra
        // keys advertised-away AND runtime-rejected in one place.
        // Authorization runs BEFORE this via `isVisibleFor(ctx)` above;
        // anonymous callers never see the schema (the HTTP route 401s
        // them first).
        inputSchema: zodToJsonSchema(tool.inputSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const entry = ALL_TOOLS.find(({ tool }) => tool.name === name);
    if (!entry) throw new McpError("not_found", `tool not found: ${name}`);
    const out = await dispatchTool(
      ctx,
      entry.tool,
      req.params.arguments ?? {},
      entry.audit,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out as Record<string, unknown>,
    };
  });
}
