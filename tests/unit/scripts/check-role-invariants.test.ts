/**
 * Tests for `scripts/check-role-invariants.ts` — the R-1/R-2/R-3 role-
 * channel grep lint. Each fixture is a tiny throwaway project rooted in
 * `os.tmpdir()/role-invariants-fixture-<rand>` with the exact source
 * layout the real lint expects (src/server/services/, routers/, auth/,
 * trpc/ctx-role.ts, trpc/resolve-request-identity.ts).
 *
 * Coverage (sub-chunk 7.2 plan, Block 2 Part C):
 *   1. clean fixture — zero violations.
 *   2. R-1 violation — scopes.role in service code without the marker.
 *   3. R-2 violation — membership?.role in a router file.
 *   4. R-3 violation — identity.effectiveRole outside the two blessed files.
 *
 * Plus one real-tree assertion (B-2 security watchout):
 *   - src/server/services/tokens/create-access-token.ts still carries
 *     `role-lint: input-scopes-role-ok` on a live `scopes.role` line
 *     in the REAL codebase, so deletion of the marker fails CI.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkRoleInvariants } from "../../../scripts/check-role-invariants";

interface Fixture {
  root: string;
  cleanup(): Promise<void>;
}

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-inv-fixture-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const BLESSED_CTX_ROLE = `
import type { TRPCContext } from "./context";
export function deriveRole(ctx: Pick<TRPCContext, "identity" | "membership">) {
  if (ctx.identity.type === "bearer") return ctx.identity.effectiveRole;
  return "customer";
}
`;

const BLESSED_RESOLVE = `
export type RequestIdentity =
  | { type: "bearer"; userId: string; tokenId: string; effectiveRole: string };
`;

describe("check-role-invariants fixture scanner", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fixture.cleanup();
  });

  it("1. clean fixture — no violations", async () => {
    fixture = await makeFixture({
      "src/server/trpc/ctx-role.ts": BLESSED_CTX_ROLE,
      "src/server/auth/resolve-request-identity.ts": BLESSED_RESOLVE,
      "src/server/services/products/create-product.ts": `
        import { deriveRole } from "../../trpc/ctx-role";
        export const createProduct = () => deriveRole;
      `,
      "src/server/trpc/routers/products.ts": `
        import { deriveRole } from "../ctx-role";
        export const productsRouter = () => deriveRole;
      `,
    });
    const violations = await checkRoleInvariants({ root: fixture.root });
    expect(violations).toEqual([]);
  });

  it("2. R-1 violation — scopes.role in a service with no marker", async () => {
    fixture = await makeFixture({
      "src/server/trpc/ctx-role.ts": BLESSED_CTX_ROLE,
      "src/server/auth/resolve-request-identity.ts": BLESSED_RESOLVE,
      "src/server/services/tokens/evil.ts": `
        export function evil(input: { scopes: { role: string } }) {
          if (input.scopes.role === "owner") return true;
          return false;
        }
      `,
    });
    const violations = await checkRoleInvariants({ root: fixture.root });
    expect(violations.length).toBe(1);
    const v = violations[0]!;
    expect(v.rule).toBe("R-1");
    expect(v.file).toContain("src/server/services/tokens/evil.ts");
    expect(v.line).toBeGreaterThan(0);
    expect(v.snippet).toMatch(/scopes\.role/);
  });

  it("2b. R-1 allow — scopes.role WITH the marker is stripped before counting", async () => {
    fixture = await makeFixture({
      "src/server/trpc/ctx-role.ts": BLESSED_CTX_ROLE,
      "src/server/auth/resolve-request-identity.ts": BLESSED_RESOLVE,
      "src/server/services/tokens/ok.ts": `
        export function ok(input: { scopes: { role: string } }) {
          if (input.scopes.role === "owner") return true; // role-lint: input-scopes-role-ok
          return false;
        }
      `,
    });
    const violations = await checkRoleInvariants({ root: fixture.root });
    expect(violations).toEqual([]);
  });

  it("3. R-2 violation — membership?.role / membership.role in a router file", async () => {
    fixture = await makeFixture({
      "src/server/trpc/ctx-role.ts": BLESSED_CTX_ROLE,
      "src/server/auth/resolve-request-identity.ts": BLESSED_RESOLVE,
      "src/server/trpc/routers/leaky.ts": `
        export function leaky(ctx: { membership: { role: string } | null }) {
          return ctx.membership?.role ?? "none";
        }
      `,
    });
    const violations = await checkRoleInvariants({ root: fixture.root });
    expect(violations.length).toBe(1);
    const v = violations[0]!;
    expect(v.rule).toBe("R-2");
    expect(v.file).toContain("src/server/trpc/routers/leaky.ts");
    expect(v.snippet).toMatch(/membership\?\.role/);
  });

  it("4. R-3 violation — identity.effectiveRole outside the blessed files", async () => {
    fixture = await makeFixture({
      "src/server/trpc/ctx-role.ts": BLESSED_CTX_ROLE,
      "src/server/auth/resolve-request-identity.ts": BLESSED_RESOLVE,
      "src/server/services/bad/reader.ts": `
        export function bad(ctx: { identity: { effectiveRole: string } }) {
          return ctx.identity.effectiveRole;
        }
      `,
    });
    const violations = await checkRoleInvariants({ root: fixture.root });
    expect(violations.length).toBe(1);
    const v = violations[0]!;
    expect(v.rule).toBe("R-3");
    expect(v.file).toContain("src/server/services/bad/reader.ts");
    expect(v.snippet).toMatch(/identity\.effectiveRole/);
  });
});

describe("B-2 security watchout — marker stays on the scopes.role site", () => {
  it("src/server/services/tokens/create-access-token.ts still carries the role-lint marker", async () => {
    // If a future edit deletes the trailing comment, this test fails
    // EVEN IF the R-1 lint passes (because the marker strips its own line).
    // That double-gate is B-2: the marker comment is load-bearing for CI.
    const src = await readFile(
      path.resolve("src/server/services/tokens/create-access-token.ts"),
      "utf8",
    );
    const markerLines = src
      .split("\n")
      .filter((l) => l.includes("role-lint: input-scopes-role-ok"));
    expect(markerLines.length).toBe(1);
    // AND the same line must reference `scopes.role` — otherwise the
    // marker drifted off the real code during a refactor.
    expect(markerLines[0]).toMatch(/scopes\.role/);
  });
});
