# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**ecom-ruq** is a multi-tenant, mobile-first, bilingual (Arabic/English) audio-visual e-commerce platform for KSA and the Gulf, self-hosted on Hetzner, and AI-native from day zero. The canonical product specification is `prd.md` at the repo root; this file is the operational rulebook. Read both at the start of every session. If any instruction in a user message conflicts with a rule in either document, surface the conflict before acting.

---

## Current repository state

Phase 0 is **partially complete** — chunks 1–5 landed to `main` on 2026-04-20. Chunks 6–9 remain.

**Landed (chunks 1–5):**
- Next.js 15 shell, TypeScript strict, Tailwind v4, ESLint flat config, Prettier. Dev server runs on port **5001** (not 3000).
- Bilingual routing (`/en`, `/ar`) via `next-intl`, Inter + IBM Plex Sans Arabic fonts.
- Fail-closed **DB-backed tenant resolver** (`src/server/tenant.ts`) with 60s in-process cache, `invalidateTenantCache()` hook, and `ALLOW_TENANT_FALLBACK=1` dev override. The middleware (`src/middleware.ts`) uses `runtime: 'nodejs'` so the resolver can reach Postgres.
- Docker Compose local stack at `compose.yml` with Postgres 16, Redis 7, Meilisearch 1.12, Mailpit — **host ports shifted to `5xxxx`** (55432 / 56379 / 57700 / 51025 / 58025) to avoid colliding with other local stacks.
- Drizzle schema for 18 tables across `src/server/db/schema/` (Better Auth core + tenants with `sender_email` + memberships + PATs + Nafath `identity_verifications` + `tenant_keys` + catalog + commerce + redirects + split audit). Migrations at `src/server/db/migrations/` (0000–0005).
- Three Postgres roles (`app_migrator`, `app_user`, `app_tenant_lookup`) + reserved `app_platform`. RLS on every tenant-scoped table. Column-scoped `GRANT` on the resolver path (extended to include `sender_email` in migration 0005).
- `withTenant(db, ctx: AuthedTenantContext, fn)` — branded-type trust boundary, AsyncLocalStorage nested-call guard, in-tx GUC round-trip verification. See `src/server/tenant/context.ts`.
- App-layer AES-256-GCM envelope encryption with AAD binding and format-version byte (`src/server/crypto/envelope.ts`). Boot-check loaders reject missing/short/recognizable-dev values for `DATA_KEK_BASE64`, `TOKEN_HASH_PEPPER`, `HASH_PEPPER`.
- Split audit: `audit_log` (hash-chained, append-only, per-tenant `pg_advisory_xact_lock`, verify-not-stamp trigger raising SQLSTATE 40001) + `audit_payloads` (PDPL-deletable). RFC 8785 JCS canonicalization (`src/lib/canonical-json.ts`). `redactForAudit` Tier-A stripper. SECURITY DEFINER `pdpl_scrub_audit_payloads` stub + `REVOKE DELETE` pattern.
- **Better Auth v1.6.5** with cookie sessions + `bearer` + `magic-link` plugins, Drizzle adapter (`usePlural: false`, `generateId: false` so DB `gen_random_uuid()` fills ids). Host-only cookies (`advanced.crossSubDomainCookies` undefined). Password policy: min 10 chars, breached-password v0 check via a committed top list. BA's internal rate-limiter is disabled; our own Redis sliding-window lives at `src/server/auth/rate-limit.ts`.
- **Tenant-aware transactional email** — `src/server/email/send-tenant-email.ts` (policy function, no interface). Signature takes `Tenant`, not a Host. Nodemailer → Mailpit in dev. Host-spoof security test at `tests/unit/email/send-tenant-email-host-spoof.test.ts`.
- **Service-layer identity seam** at `src/server/auth/resolve-request-identity.ts`: returns `{ anonymous | session | bearer }`. BA types hidden behind it. Tenant-scoped `lookupBearerToken(raw, tenantId)` at `src/server/auth/bearer-lookup.ts` — cross-tenant tokens return null (covered by `tests/unit/auth/bearer-lookup.test.ts`).
- **Auth pages**: `/{locale}/signup`, `/{locale}/signin` (password + magic-link), `/{locale}/verify-pending`, `/{locale}/account` with signout. Button/fill gated on `hydrated` state so mobile WebKit does not race native form submit.
- **ADR 0001 outcome: option (b)** — BA's `bearer` plugin is a session-cookie shim, not a PAT hasher. PAT verification is our own HMAC-SHA-256+pepper path at the MCP/tRPC adapter layer (chunks 6/7). See `docs/adr/0001-pat-storage.md`.
- **Audit wiring**: tRPC mutations flow through the adapter audit middleware at `src/server/trpc/middleware/audit-wrap.ts` (closed-set `AuditErrorCode`, field-paths-only on failure, `BELT_AND_BRACES_PII_KEYS` recursive redaction, 64KB adapter body cap). BA auth events (signup, verify-email, magic-link request/consume, session create/revoke) wire through `databaseHooks` + one `hooks.after` at `src/server/auth/audit-hooks.ts` with structural-only `after` payloads; `hooks.before`-thrown failures (rate-limit-exceeded, PASSWORD_COMPROMISED) use the inline-write pattern because BA short-circuits `hooks.after` on those. Tenant resolution at the BA hook site uses Option B: skip audit + Sentry alert on null-ctx or null-tenant, suppressed by `APP_ENV=seed`.
- Dev seed: `pnpm db:seed:dev` (`scripts/seed-dev-tenant.ts`) upserts the `localhost:5001` tenant row. Playwright global-setup runs it + clears Mailpit before the suite.
- Testing harness (chunk 8 ~90%): Playwright config with iPhone 14 + Pixel 7 × `en`/`ar` mobile + Desktop Chromium secondary, Vitest with `@` alias, Lighthouse CI with mobile budgets, `@axe-core/playwright` helper, Mailpit HTTP helper, `scripts/check-e2e-coverage.ts` (route + mutation coverage lint). **91 unit tests + 78 Playwright tests currently green.** E2E runs against the PRODUCTION build (`pnpm build && pnpm start`) not dev, because Next.js dev-mode HMR occasionally cancels in-flight test navigations on WebKit. Set `PLAYWRIGHT_USE_DEV=1` to opt back in.
- ADRs at `docs/adr/` (0001 PAT storage, 0002 PDPL scrub). Runbooks at `docs/runbooks/` (`kek-rotation.md`, `audit-log.md`, `database-roles.md`, `auth.md`). **Read these before making related changes.**

