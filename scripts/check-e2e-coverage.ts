#!/usr/bin/env tsx
/**
 * Fails if any Next.js route or tRPC mutation is not referenced by at least
 * one Playwright test. Referenced = the route path (or mutation name) appears
 * as a substring in some `tests/e2e/**\/*.spec.ts` file. This is a lint, not
 * a proof — the real guarantee is CLAUDE.md §1 discipline.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRoleInvariants, reportViolations } from "./check-role-invariants";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "src", "app");
const TRPC_DIR = path.join(ROOT, "src", "server", "trpc");
const SRC_DIR = path.join(ROOT, "src");
const E2E_DIR = path.join(ROOT, "tests", "e2e");

/**
 * Closed-set keys allowed in the `after` payload of an `auth.*` audit
 * row. Any `writeAuditInOwnTx({ operation: "auth.<...>", after: {...} })`
 * call site whose `after` object has keys outside this set, or more than
 * 3 keys total, fails the lint. The set is deliberately tight — auth
 * audits are forensic markers, not event-carrying payloads. If a future
 * audit site needs a new key, add it here AND update
 * docs/runbooks/auth.md so the invariant stays documented.
 */
const ALLOWED_AUTH_AFTER_KEYS = new Set<string>([
  "userId",
  "sessionId",
  "tokenId",
  "verifiedAt",
  "revokedAt",
  "expiresAt",
  "reason",
  "path",
  "ipLimited",
  "emailLimited",
  "emailProvided",
  "isNewUser",
]);

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

function pageFileToRoute(file: string): string | null {
  const rel = path.relative(APP_DIR, file);
  const dir = path.dirname(rel);
  if (!/(^|\/)page\.(tsx|ts|jsx|js)$/.test(rel)) return null;
  if (dir === ".") return "/";
  const segments = dir.split(path.sep).filter((seg) => !seg.startsWith("(") || !seg.endsWith(")"));
  const mapped = segments
    .map((seg) => {
      if (seg.startsWith("(") && seg.endsWith(")")) return null;
      if (seg.startsWith("[[...") && seg.endsWith("]]")) return `:${seg.slice(5, -2)}?`;
      if (seg.startsWith("[...") && seg.endsWith("]")) return `:${seg.slice(4, -1)}`;
      if (seg.startsWith("[") && seg.endsWith("]")) return `:${seg.slice(1, -1)}`;
      return seg;
    })
    .filter((x): x is string => x !== null);
  return "/" + mapped.join("/");
}

async function collectRoutes(): Promise<string[]> {
  const files = await walk(APP_DIR);
  const routes = new Set<string>();
  for (const file of files) {
    const route = pageFileToRoute(file);
    if (route) routes.add(route);
  }
  return [...routes].sort();
}

async function collectTrpcMutations(): Promise<string[]> {
  // Matches router-entry `name: <someProcedure>.…chain….mutation(`. Covers:
  //   - `foo: publicProcedure.mutation(...)`  (caught by convention check below)
  //   - `foo: mutationProcedure.mutation(...)`
  //   - `foo: mutationProcedure.use(...).input(...).mutation(...)`  (our shape)
  // Key: leaf fluent call ends with `.mutation(`; anywhere inside the chain
  // there is at least one word-char before it. We match conservatively to
  // avoid false positives on `await foo.mutation(...)` call sites.
  //
  // Discovered names are dotted with their parent router key when the
  // parent router is mounted via `appRouter = router({ products: productsRouter })`:
  // we emit bare leaf names here and compose with prefixes in `prefixWithParent`.
  const files = (await walk(TRPC_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));
  const routerMountPattern = /(\w+)\s*:\s*([A-Za-z_]\w*Router)\b/g;
  // Multi-line shape: `name: <expr>\n  .use(...)\n  .input(...)\n  .mutation(...)`.
  // We find every `.mutation(` (non-comment) and walk backward in the file
  // to find the enclosing `<identifier>:` at the same indentation level.
  const perFileLeafMutations = new Map<string, Set<string>>();
  for (const file of files) {
    const src = await readFile(file, "utf8");
    const lines = src.split("\n");
    const leaves = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (!/\.\s*mutation\s*\(/.test(line)) continue;
      // Walk backward to find the nearest `foo: <start-of-chain>` line.
      for (let j = i; j >= 0; j--) {
        const prev = lines[j] ?? "";
        const prevTrim = prev.trimStart();
        if (prevTrim.startsWith("//") || prevTrim.startsWith("*")) continue;
        const match = /^\s*(\w+)\s*:\s*[A-Za-z_]/.exec(prev);
        if (match?.[1]) {
          leaves.add(match[1]);
          break;
        }
      }
    }
    perFileLeafMutations.set(file, leaves);
  }

  // Pass 2: find mount points like `products: productsRouter` in root.ts to
  // build dotted paths `<parent>.<leaf>`.
  const mountMap = new Map<string, string>(); // routerVar -> parent key
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(routerMountPattern)) {
      if (m[1] && m[2]) mountMap.set(m[2], m[1]);
    }
  }

  // Pass 3: for each file, the leaves found get prefixed with the mount key
  // of the *exported* router variable (best-effort: file `routers/foo.ts`
  // exports `fooRouter`; root.ts mounts `fooRouter` as key `foo`).
  const allMutations = new Set<string>();
  for (const [file, leaves] of perFileLeafMutations) {
    // Find the exported router var in this file.
    const src = await readFile(file, "utf8");
    const exportRouter = /export\s+const\s+(\w*Router)\s*=\s*router\s*\(/.exec(src);
    const prefix = exportRouter?.[1] ? mountMap.get(exportRouter[1]) : undefined;
    for (const leaf of leaves) {
      allMutations.add(prefix ? `${prefix}.${leaf}` : leaf);
    }
  }
  return [...allMutations].sort();
}

