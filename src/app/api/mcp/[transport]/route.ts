/**
 * MCP HTTP handler — sub-chunk 7.2.
 *
 * Single catch-all POST route at /api/mcp/[transport]. Next.js captures
 * the trailing segment (streamable-http today; more later if the SDK adds
 * transport modes). We delegate to the SDK's
 * WebStandardStreamableHTTPServerTransport after building a per-request
 * `McpRequestContext`.
 *
 * Order of operations (load-bearing):
 *   1. body-cap: 64KB enforced BEFORE any parse. Zod inside the SDK's
 *      JSON-RPC decoder doesn't fire until the top-level envelope
 *      parses, and a multi-MB malformed body would stretch the MCP
 *      request lifecycle / memory window. Mirrors the tRPC catch-all's
 *      handler; the constant is declared LOCALLY here (do NOT import
 *      from tRPC — 3 similar lines beat coupling). Security watchout
 *      B-1: verify JSON.parse is NEVER called on the 413 path (see
 *      tests/unit/mcp/route-body-cap.test.ts).
 *   2. JSON-envelope parse. On failure, return JSON-RPC parse error
 *      (-32700).
 *   3. createMcpContext → resolveTenant → resolveMcpIdentity.
 *   4. Anonymous reject BEFORE any SDK / audit dispatch. This is the
 *      security invariant #1 in the 7.2 plan: an anonymous MCP request
 *      cannot reach `writeAuditInOwnTx` / `runWithAudit`.
 *   5. Construct Server + registerTools + WebStandardTransport.
 *   6. transport.handleRequest(req, { parsedBody }).
 *
 * All responses carry `Cache-Control: no-store`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpContext,
  McpUnknownHostError,
} from "@/server/mcp/context";
import { registerTools } from "@/server/mcp/tools/registry";
import { mcpParseJson } from "@/server/mcp/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MCP_REQUEST_BODY_BYTES = 64 * 1024;

const NO_STORE: Record<string, string> = {
  "cache-control": "no-store",
  "content-type": "application/json",
};

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: NO_STORE },
  );
}

// JSON-RPC error codes:
//   -32700  parse error
//   -32600  invalid request (used here for payload too large)
//   -32003  unauthorized / forbidden  (matches errors.ts mapping)
//   -32004  not found (unknown host)
//   -32603  internal error

async function handlePost(req: Request): Promise<Response> {
  // Step 1 — body cap. Content-Length is advisory; read the text and
  // measure. This is the ONLY read-to-text site in the MCP path;
  // handleRequest receives parsedBody and does not re-read the stream.
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_MCP_REQUEST_BODY_BYTES) {
    return jsonRpcError(413, -32600, "Request body too large");
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_REQUEST_BODY_BYTES) {
    return jsonRpcError(413, -32600, "Request body too large");
  }

  // Step 2 — JSON-envelope parse. `mcpParseJson` is the test seam; the
  // body-cap test asserts it is NEVER called on the 413 path above.
  let parsed: unknown;
  try {
    parsed = mcpParseJson(raw);
  } catch {
    return jsonRpcError(400, -32700, "Parse error");
  }

  // Step 3 — tenant + identity. Unknown tenant host → 404 JSON-RPC
  // envelope; anonymous identity → 401 JSON-RPC envelope.
  let ctx;
  try {
    ctx = await createMcpContext({ req });
  } catch (err) {
    if (err instanceof McpUnknownHostError) {
      return jsonRpcError(404, -32004, "Unknown tenant host");
    }
    return jsonRpcError(500, -32603, "Internal error");
  }

  if (ctx.identity.type !== "bearer") {
    return jsonRpcError(401, -32003, "Unauthorized");
  }

  // Step 4 — spin up Server + transport for this request. Stateless
  // mode (no sessionIdGenerator) — MCP ctx is minted per request, so
  // there is no server-side state worth carrying between calls.
  const server = new Server(
    { name: "ecom-ruq-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);
  // Stateless mode — omit sessionIdGenerator. Each MCP request mints a
  // fresh ctx so server-side session state is redundant.
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  const response = await transport.handleRequest(req, { parsedBody: parsed });
  // Re-wrap to force our no-store cache header. The SDK may set its
  // own headers; we layer ours on top.
  const merged = new Headers(response.headers);
  merged.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export { handlePost as POST };