**Also landed in chunk 6** (on top of chunks 1–5):
- tRPC v11 with typed service layer at `src/server/services/` (Zod input/output per fn; tenant-scoped via `withTenant`; Tier-B output gating via role-switched `.parse`). `createProduct` end-to-end with `cost_price_minor` as the v0 Tier-B placeholder column.
- `deriveRole(ctx)` at `src/server/trpc/ctx-role.ts` — single source of truth for caller role. `Pick<TRPCContext, 'identity'|'membership'>` typed so ctx-spread attacks are type-impossible. Wire-site tripwire throws `INTERNAL_SERVER_ERROR` if role is ever falsy (future-refactor canary).
- Adapter-level body cap: 64KB enforced at `src/app/api/trpc/[trpc]/route.ts` before Zod parse; same ceiling also inside `insertAuditInTx` as defense-in-depth.
- BA rate-limit wire-up at `src/server/auth/rate-limit-auth-hook.ts`: `x-real-ip`-only (XFF deliberately NOT read; Traefik must set X-Real-IP), `normalizeEmailForBucket` plus-alias-strip + NFKC, per-tenant bucket prefix, fail-closed on Redis outage → 503 `RATE_LIMITER_UNAVAILABLE`. Triple-gated E2E bypass: `E2E_AUTH_RATE_LIMIT_DISABLED=1 && APP_ENV=e2e` + per-request `x-dev-only-enforce-rate-limit: 1` opt-out.
- Admin shell: `/{locale}/admin/products/new` admin form with RSC guard at `src/app/[locale]/admin/layout.tsx` (force-dynamic), `requireMembership(['owner','staff'])` + Zod input via `mutationProcedure`. Seed admin + customer user fixtures at `scripts/seed-admin-user.ts`.
- PII canary test infrastructure: `tests/e2e/auth/audit-no-pii.spec.ts` — four flows (password-too-short, breached-password, magic-link-rate-limit, happy signup) each asserting audit rows exist AND contain no canary email/password. `tests/e2e/admin/products/create-product.spec.ts` has a parallel HTTP-path slug-canary test. Closed-set `after`-shape lint at `scripts/check-e2e-coverage.ts` enforces 12 structural keys + max-3 cap for any `auth.*` writeAuditInOwnTx call site.
- Coverage-lint strict mode live: `pnpm check:e2e-coverage` fails on mutations without a referencing Playwright test. Dev-only escape hatch `DEV_ONLY_ALLOW_MISSING_MUTATION_TESTS=1` refuses to run under `CI=true`.
- **225+ total tests** (175 vitest + 192 Playwright) currently green. ADR 0001 (PAT storage option b), ADR 0002 (PDPL scrub), runbooks at `docs/runbooks/` (auth.md heavily expanded during chunk 6).