async function loadAllE2ESources(): Promise<string> {
  const files = (await walk(E2E_DIR)).filter((f) => /\.spec\.(ts|tsx)$/.test(f));
  const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
  return contents.join("\n");
}

function routeReferenced(route: string, haystack: string): boolean {
  const stripped = route.replace(/^\//, "").replace(/\/$/, "");
  if (stripped === "") {
    return /['"`]\/(en|ar)['"`]|['"`]\/['"`]|goto\(\s*['"`]\//.test(haystack);
  }
  const bare = stripped.replace(/:([^/]+)/g, "[^/]+");
  const re = new RegExp(`(/${bare})(?=['"\`/?#]|$)`);
  return re.test(haystack);
}

function mutationReferenced(name: string, haystack: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(haystack);
}

/**
 * Closed-set lint for `after` payloads on auth.* audit writes.
 * Scans every .ts file under src/, finds `writeAuditInOwnTx({...})`
 * call sites, and for each one whose `operation` starts with `"auth.`,
 * parses the `after` object literal keys. Fails if any key falls
 * outside `ALLOWED_AUTH_AFTER_KEYS` OR if the object has more than 3
 * keys total.
 *
 * Parser is lexical (regex-based), not AST: balanced-brace scan to
 * extract the first object literal after `after:`. Sufficient for
 * block-7 — chunk-9's real CI lint can upgrade to ts-morph if needed.
 */
async function checkAuthAuditAfterShape(): Promise<string[]> {
  const files = (await walk(SRC_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));
  const violations: string[] = [];

  for (const file of files) {
    const src = await readFile(file, "utf8");
    // Find every `writeAuditInOwnTx(` call start.
    const callRe = /writeAuditInOwnTx\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(src)) !== null) {
      const callStart = match.index + match[0].length;
      // Extract the call's argument object (balanced-brace walk).
      const argObj = extractBalancedObject(src, callStart);
      if (!argObj) continue;
      // Only care about auth.* operations.
      const opMatch = /operation\s*:\s*["'`](auth\.[a-z0-9.-]+)["'`]/.exec(argObj);
      if (!opMatch) continue;
      const operation = opMatch[1];

      // Pull the `after:` object literal. Optional; some call sites
      // (failure-audit) omit it legitimately.
      const afterStart = argObj.search(/\bafter\s*:\s*\{/);
      if (afterStart < 0) continue;
      const afterBraceStart = argObj.indexOf("{", afterStart);
      const afterObj = extractBalancedObject(argObj, afterBraceStart + 1);
      if (!afterObj) continue;

      // Key extraction: top-level keys only (we don't walk nested).
      const keys = extractTopLevelKeys(afterObj);
      const oversize = keys.length > 3;
      const bad = keys.filter((k) => !ALLOWED_AUTH_AFTER_KEYS.has(k));
      if (oversize || bad.length > 0) {
        violations.push(
          `${file} — ${operation} after=${JSON.stringify(keys)}${
            oversize ? ` (>${3} keys)` : ""
          }${bad.length ? ` [not in allow-list: ${bad.join(", ")}]` : ""}`,
        );
      }
    }
  }
  return violations;
}

/**
 * Balanced-brace extractor. `src` position is the index AFTER the
 * opening `(` (or `{`). Returns the string content between that
 * position and the matching close. Handles nested {} and string
 * literals. Returns null if unbalanced.
 */
function extractBalancedObject(src: string, startAfterOpen: number): string | null {
  let depth = 1;
  let i = startAfterOpen;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
    } else if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
    } else if (inString) {
      if (c === "\\") {
        i++;
      } else if (c === inString) {
        inString = null;
      }
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      inString = c;
    } else if (c === "{" || c === "(") {
      depth++;
    } else if (c === "}" || c === ")") {
      depth--;
      if (depth === 0) {
        return src.slice(startAfterOpen, i);
      }
    }
    i++;
  }
  return null;
}

