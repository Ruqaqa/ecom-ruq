/**
 * `run_sql_readonly` — sub-chunk 7.4 STUB (locked off).
 *
 * Registered but shipped inert. Two independent gate conditions control
 * VISIBILITY; `authorize` is unconditionally hard-locked in 7.4 (a later
 * chunk relaxes it once the read-only-Postgres role + SQL sanitizer +
 * prompt-injection hardening land).
 *
 * Visibility gate (`isVisibleFor`) — BOTH must be true, otherwise the
 * tool is hidden from `tools/list`:
 *   - env `MCP_RUN_SQL_ENABLED === "1"` (read via function, not
 *     module-top-level constant, so the integration test's
 *     `vi.stubEnv` flips take effect); default unset.
 *   - caller's PAT `scopes.tools` array contains the literal string
 *     `"run_sql_readonly"`.
 *
 * `authorize` always throws `McpError("forbidden", …)` in 7.4. Even
 * when the visibility gate is fully open (test case 4 proves this),
 * direct invoke refuses. The forbidden audit row still lands via the
 * shared adapter (Decision 1 — adapter widened to audit `forbidden`
 * refusals regardless of `auditMode`).
 *
 * `handler` is a tripwire — reaching it means `authorize` did not run
 * (impossible under the current dispatcher contract).
 *
 * Audit mode: `"none"` — this is a READ tool even once enabled; reads
 * don't audit on routine success/failure per prd §3.7. The Decision-1
 * widening in the shared adapter handles the special case of auditing
 * `forbidden` refusals regardless of audit mode.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import type { McpRequestContext } from "../context";
import { McpError } from "../errors";

// Minimal input schema — no real input contract yet. A future,
// actually-enabled version will accept `{ sql: string }` plus
// parameterization; we don't pre-commit to that shape here.
export const RunSqlReadonlyInputSchema = z.object({}).strict();
export type RunSqlReadonlyInput = z.infer<typeof RunSqlReadonlyInputSchema>;

// Output shape mirrors where a future enabled version will land — a
// `rows` array of unknown records. Kept as `z.unknown()` per element to
// avoid over-committing to a row shape before the tool is actually
// enabled. The handler never returns anything (tripwire throws), so
// this schema is really a contract placeholder for future implementors.
export const RunSqlReadonlyOutputSchema = z.object({
  rows: z.array(z.unknown()),
});
export type RunSqlReadonlyOutput = z.infer<typeof RunSqlReadonlyOutputSchema>;

function gateOpen(ctx: McpRequestContext): boolean {
  if (process.env.MCP_RUN_SQL_ENABLED !== "1") return false;
  if (ctx.identity.type !== "bearer") return false;
  const scopes = ctx.identity.scopes as
    | { tools?: readonly unknown[] }
    | null
    | undefined;
  const tools = scopes?.tools;
  return Array.isArray(tools) && tools.includes("run_sql_readonly");
}

export const runSqlReadonlyTool: McpTool<
  RunSqlReadonlyInput,
  RunSqlReadonlyOutput
> = {
  name: "run_sql_readonly",
  description:
    "Run a read-only SQL query against the caller's tenant data. Gated; currently unavailable.",
  inputSchema: RunSqlReadonlyInputSchema,
  outputSchema: RunSqlReadonlyOutputSchema,
  isVisibleFor(ctx) {
    return gateOpen(ctx);
  },
  authorize(_ctx) {
    // Hard-locked in 7.4. Even when the visibility gate is open, the
    // tool refuses every invoke. Relaxing this is a later chunk.
    throw new McpError("forbidden", "run_sql_readonly not available");
  },
  async handler(_ctx, _input, _tx) {
    // Unreachable past the unconditional `authorize` throw above. If we
    // ever get here, the dispatcher contract has been violated.
    throw new McpError(
      "internal_error",
      "run_sql_readonly handler reached — authorize contract violated",
    );
  },
};
