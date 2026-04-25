/**
 * MCP per-request context factory — sub-chunk 7.2.
 *
 * Reads Host → resolves Tenant → resolves McpIdentity → mints a
 * correlationId. Errors:
 *   - Unknown host → throws. The HTTP route catches and returns a JSON-
 *     RPC transport-layer error envelope.
 *
 * Anonymous identity is NOT rejected here. The HTTP route rejects
 * anonymous at the edge (block 6) so tool dispatch code never sees an
 * anonymous ctx. That keeps the anonymous→audit-log path impossible
 * by construction (security invariant #1 in the 7.2 plan).
 *
 * CRITICAL: MCP land does NOT use `deriveRole` or tRPC's `TRPCContext`.
 * Role lives directly on `ctx.identity.role` (bearer variant). See
 * sub-chunk 7.2 plan Block 4: "Role is never read via deriveRole in MCP
 * land." The bearer short-circuit invariant (R-3 grep lint) forbids
 * reading `identity.effectiveRole` outside the two blessed tRPC files,
 * so we rename the field to `role` on the MCP seam.
 */
import { randomUUID } from "node:crypto";
import { resolveTenant, type Tenant } from "@/server/tenant";
import { resolveMcpIdentity, type McpIdentity } from "./identity";

/**
 * Mutable holder a tool handler can populate when its wire-return shape
 * and its audit shape diverge — e.g. update_product returns the
 * Tier-B-stripped wire shape but wants the full pre/post row recorded
 * in the audit chain. dispatchTool reads these AFTER the handler
 * returns. Tools that don't set them fall back to using the parsed
 * wire output as both `result` and `after` (no `before`).
 */
export interface McpAuditOverride {
  before?: unknown;
  after?: unknown;
}

export interface McpRequestContext {
  tenant: Tenant;
  identity: McpIdentity;
  correlationId: string;
  auditOverride: McpAuditOverride;
}

function hostFromRequest(req: Request): string | null {
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

export class McpUnknownHostError extends Error {
  constructor(public readonly host: string | null) {
    super(`unknown tenant host: ${host ?? "<missing>"}`);
    this.name = "McpUnknownHostError";
  }
}

export async function createMcpContext({
  req,
}: {
  req: Request;
}): Promise<McpRequestContext> {
  const host = hostFromRequest(req);
  const tenant = await resolveTenant(host);
  if (!tenant) throw new McpUnknownHostError(host);

  const identity = await resolveMcpIdentity(req.headers, tenant);
  return {
    tenant,
    identity,
    correlationId: randomUUID(),
    auditOverride: {},
  };
}