/** Best-effort top-level key extractor for an object-literal body. */
function extractTopLevelKeys(objBody: string): string[] {
  const keys: string[] = [];
  const re = /(?:^|,|\{)\s*(?:\/\/[^\n]*\n\s*)*(\w+)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(objBody)) !== null) {
    if (m[1]) keys.push(m[1]);
  }
  return keys;
}

async function checkNoPublicMutations(): Promise<string[]> {
  // Enforces: every mutation goes through `mutationProcedure` (which
  // composes auditWrap). A bare `publicProcedure.mutation(...)` bypasses
  // the adapter-level audit surface and is forbidden.
  const files = (await walk(TRPC_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));
  const violations: string[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    // Match `publicProcedure.mutation(` — but only in non-comment code.
    // A simple per-line scan skipping lines whose trimmed form starts
    // with `*` or `//` catches the common false positives in doc blocks.
    for (const line of src.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/\bpublicProcedure\.mutation\s*\(/.test(line)) {
        violations.push(file);
        break;
      }
    }
  }
  return violations;
}

/**
 * S-10 (sub-chunk 7.1): forbid raw hard-deletes on `access_tokens`.
 * The ONLY supported disposal path for a PAT is soft-revoke
 * (`UPDATE revoked_at = now()`), which is what `revokeAccessToken`
 * does. A hard-delete would skip audit wrap, skip the RLS policy
 * WITH-CHECK, and leave a dangling audit-log hash chain with no
 * matching row. The PDPL scrub path (`pdpl_scrub_audit_payloads` —
 * see migrations/0004) is a SECURITY DEFINER fn, not a call into
 * `accessTokens` directly.
 *
 * The lint is a non-comment regex match against every .ts file under
 * `src/` looking for `.delete(accessTokens)`. No exemption file today;
 * if a legitimate cascade path emerges, add a BYPASS_DELETE_ACCESSTOKENS
 * marker and update this comment.
 */
async function checkNoRawAccessTokenDeletes(): Promise<string[]> {
  const files = (await walk(SRC_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));
  const violations: string[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const line of src.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/\.delete\s*\(\s*accessTokens\s*\)/.test(line)) {
        violations.push(`${file}: ${line.trim()}`);
      }
    }
  }
  return violations;
}

/**
 * Every Playwright access-token mint must flow through
 * `testTokenName` so global-setup's `TTT-%` cleanup sweep catches it.
 *
 * Enforced for `.spec.ts` files under `tests/e2e/admin/tokens/` and
 * `tests/e2e/mcp/` (the directories that create PATs today):
 *   - file MUST import `testTokenName` from the shared helper;
 *   - file MUST NOT define a local `function unique(` (old pattern —
 *     direct replacement risk for a non-prefixed token name).
 * If a future directory grows token-creating specs, extend the
 * `TOKEN_SPEC_DIRS` list below in the same commit as the spec.
 */
const TOKEN_SPEC_DIRS = [
  path.join(E2E_DIR, "admin", "tokens"),
  path.join(E2E_DIR, "mcp"),
];