**Remaining (chunks 7–9):**
- **Chunk 7** — MCP server skeleton (`@modelcontextprotocol/sdk`), PAT issuance path (must reject client-supplied `tenantId`), `run_sql_readonly` stubbed gated. Reuses `AuditErrorCode` from `src/server/audit/error-codes.ts` (pre-factored for MCP adapter import without pulling in pg machinery). `deriveRole` pattern from `src/server/trpc/ctx-role.ts` applies to the MCP context.
- **Chunk 9** — GitHub Actions CI: lint → typecheck → vitest → playwright → lighthouse-ci → check-e2e-coverage, fails-closed. Coolify deploy webhook is a placeholder until Hetzner VM + Coolify exist. Security has pre-flagged: PgBouncer must be `pool_mode = transaction` or `session` (statement pooling breaks RLS). Chunk-6-sourced items: CI env-lint rejecting `APP_ENV=e2e|seed` / `E2E_AUTH_RATE_LIMIT_DISABLED=1` in Coolify env; request-time `proxy_header_missing` 503 refuse in prod when `x-real-ip` absent; wire closed-set `after` lint into CI; AST walk for `hooks.before` throws + inline-audit invariant.

**Note for deferred scope** (see `prd.md` §4 "Deferred"): `pgvector`, Voyage AI embeddings, and the customer-facing AI bot are **post-revenue**. Do not add them to remaining Phase 0 chunks. Owner admin chat ("Chat with your store", Phase 4) is NOT deferred — it uses MCP tools + `run_sql_readonly`, no embeddings.

**Resume guidance.** Running `pnpm install` and `pnpm services:up` brings the local stack up; `pnpm dev` serves at `http://localhost:5001`. All commands in the table below work today. The memory index at `~/.claude/projects/-Users-bassel-development-ecom-ruq/memory/MEMORY.md` has project-specific context (ports, deferred scope, user background, team workflow lessons) — read it before starting a chunk.

---

## Essential commands

All of these work today. They are the definition of done (see Section 1):

