/**
 * Shared Playwright helper: every access token minted by the E2E suite
 * must be named through this function so the global-setup cleanup sweep
 * (`DELETE ... WHERE name LIKE 'TTT-%'`) can reliably remove it.
 *
 * Manually-created tokens (e.g. the one powering Claude Desktop) must NOT
 * use this prefix; the cleanup sweep would delete them between runs.
 *
 * If this prefix ever changes, update three places atomically:
 *   - this file,
 *   - `tests/e2e/global-setup.ts` (cleanup WHERE clause),
 *   - `scripts/check-e2e-coverage.ts` (prefix-discipline lint).
 */
export const TEST_TOKEN_PREFIX = "TTT-";

export function testTokenName(tag: string): string {
  return `${TEST_TOKEN_PREFIX}${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
