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

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "src", "app");
const TRPC_DIR = path.join(ROOT, "src", "server", "trpc");
const E2E_DIR = path.join(ROOT, "tests", "e2e");

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
  const files = (await walk(TRPC_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));
  const mutations = new Set<string>();
  const pattern = /(\w+)\s*:\s*\w+\.(?:mutation|procedure\.mutation)/g;
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(pattern)) {
      if (m[1]) mutations.add(m[1]);
    }
  }
  return [...mutations].sort();
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

async function main() {
  const appDirExists = await stat(APP_DIR).then(() => true).catch(() => false);
  if (!appDirExists) {
    console.error(`Missing ${APP_DIR}`);
    process.exit(1);
  }

  const [routes, mutations, haystack] = await Promise.all([
    collectRoutes(),
    collectTrpcMutations(),
    loadAllE2ESources(),
  ]);

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
  if (uncoveredMutations.length) {
    console.error("\ntRPC mutations without a referencing Playwright test:");
    for (const m of uncoveredMutations) console.error(`  ${m}`);
  }
  console.error("\nAdd a Playwright test that exercises each missing path (CLAUDE.md §1).");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