| Command | Purpose |
|---|---|
| `pnpm dev` | Local development server |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm test:e2e` | Playwright end-to-end tests (mobile viewport, both locales) |
| `pnpm test:e2e -- <file>` | Run a single Playwright test file |
| `pnpm lint` | Lint check |
| `pnpm typecheck` | TypeScript strict check |
| `pnpm check:e2e-coverage` | Verifies every route and mutation has a referencing Playwright test |
| `pnpm build` | Production build |

No feature is considered done until the first six are green locally and in CI.

---

## Where things live

- **`prd.md`** — the canonical product specification and phased roadmap. Read this before making any non-trivial architectural decision. It is substantive, not operational.
- **`CLAUDE.md`** (this file) — operational rules for how sessions are conducted. Non-negotiable.
- **`.claude/agents/`** — specialized subagents you can delegate to: `software-architect`, `tdd`, `security`, `debugger-fixer`, `frontend-designer`, `explorer`. Each is a separate `.md` file with its own scope.
- **`.claude/skills/`** — skills the user can invoke. Currently: `agent-team` (spawns a team from the agent definitions).
- **`.claude/commands/`** — user slash commands. Currently: `/git` (stage, commit, push in one shot).
- **Generated after Phase 0:** `src/` (application code), `tests/e2e/` and `tests/unit/`, `scripts/` (CI helpers). Source layout is defined in Section 0 below.

---

## 0. Runtime and repo facts (do not rediscover)

- **Package manager:** pnpm. Never use `npm` or `yarn`. All scripts are `pnpm <script>`.
- **Node:** 22.x LTS. Pinned in `.nvmrc` and `package.json > engines`. If the local machine is on a different version, stop and tell the user.
- **Repo structure:** single Next.js application at the repo root, not a monorepo. One `package.json`, one `tsconfig.json`. Monorepo split is deferred to a hypothetical future React Native phase.
- **Source layout:**
  - `src/app/` — Next.js App Router routes
  - `src/server/services/` — typed service layer (all writes go through here)
  - `src/server/trpc/` — tRPC routers (thin wrappers over services)
  - `src/server/mcp/` — MCP server and tool registry
  - `src/server/db/` — Drizzle schema and migrations
  - `src/lib/` — shared utilities
  - `src/i18n/` — locale catalogs (`en.json`, `ar.json`)
  - `tests/e2e/` — Playwright tests
  - `tests/unit/` — Vitest tests
  - `scripts/` — CI helpers, including `check-e2e-coverage.ts`
- **Git workflow:** push to `main`; CI gates deploy. No feature-branch PR process. Never bypass hooks or `--no-verify`.
- **Environments:** `local` → `staging` → `production`. Destructive AI tools and new autonomous agents are exercised against `staging` before being pointed at `production`.
- **Secrets:** stored in Coolify for runtime and in GitHub Actions secrets for CI. Never commit secrets. Never log secrets.

If any of these facts is missing on disk when you start (e.g., `.nvmrc` doesn't exist yet, `pnpm-lock.yaml` is absent, or the source layout hasn't been created), that means Phase 0 has not yet been executed — your job is to set them up, not to question them.

---

## 1. The testing rule (non-negotiable)

**No frontend feature is considered done until a Playwright test exists that drives a real browser through the full user flow, in both locales, on mobile viewport, and passes in CI.**

Unit and integration tests are complementary, not substitutes. "Tests pass" is not the same as "feature works" — we prove features work by exercising them as a user would.

### What counts as a feature

- Any new page or route (public or admin)
- Any new form, button action, or user-triggered mutation
- Any auth flow (signup, login, logout, password reset, magic link, email verification)
- Any checkout step or payment flow
- Any admin mutation that the owner can trigger through the UI or through MCP
- Any change that alters an existing user-facing behavior

### Requirements per feature

Every feature test must:

1. **Run a real browser** via Playwright (no mocking the browser layer).
2. **Cover happy path + at least one critical error case** (e.g., wrong password, out-of-stock, invalid card).
3. **Run on mobile viewport by default** — the default Playwright projects are iPhone 14 and Pixel 7. Desktop is a secondary project. If the mobile test does not pass, the feature is not done.
4. **Run in both `en` and `ar`** locales via parameterized Playwright projects. This catches RTL regressions immediately.
5. **Include an `axe` accessibility assertion** on the key pages the test touches (`@axe-core/playwright`). Ties into the WCAG 2.1 AA NFR.
6. **Complete in under 30 seconds.** If a test is slow, profile and fix — do not accept slow-by-default tests.
7. **Be deterministic.** No flaky retries. If a test flakes, quarantine it and fix the root cause within 24 hours. Do not add `test.retry()` to mask flakes.

### Real-world dependency handling

- **Email flows** (password reset, magic link, email verification, order confirmation): use Mailpit. Trigger the email, poll the Mailpit HTTP API for the message, parse the link out of the HTML, follow it in the browser, verify the downstream state. Do not stub `sendEmail`.
- **Payments:** use Moyasar test mode with real test cards. Fill the real checkout form; submit real test cards. Replay webhooks via Playwright's `request` API.
- **External APIs** (ZATCA, Nafath, Unifonic, BunnyCDN): intercept at the Playwright network layer. Contract correctness is separately verified by integration tests (Vitest) against each vendor's sandbox.
- **Time-dependent logic:** use Playwright's `clock` API for determinism.

### Test data isolation

- Tests run against a dedicated `test` tenant with seeded fixtures.
- Tenant-scoped tables are truncated and re-seeded **before each test run**, not per test.
- Parallel workers are scoped by a tenant suffix so they do not collide.
- Never depend on mutable state leaking between tests.

### Definition of done

Before reporting any task as complete, you must:

1. Run `pnpm test:e2e` and confirm it is green.
2. Run `pnpm test` (Vitest) and confirm it is green.
3. Run `pnpm lint` and `pnpm typecheck` and confirm clean.
4. Run `pnpm check:e2e-coverage` — the coverage lint script that asserts every Next.js route and every tRPC mutation has at least one referencing Playwright test. If it fails, add the missing test.
5. If Lighthouse CI is configured for the touched pages, confirm budgets are met locally.

"Done" means all five of these are green locally and in CI. Do not report a task as complete based on code inspection alone.

---

## 2. The service layer rule

All writes to the database go through the typed service layer at `src/server/services/`. Every service function has:

- A Zod input schema
- A Zod output schema
- Tenant-context-aware implementation (reads `tenantId` from the request context; never trusts user-supplied `tenantId`)
- Audit log entry on write (wrapped by middleware, not manually)

Service functions are consumed by **three** transports:

1. **tRPC router** at `src/server/trpc/` — for the web UI
2. **MCP server** at `src/server/mcp/` — for Claude Desktop, Claude Code, and autonomous agents
3. **Internal jobs and cron** — via direct import

Never duplicate logic across transports. If a tRPC procedure and an MCP tool both need the same write, they both call the same service function. Adding a new capability = adding one service function + one line in the MCP tool registry + one tRPC procedure.

### Rules for service functions

- Destructive operations (`delete_*`, `bulk_update_*`, refunds above a threshold) must require an explicit `confirm: true` parameter on their Zod input schema. Fail the call without it.
- Expensive or irreversible operations must support a `dryRun: true` mode that returns a preview without executing.
- Service functions must not contain transport concerns. No `req`/`res`, no HTTP status codes, no `NextResponse`. Throw typed errors; transport adapters translate.
- Service functions must not perform I/O against the database without going through Drizzle with the tenant-scoped context. No raw SQL outside the sandboxed `run_sql_readonly` path.

---

## 3. The mobile-first rule

Design and code start at 360px viewport and scale up. Never "design for desktop then shrink."

Hard rules enforced in code review and tests:

- Touch targets are **≥ 44×44px**.
- No hover-dependent UI anywhere. Every hover state has an equivalent tap state.
- Storefront mobile layouts use bottom navigation; product pages have a sticky "Add to cart" CTA always reachable by thumb.
- Forms use `inputmode`, `autocomplete`, and Arabic keyboard-friendly controls. Phone inputs have a `+966` prefix built in.
- No layout shift. Reserve space for images, async content, cart badges.
- Performance budget is enforced by Lighthouse CI: p75 LCP < 2.5s, INP < 200ms, CLS < 0.1, JS initial bundle < 200 KB gz.

If a change would regress any of these, stop and raise the concern before implementing.

---

## 4. The i18n rule

Every user-visible string is translatable. No hardcoded English or Arabic in JSX.

- UI strings live in the i18n catalog (one file per locale).
- Content (product names, descriptions, SEO meta, page copy) is stored as JSONB `{ en: "...", ar: "..." }` at the column level.
- CSS uses Tailwind logical properties (`ps-4`, `pe-4`, `ms-auto`, `start-0`). Never `left`/`right` in component code.
- When adding a new string, add both `en` and `ar` values. If the Arabic is a placeholder needing review, mark it with a flag the admin translation UI surfaces — do not ship a placeholder to production.
- New features must pass Playwright tests in both `en` and `ar` before being considered done (see Section 1).

---

## 5. The multi-tenant rule

Every query that touches tenant-scoped data must be scoped by `tenant_id`. Postgres RLS is the safety net; application-layer scoping via the request context is the primary mechanism.

- Never accept `tenantId` from user input. Read it from the tenant resolution middleware (which reads the `Host` header).
- Every tenant-scoped table has an RLS policy. If you add a new tenant-scoped table, add the policy in the same migration.
- When writing a feature, mentally run the adversarial test: "could a malicious tenant A user see or mutate tenant B data through this code path?" If you cannot confidently answer no, add an explicit test.
- Phase 5 adds adversarial isolation tests. Before Phase 5, you are trusted to be paranoid.

---

## 6. The AI safety rule

For operator-facing MCP tools:

- Destructive actions require `confirm: true`.
- Financial operations above a threshold (configurable per tenant) require a second confirmation.
- Every MCP call is audit-logged with actor, token ID, tool name, input, before/after state, outcome.
- Soft-delete catalog entities (products, categories) with a recovery window. Hard delete is a separate gated operation.

For customer-facing AI (deferred — see `prd.md` §4 "Deferred"; these rules apply when the customer bot is revived):

- Tools are **hard-scoped server-side** to the authenticated user's own data. The prompt cannot widen scope.
- The system prompt forbids inferring product specs, prices, or availability. All factual claims must be grounded in retrieved RAG context.
- Output is filtered for PII before being returned to the client.
- Rate limits apply per session, per IP, and per authenticated user.
- Adversarial prompt-injection tests are part of the customer-bot revival exit criteria.

---

## 7. Coding style and conventions

- **TypeScript strict mode.** No `any` except in narrowly-justified boundary code with a comment explaining why.
- **Zod as source of truth.** Types are derived from Zod schemas, not declared separately.
- **No clever abstractions.** Prefer three similar lines of code over a premature abstraction. Claude reads the codebase more confidently when patterns are explicit.
- **No dead code.** Remove unused imports, unused files, unused exports. Do not leave `// removed` comments.
- **No speculative flexibility.** Do not add configuration options, feature flags, or abstractions for hypothetical future needs.
- **No backwards-compatibility shims in a solo pre-launch codebase.** If you need to change a schema or API, change it everywhere in one pass.
- **Comments explain *why*, not *what*.** The code shows what. Comment only where intent or non-obvious constraints matter.
- **File naming:** kebab-case for files, PascalCase for React components, camelCase for functions.

