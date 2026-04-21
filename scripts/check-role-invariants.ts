#!/usr/bin/env tsx
/**
 * Role-channel grep lint (sub-chunk 7.2).
 *
 * Three rules, NO dev-escape-hatch, each throws non-zero on any violation:
 *
 *   R-1: `scopes.role` must not appear in service or router code — role
 *        is a ctx-derived value, NEVER a read from scopes-on-input. The
 *        ONE permitted marker line is `// role-lint: input-scopes-role-ok`
 *        at the S-1 ownerScopeConfirm check in
 *        src/server/services/tokens/create-access-token.ts, which reads
 *        INPUT, not ctx. The lint strips marker-tagged lines before
 *        counting.
 *
 *   R-2: `membership?.role` / `membership.role` must not appear in
 *        routers/ — `deriveRole(ctx)` is the ONLY reader.
 *
 *   R-3: `identity.effectiveRole` is allowed ONLY in
 *        src/server/trpc/ctx-role.ts and
 *        src/server/auth/resolve-request-identity.ts. Any other hit is a
 *        violation (reading the field elsewhere would bypass deriveRole).
 *
 * Comment-line handling: all three rules skip lines whose trimmed form
 * starts with `//` or `*` (JSDoc / inline-comment chatter mentions these
 * identifiers legitimately). That's why the marker must be a TRAILING
 * comment on the live `scopes.role` line, not a block comment above it.
 *
 * See sub-chunk 7.2 plan (B-2 security watchout) for why the marker test
 * is load-bearing: a future edit that deletes the trailing comment fails
 * CI rather than silently passing the marker-stripped lint.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoleInvariantViolation {
  rule: "R-1" | "R-2" | "R-3";
  file: string;
  line: number;
  snippet: string;
}

const ROLE_LINT_MARKER = "role-lint: input-scopes-role-ok";

async function walk(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

async function scanRule(
  rule: "R-1" | "R-2" | "R-3",
  files: string[],
  pattern: RegExp,
  isAllowed: (file: string, line: string) => boolean,
): Promise<RoleInvariantViolation[]> {
  const out: RoleInvariantViolation[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trimStart();
      if (isCommentLine(trimmed)) continue;
      if (!pattern.test(line)) continue;
      if (isAllowed(file, line)) continue;
      out.push({ rule, file, line: i + 1, snippet: line.trim() });
    }
  }
  return out;
}

export interface CheckRoleInvariantsOptions {
  /** Project root. Defaults to the script's `..`. */
  root?: string;
}

export async function checkRoleInvariants(
  opts: CheckRoleInvariantsOptions = {},
): Promise<RoleInvariantViolation[]> {
  const root =
    opts.root ??
    path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const servicesDir = path.join(root, "src", "server", "services");
  const routersDir = path.join(root, "src", "server", "trpc", "routers");
  const serverDir = path.join(root, "src", "server");

  const [servicesFiles, routersFiles, serverFiles] = await Promise.all([
    walk(servicesDir).then((fs) => fs.filter((f) => /\.(ts|tsx)$/.test(f))),
    walk(routersDir).then((fs) => fs.filter((f) => /\.(ts|tsx)$/.test(f))),
    walk(serverDir).then((fs) => fs.filter((f) => /\.(ts|tsx)$/.test(f))),
  ]);

  // R-1: scopes.role in services + routers. Marker-tagged lines are
  // stripped BEFORE pattern match — the marker is a trailing comment on
  // the live line at create-access-token.ts S-1.
  const r1Files = [...servicesFiles, ...routersFiles];
  const r1 = await scanRule(
    "R-1",
    r1Files,
    /\bscopes\.role\b/,
    (_file, line) => line.includes(ROLE_LINT_MARKER),
  );

  // R-2: membership(?.role|.role) in routers.
  const r2 = await scanRule(
    "R-2",
    routersFiles,
    /\bmembership(\?\.role|\.role)\b/,
    () => false,
  );

  // R-3: identity.effectiveRole anywhere under src/server/ except the
  // two blessed files.
  const r3AllowedFiles = new Set(
    [
      path.join(serverDir, "trpc", "ctx-role.ts"),
      path.join(serverDir, "auth", "resolve-request-identity.ts"),
    ].map((p) => path.resolve(p)),
  );
  const r3 = await scanRule(
    "R-3",
    serverFiles,
    /\bidentity\.effectiveRole\b/,
    (file) => r3AllowedFiles.has(path.resolve(file)),
  );

  return [...r1, ...r2, ...r3];
}

export function reportViolations(violations: RoleInvariantViolation[]): void {
  if (violations.length === 0) return;
  console.error(`role-invariants lint: ${violations.length} violation(s)`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}  ${v.snippet}`);
  }
}

// When run as a script (not imported), exit non-zero on any violation.
// `import.meta.url === \`file://\${process.argv[1]}\`` is the Node idiom
// for "am I the entrypoint?" that survives tsx + vitest import.
const isDirectRun =
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isDirectRun) {
  checkRoleInvariants()
    .then((violations) => {
      reportViolations(violations);
      if (violations.length > 0) process.exit(1);
      console.log("role-invariants lint: clean (R-1, R-2, R-3).");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
