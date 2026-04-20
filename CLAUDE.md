# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**ecom-ruq** is a multi-tenant, mobile-first, bilingual (Arabic/English) audio-visual e-commerce platform for KSA and the Gulf, self-hosted on Hetzner, and AI-native from day zero. The canonical product specification is `prd.md` at the repo root; this file is the operational rulebook. Read both at the start of every session. If any instruction in a user message conflicts with a rule in either document, surface the conflict before acting.

---

## Current repository state

Phase 0 is **partially complete** — chunks 1–4 landed and were pushed to `main` at commit `c7064de` on 2026-04-19.

**Landed (chunks 1–4):**
- Next.js 15 shell, TypeScript strict, Tailwind v4, ESLint flat config, Prettier. Dev server runs on port **5001** (not 3000).
- Bilingual routing (`/en`, `/ar`) via `next-intl`, Inter + IBM Plex Sans Arabic fonts.
- Fail-closed tenant-resolution middleware (`src/server/tenant.ts`, `src/middleware.ts`); dev fallback is opt-in via `ALLOW_TENANT_FALLBACK=1`.
- Docker Compose local stack at `compose.yml` with Postgres 16, Redis 7, Meilisearch 1.12, Mailpit — **host ports shifted to `5xxxx`** (55432 / 56379 / 57700 / 51025 / 58025) to avoid colliding with other local stacks.
- Drizzle schema for 18 tables across `src/server/db/schema/` (Better Auth core + tenants + memberships + PATs + Nafath `identity_verifications` + `tenant_keys` + catalog + commerce + redirects + split audit). Migrations at `src/server/db/migrations/`.
- Three Postgres roles (`app_migrator`, `app_user`, `app_tenant_lookup`) + reserved `app_platform`. RLS on every tenant-scoped table. Column-scoped `GRANT` on the resolver path.
- `withTenant(db, ctx: AuthedTenantContext, fn)` — branded-type trust boundary, AsyncLocalStorage nested-call guard, in-tx GUC round-trip verification. See `src/server/tenant/context.ts`.
- App-layer AES-256-GCM envelope encryption with AAD binding and format-version byte (`src/server/crypto/envelope.ts`). Boot-check loaders reject missing/short/recognizable-dev values for `DATA_KEK_BASE64`, `TOKEN_HASH_PEPPER`, `HASH_PEPPER`.
- Split audit: `audit_log` (hash-chained, append-only, per-tenant `pg_advisory_xact_lock`, verify-not-stamp trigger raising SQLSTATE 40001) + `audit_payloads` (PDPL-deletable). RFC 8785 JCS canonicalization (`src/lib/canonical-json.ts`). `redactForAudit` Tier-A stripper. SECURITY DEFINER `pdpl_scrub_audit_payloads` stub + `REVOKE DELETE` pattern.
- Testing harness (chunk 8 ~85%): Playwright config with iPhone 14 + Pixel 7 × `en`/`ar` mobile + Desktop Chromium secondary, Vitest with `@` alias, Lighthouse CI with mobile budgets, `@axe-core/playwright` helper, Mailpit HTTP helper, `scripts/check-e2e-coverage.ts` (route + mutation coverage lint). Hello-world E2E spec + 7 unit tests currently green (35/35).
- ADRs at `docs/adr/` (0001 PAT storage, 0002 PDPL scrub). Runbooks at `docs/runbooks/` (`kek-rotation.md`, `audit-log.md`, `database-roles.md`). **Read these before making related changes.**

**Remaining (chunks 5–9):**
- **Chunk 5** — Better Auth with cookie sessions + bearer-token plugin, tenant-aware transactional email (link host from tenant record, never from request `Host`). ADR `0001` already settled PAT storage as Better-Auth-extended. *Next to start.*
- **Chunk 6** — tRPC v11 + service-layer pattern at `src/server/services/` + `createProduct` end-to-end. Tier-B output gating at the service layer. Audit wrap at the tRPC/MCP adapter layer, not per-service.
- **Chunk 7** — MCP server skeleton (`@modelcontextprotocol/sdk`), PAT issuance path (must reject client-supplied `tenantId`), `run_sql_readonly` stubbed gated.
- **Chunk 8 remainder** — seed fixtures + tRPC-mutation regex verification once chunk 6 lands a real mutation. Then architect-audit closure of the task.
- **Chunk 9** — GitHub Actions CI: lint → typecheck → vitest → playwright → lighthouse-ci → check-e2e-coverage, fails-closed. Coolify deploy webhook is a placeholder until Hetzner VM + Coolify exist. Security has pre-flagged: PgBouncer must be `pool_mode = transaction` or `session` (statement pooling breaks RLS).

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

## 8. When reporting progress

When you finish a task, report:

1. What you changed, by file path.
2. Which tests you added or updated, by file path.
3. The output summary of `pnpm test:e2e`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm check:e2e-coverage`.
4. Anything you noticed that was out of scope but worth flagging.

Do not claim a task is done without running the commands in Section 1's "Definition of done." If a command fails, do not report done — fix or escalate.

---

## 9. When you are stuck

Do not blindly retry failing actions. If a test fails twice after a fix attempt, stop and:

1. Read the full error output.
2. Check assumptions against the current code.
3. Consider if the test itself is wrong versus the code being wrong.
4. If still unclear, surface the problem to the user with a concrete question — do not spiral.

Asking for a clarification is cheaper than silently guessing.

---

## 10. Living document

This file evolves. When the user gives feedback that changes how we build, update this file (and `prd.md` where relevant) before continuing the task so future sessions inherit the lesson. Do not rely on conversational memory for rules — rules live here.