---

## 8. How to talk to the user (non-negotiable)

The user is the solo owner-operator of this business. **They are not a developer.** They have told you this repeatedly. Responses that read like engineering chatter waste their time and burn trust.

### The hard rule

In any message the user will read, **do not use code identifiers**. That includes file paths, file names, folder names, function names, variable names, type names, class names, schema/column/table names, SQL identifiers, config keys, environment-variable names, command names, package names, library names, flag names, error codes, status codes, URL paths, or any token that is recognizably "a thing in the codebase." Translate to what the thing *does* in business terms.

This rule binds **every** sentence the user sees — plain prose, bullet lists, headings, summaries of subagent output, questions you ask, options you present. Do not quarantine jargon inside backticks and pretend it counts as translation. It does not. If a term would be meaningless to someone who has never opened a code editor, either replace it with what it *accomplishes* or omit it.

Common jargon that counts as code-identifier-adjacent and must also be translated or avoided: *cache, middleware, endpoint, route, schema, migration, hash, pepper, cookie, header, scope, token, bearer, dispatcher, adapter, registry, env flag, env var, repo, branch, commit, PR, lint, typecheck, integration test, unit test, vitest, playwright, async, sync, mutation, query, payload, handler, parser.* When unsure whether something is jargon, assume it is.

### How to translate — examples

