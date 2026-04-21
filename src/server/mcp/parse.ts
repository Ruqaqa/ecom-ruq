/**
 * `mcpParseJson(raw)` — the single JSON.parse seam used by the MCP HTTP
 * route. Extracted so tests can spy on it and assert that the body-cap
 * path returns 413 WITHOUT ever invoking JSON.parse (security watchout
 * B-1 from the 7.2 plan).
 *
 * We intentionally do NOT spy on global `JSON.parse` in tests — that
 * pollutes unrelated code paths. The helper + exported parseJson swap
 * give us a scoped seam.
 */
export type ParseJson = (raw: string) => unknown;

let override: ParseJson | null = null;

/**
 * Test-only seam. Pass a function to spy/replace parse; pass null to
 * restore the default `JSON.parse` behavior.
 */
export function __setParseJsonForTests(fn: ParseJson | null): void {
  override = fn;
}

export function mcpParseJson(raw: string): unknown {
  return (override ?? JSON.parse)(raw);
}
