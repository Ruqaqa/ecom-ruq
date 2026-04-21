/**
 * `ping` — the minimum viable MCP tool used as a liveness probe.
 *
 * Returns `{ ok: true, tenantId, role }` so Claude Desktop can verify
 * the PAT is accepted AND the tenant/role wiring is correct. Anonymous
 * callers never see this tool in `tools/list` (visibility filter) and
 * `authorize` rejects them with `unauthorized` as defense-in-depth.
 *
 * Audit wiring (Block 7 part B): `ping` registers with `auditMode:"none"`
 * — it's a read, not a mutation. Per prd.md §3.7, reads do NOT audit.
 * The `last_used_at` debounce still fires on every successful dispatch
 * so operators can tell when a PAT is in active use.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";

export const PingInputSchema = z.object({}).strict();
export type PingInput = z.infer<typeof PingInputSchema>;

export const PingOutputSchema = z.object({
  ok: z.literal(true),
  tenantId: z.string().uuid(),
  role: z.enum(["owner", "staff", "support"]),
});
export type PingOutput = z.infer<typeof PingOutputSchema>;

export const pingTool: McpTool<PingInput, PingOutput> = {
  name: "ping",
  description:
    "Liveness probe. Returns { ok, tenantId, role } so the operator can verify the PAT auth path is healthy.",
  inputSchema: PingInputSchema,
  outputSchema: PingOutputSchema,
  isVisibleFor(ctx) {
    return ctx.identity.type === "bearer";
  },
  authorize(ctx) {
    if (ctx.identity.type !== "bearer") {
      // Defense-in-depth. The HTTP route rejects anonymous before we
      // ever reach the dispatcher, but the authorize() hook also
      // rejects — a future surface that dispatched tools outside the
      // HTTP path would still be safe.
      throw new McpError("unauthorized", "bearer token required");
    }
  },
  // `tx` parameter is part of the McpTool contract — passed null for
  // auditMode:"none" tools (reads never open withTenant). Accepted and
  // ignored here.
  async handler(ctx, _input, _tx) {
    if (ctx.identity.type !== "bearer") {
      // Unreachable when invoked via the normal dispatcher (authorize
      // already threw). Keeping the guard as a tripwire for a future
      // dispatcher refactor that might skip authorize.
      throw new McpError("unauthorized", "bearer token required");
    }
    return {
      ok: true as const,
      tenantId: ctx.tenant.id,
      role: ctx.identity.role,
    };
  },
};
