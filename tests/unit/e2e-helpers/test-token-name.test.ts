/**
 * Contract test for the Playwright access-token naming helper.
 *
 * The global-setup sweep (`DELETE ... WHERE name LIKE 'TTT-%'`) depends
 * on `testTokenName` emitting exactly that prefix. If this test fails,
 * the cleanup stops catching real test-mint rows and the dev store
 * accumulates junk again.
 */
import { describe, it, expect } from "vitest";
import {
  TEST_TOKEN_PREFIX,
  testTokenName,
} from "../../e2e/helpers/test-token-name";

describe("testTokenName", () => {
  it("exports TTT- as the shared prefix", () => {
    expect(TEST_TOKEN_PREFIX).toBe("TTT-");
  });

  it("always starts with the shared prefix", () => {
    const name = testTokenName("whatever");
    expect(name.startsWith(TEST_TOKEN_PREFIX)).toBe(true);
  });

  it("incorporates the caller's tag so debugging a failure is possible", () => {
    const name = testTokenName("my-scenario-tag");
    expect(name).toMatch(/^TTT-my-scenario-tag-\d+-\d+$/);
  });

  it("emits a new name on each call so parallel mints do not collide", () => {
    const a = testTokenName("dup");
    const b = testTokenName("dup");
    expect(a).not.toBe(b);
  });
});