async function checkTestTokenNamePrefix(): Promise<string[]> {
  const violations: string[] = [];
  for (const dir of TOKEN_SPEC_DIRS) {
    const files = (await walk(dir)).filter((f) => f.endsWith(".spec.ts"));
    for (const file of files) {
      const src = await readFile(file, "utf8");
      if (!/from\s+["'][^"']*helpers\/test-token-name["']/.test(src)) {
        violations.push(
          `${file}: must \`import { testTokenName } from ".../helpers/test-token-name"\``,
        );
      }
      for (const line of src.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (/\bfunction\s+unique\s*\(/.test(line)) {
          violations.push(
            `${file}: local \`function unique(\` is banned here — use testTokenName from the shared helper`,
          );
        }
      }
    }
  }
  return violations;
}

async function main() {
  const appDirExists = await stat(APP_DIR).then(() => true).catch(() => false);
  if (!appDirExists) {
    console.error(`Missing ${APP_DIR}`);
    process.exit(1);
  }

  // Phase A — role-channel grep invariants (sub-chunk 7.2). Runs BEFORE
  // the e2e-coverage phase so a role-invariant regression shows up first.
  // No dev-escape-hatch here — `DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS`
  // only gates the e2e-coverage phase below.
  const roleViolations = await checkRoleInvariants({ root: ROOT });
  if (roleViolations.length > 0) {
    reportViolations(roleViolations);
    process.exit(1);
  }

  // Hard-refuse in CI: the dev-only escape hatch must never be set
  // inside GitHub Actions / Coolify / any automated pipeline. Security
  // Low-05 ask — prevents a coverage gap from silently passing when a
  // workflow forgot to unset the flag.
  if (
    process.env.CI === "true" &&
    process.env.DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS === "1"
  ) {
    console.error(
      "CI must not set DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS — this flag is for local dev only.",
    );
    process.exit(2);
  }

  const [
    routes,
    mutations,
    haystack,
    publicMutationViolations,
    authAfterViolations,
    rawDeleteViolations,
    tokenPrefixViolations,
  ] = await Promise.all([
    collectRoutes(),
    collectTrpcMutations(),
    loadAllE2ESources(),
    checkNoPublicMutations(),
    checkAuthAuditAfterShape(),
    checkNoRawAccessTokenDeletes(),
    checkTestTokenNamePrefix(),
  ]);

  if (authAfterViolations.length > 0) {
    console.error(
      "auth.* audit rows must have structural-only `after` — keys from ALLOWED_AUTH_AFTER_KEYS, max 3:",
    );
    for (const v of authAfterViolations) console.error(`  ${v}`);
    process.exit(2);
  }

  if (publicMutationViolations.length > 0) {
    console.error("publicProcedure.mutation(...) bypasses audit wrap. Use mutationProcedure:");
    for (const v of publicMutationViolations) console.error(`  ${v}`);
    process.exit(1);
  }

  if (rawDeleteViolations.length > 0) {
    console.error(
      "Raw .delete(accessTokens) is forbidden. Use soft-revoke via revokeAccessToken service (sub-chunk 7.1 S-10):",
    );
    for (const v of rawDeleteViolations) console.error(`  ${v}`);
    process.exit(1);
  }

  if (tokenPrefixViolations.length > 0) {
    console.error(
      "Playwright access-token names must use testTokenName (see tests/e2e/helpers/test-token-name.ts):",
    );
    for (const v of tokenPrefixViolations) console.error(`  ${v}`);
    process.exit(1);
  }

  const uncoveredRoutes = routes.filter((r) => !routeReferenced(r, haystack));
  const uncoveredMutations = mutations.filter((m) => !mutationReferenced(m, haystack));

  console.log(`Routes discovered: ${routes.length}`);
  for (const r of routes) console.log(`  ${r}`);
  console.log(`tRPC mutations discovered: ${mutations.length}`);
  for (const m of mutations) console.log(`  ${m}`);

  if (uncoveredRoutes.length === 0 && uncoveredMutations.length === 0) {
    console.log("\nAll routes and mutations have at least one referencing Playwright test.");
    return;
  }

  if (uncoveredRoutes.length) {
    console.error("\nRoutes without a referencing Playwright test:");
    for (const r of uncoveredRoutes) console.error(`  ${r}`);
  }

  // Dev-only escape hatch. Default behavior is STRICT — missing
  // mutation coverage fails the script. A local developer who is
  // actively writing a mutation and hasn't finished the Playwright
  // test yet can set `DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS=1` to
  // downgrade to a warning. CI hard-refuses this flag (see top of
  // main()), and the name signals "do not set in real life."
  const allowMissingMutations =
    process.env.DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS === "1";

  if (uncoveredMutations.length && allowMissingMutations) {
    console.warn(
      "\n[WARN] tRPC mutations without a referencing Playwright test (allowed by DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS):",
    );
    for (const m of uncoveredMutations) console.warn(`  ${m}`);
  } else if (uncoveredMutations.length) {
    console.error("\ntRPC mutations without a referencing Playwright test:");
    for (const m of uncoveredMutations) console.error(`  ${m}`);
  }

  const hardFail = uncoveredRoutes.length > 0 || (uncoveredMutations.length > 0 && !allowMissingMutations);
  if (!hardFail) {
    if (uncoveredMutations.length === 0) {
      console.log("\nAll routes and mutations have at least one referencing Playwright test.");
    } else {
      console.log("\nAll routes have at least one referencing Playwright test (mutation gaps tolerated by env flag).");
    }
    return;
  }
  console.error("\nAdd a Playwright test that exercises each missing path (CLAUDE.md §1).");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