| Don't write | Write instead |
|---|---|
| "`run_sql_readonly` is gated behind `MCP_RUN_SQL_ENABLED`" | "The direct-database tool stays switched off — there's a flag the business never flips on in production." |
| "Option A relaxes the authorize-failure audit predicate in `audit-adapter.ts`" | "Option A: every refused tool call gets logged, not just write-type ones. The small trade-off lives in our shared logging code." |
| "`check:e2e-coverage` is still red on `tokens.create` / `tokens.revoke`" | "The coverage check still complains about the two token-management flows — that's expected, the next sub-chunk closes it." |
| "The architect recommends reusing the `forbidden` closed-set code" | "The architect recommends reusing our existing 'not permitted' label rather than inventing a new one." |

### When presenting a decision

Phrase the choice as a **business trade-off** — cost, risk, time, scope, blast radius — never as an engineering choice between two code patterns. Give two or three plain-language options with their trade-offs. If you cannot articulate a trade-off without code identifiers, re-think the framing before writing the question.

### When relaying subagent output

Subagents talk to you in engineering language — that's fine. Your job is the filter. **Never paste a subagent's technical brief verbatim.** Read it, extract the decisions the user actually needs to make, translate to business terms, surface only those. If there are no real decisions, just report the outcome in one or two sentences.

### The narrow exception

The user may explicitly ask for a file path, a command to run, a log line, a snippet of code, or similar. Honor the explicit request at the level of detail they asked for. Default back to business framing in the next turn.

### Acronyms

The first time a dev/SaaS acronym appears in a session — *API, JWT, DSN, PAT, RLS, CDN, DKIM, BYOK, CI* and similar — define it in one short clause before using it. Do not lecture.

### Self-check before sending

Before you send a message to the user, scan it for anything that looks like a file name, a function name, a flag, a command, or a code-world term. If you find one, either delete it or rewrite the sentence around what it *does*. This scan is part of composing the response, not optional polish.

Getting this wrong is a repeat offence. Memory alone has failed to fix it. This section exists so there is no excuse.

---

## 9. When reporting progress

When you finish a task, report:

1. What you changed, by file path.
2. Which tests you added or updated, by file path.
3. The output summary of `pnpm test:e2e`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm check:e2e-coverage`.
4. Anything you noticed that was out of scope but worth flagging.

Do not claim a task is done without running the commands in Section 1's "Definition of done." If a command fails, do not report done — fix or escalate.

Note: the command names and paths above are for you; when you summarize results for the user, follow Section 8 and describe outcomes in business terms.

---

## 10. When you are stuck

Do not blindly retry failing actions. If a test fails twice after a fix attempt, stop and:

1. Read the full error output.
2. Check assumptions against the current code.
3. Consider if the test itself is wrong versus the code being wrong.
4. If still unclear, surface the problem to the user with a concrete question — do not spiral.

Asking for a clarification is cheaper than silently guessing.

---

## 11. Living document

This file evolves. When the user gives feedback that changes how we build, update this file (and `prd.md` where relevant) before continuing the task so future sessions inherit the lesson. Do not rely on conversational memory for rules — rules live here.
