# Product Requirements Document — Audio/Visual E-commerce Platform

**Status:** Draft v2
**Owner:** Bassel
**Last updated:** 2026-04-23

---

## 1. Introduction & Context

### 1.1 What we are building

A modern, SEO-optimized, **AI-native** e-commerce platform for an audio/visual (AV) products company, built to serve customers primarily in the Kingdom of Saudi Arabia and the wider Gulf region. The platform must support **two storefronts at launch** (the main brand and a sister company), each on its **own custom domain**, with the architecture ready to onboard a third tenant later.

The platform is the **source of truth** for products, inventory, and orders — there is no upstream ERP to sync with. Whatever we build must therefore be reliable enough to run the business, not just serve as a front-end for another system.

"AI-native" is a first-class requirement: the owner must be able to manage the store and ask business questions in natural language from day zero, and the architecture is shaped around a typed service layer that is exposed to the UI, to MCP, and (later) to native mobile clients uniformly.

### 1.2 Target customer & market

- **Primary geography:** Saudi Arabia (KSA), with Gulf expansion in view (UAE first).
- **Primary language:** Arabic (RTL) and English, with Arabic being the dominant language of KSA customers. URL structure, search, and SEO must be first-class for both.
- **Devices:** Mobile-dominant. Gulf e-commerce is overwhelmingly mobile, often on mid-range Android. **Mobile-first UX is non-negotiable** — desktop is an afterthought, not the starting point.
- **Currency:** SAR primary at launch. AED becomes relevant when the UAE market opens.
- **Payment expectations:** Mada (essential), Apple Pay (essential in Gulf), Visa/Mastercard, and BNPL via Tabby/Tamara (near-essential for mid-to-high ticket AV items).

### 1.3 Business constraints

- **Solo development** with Claude Code as the primary implementation partner ("vibe coding"). This shapes our tech choices: we prefer well-typed, schema-first, conventional setups that an AI agent can reason about confidently. We avoid clever/magical abstractions.
- **Near-zero ops burden on the owner.** Infrastructure, deployments, monitoring, and routine store operations should be automatable by AI agents and accessible via natural language. The owner does not want to configure things by hand or open dashboards to answer routine questions.
- **Self-hosted on Hetzner** (Nuremberg/Falkenstein). We accept the latency trade-off (Europe → Gulf is ~100–150ms for origin requests) and mitigate it aggressively with a CDN that has Gulf POPs.
- **Budget-conscious** but not bootstrapped: we'll pay for SaaS where self-hosting creates disproportionate ops burden (Sentry, Resend, Moyasar, Claude API), and self-host the rest.
- **Compliance:** KSA's ZATCA e-invoicing (Phase 2 / Fatoora) and PDPL (personal data protection) are non-negotiable for operating legally in KSA.

### 1.4 Product differentiators

- True multi-tenant (custom domain per brand, isolated catalog, shared codebase)
- Bilingual Arabic/English with real RTL support, not translated-and-hoped-for-the-best
- Gulf-native payments and shipping from day one
- Variant-based catalog (Samsung-style: pick size, color, storage — price and stock vary per variant)
- SEO-first architecture (SSR/ISR, structured data, hreflang, Arabic-friendly slugs)
- **AI-native from day zero:** natural-language store management, MCP server for the owner, AI-assisted product entry, and autonomous ops agents reducing manual work toward zero. A customer-facing AI assistant is scoped for post-launch revisit — see §4 "Deferred".
- **Client-agnostic API layer:** web today, native mobile app later, with no refactor required.

---

## 2. Tech Stack (Locked)

### 2.0 Runtime & repo conventions

- **Package manager:** **pnpm** (locked). All scripts run via `pnpm <script>`. `npm` and `yarn` are not used.
- **Node runtime:** **Node 22.x LTS**, pinned in `.nvmrc` and `package.json > engines`.
- **Repository structure:** **Single Next.js application** (not a monorepo) for Phase 0 through Phase 8. A monorepo split (pnpm workspaces + Turborepo) is deferred to "Phase 50" when a native mobile app is built — at that point the existing Next.js app becomes one workspace and the RN app a second. Until then, one `package.json`, one `tsconfig.json`, one Next.js project at the repo root.
- **Source layout:** `src/app/` (Next.js routes), `src/server/services/` (typed service layer), `src/server/trpc/` (tRPC routers), `src/server/mcp/` (MCP server), `src/server/db/` (Drizzle schema + migrations), `src/lib/` (shared utilities), `src/i18n/` (locale catalogs), `tests/e2e/` (Playwright), `tests/unit/` (Vitest), `scripts/` (CI helpers including `check-e2e-coverage.ts`).
- **Git workflow:** Solo → push-to-main with CI gate. No PR-based review. CI must be green before Coolify auto-deploys. Feature branches are optional and used only for work that spans multiple commits without being shippable mid-way.
- **Environments:** Three environments — `local` (developer machine + Docker Compose), `staging` (Coolify app on Hetzner, seeded with a `staging` tenant), `production` (Coolify app on Hetzner, real tenants on real domains). Staging is where autonomous agents and destructive AI tools are exercised before being pointed at production.

### 2.1 Application

| Layer | Choice | Why |
|---|---|---|
| Frontend framework | Next.js 15 (App Router) + TypeScript strict mode | Best-in-class SSR/ISR for SEO, RSC for mobile perf, mature RTL/i18n story |
| Styling | Tailwind CSS + shadcn/ui | Logical properties for RTL; shadcn is copy-in so tenant theming stays clean |
| API layer | **tRPC + React Query** | End-to-end TypeScript; consumable by both web and React Native later without a backend refactor |
| ORM | Drizzle | SQL-first, lightweight, RLS-friendly, great TypeScript inference |
| Schema validation | Zod | Every service function has a schema — source of truth for types, MCP tools, and API contracts |
| Database | PostgreSQL 16 (self-hosted on Hetzner) | Mature, supports multi-tenant via RLS, JSONB for translations |
| Auth | Better Auth (with **bearer-token plugin** enabled) | Self-hosted, multi-tenant organizations, cookie auth for web, bearer tokens for future mobile, easy Nafath later |
| Cache / sessions / queues | Redis (or Dragonfly) + BullMQ | Standard, well-supported |
| Search | Meilisearch (self-hosted) | Native Arabic tokenization, typo tolerance, fast |
| Media storage & CDN | BunnyCDN Storage + BunnyCDN pull zone | POPs in Jeddah/Riyadh/Dubai, ~1/10th the cost of Cloudflare/Cloudinary |
| Payments (KSA) | Moyasar | KSA-licensed, bundles Mada + Visa/MC + Apple Pay + Tabby/Tamara |
| Payments (intl fallback) | Stripe | For occasional international orders |
| Email | Resend | Cheap, good DX, SPF/DKIM handled, per-tenant sender domains |
| SMS / OTP | Unifonic | KSA-based, local number support |

### 2.2 AI & automation

| Layer | Choice | Why |
|---|---|---|
| Model provider | **Anthropic Claude API** | First-class dependency; Haiku for cheap routing/classification, Sonnet for reasoning, Opus for complex agent tasks |
| Server SDK | `@anthropic-ai/sdk` | Streaming, tool use, prompt caching |
| Client streaming | Vercel AI SDK (`ai`) | Streaming UI for the deferred customer storefront chatbot (see §4 "Deferred") with minimal boilerplate. Owner admin chat is handled outside the app via MCP clients (Claude Desktop / Claude Code), so no in-app streaming UI is built for it. |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript) | Exposes the platform's service layer to Claude Desktop / Claude Code / agents |
| Agent orchestration | Plain Claude tool-use loops | No LangChain — too opaque for vibe coding; direct tool loops are clearer |

### 2.3 Platform & ops

| Layer | Choice | Why |
|---|---|---|
| PaaS layer | Coolify (on Hetzner) | Self-hosted "Vercel" — git deploys, SSL, multi-domain, managed Postgres/Redis. Critical for solo ops. |
| Reverse proxy | Traefik (bundled with Coolify) | Auto-SSL, easy multi-domain routing per tenant |
| Observability | Sentry (SaaS free tier) | Not worth self-hosting for solo |
| Analytics | Plausible (self-hosted) + GA4 | Privacy-first product analytics; GA4 because marketing will ask |
| Backups | pg_dump → Hetzner Storage Box | Nightly, 30-day retention, ~€3/month |
| CI/CD | GitHub Actions → Coolify webhook | Push to main → green CI → auto deploy. No red-to-prod path. |

### 2.4 Testing

| Layer | Choice | Why |
|---|---|---|
| E2E browser driver | **Playwright + TypeScript** | Modern standard: parallelism, multi-browser, mobile device emulation, route interception, excellent DX. Claude writes Playwright confidently. |
| Accessibility in tests | `@axe-core/playwright` | Every E2E test also asserts axe — ties WCAG 2.1 AA NFR into CI |
| Fake email inbox | **Mailpit** (Docker container) | Password reset, magic link, email verification tests click *real* captured emails |
| Performance enforcement | **Lighthouse CI** | Enforces mobile perf budget (LCP/INP/CLS/bundle size) on every build. Red → no deploy. |
| Visual regression | Playwright screenshot diff | Cheap insurance against RTL vs LTR layout bugs |
| Unit / integration | Vitest | Fast, works with Next.js, good Drizzle support. Complements E2E, does not replace it. |

**Explicitly rejected:**
- Vercel / Supabase / Clerk (not self-hosted, against user preference)
- Prisma (heavier than Drizzle, worse RLS story)
- Elasticsearch / Algolia (overkill / not self-hosted)
- LangChain / LangGraph (too opaque for vibe coding; direct tool loops are clearer)
- Microservices (no — start monolith, split only if needed)

---

## 3. Architectural Decisions

### 3.1 Multi-tenancy

- **Model:** Single database, shared schema, `tenant_id` column on every tenant-scoped table, enforced via Postgres RLS policies.
- **Tenant resolution:** Incoming request → read `Host` header in Next.js middleware → look up tenant by domain → attach `tenantId` to request context → all DB queries scoped automatically.
- **Why not subdomains:** User chose custom domain per tenant. Better for brand SEO and trust.
- **Why not schema-per-tenant:** Operationally painful, migrations get weird, overkill for 2–3 tenants.

### 3.2 Internationalization (i18n)

- **Locales at launch:** `en` and `ar`. Architecture must not assume two — adding `ar-AE` or others should be content work, not a refactor.
- **Routing:** `/{locale}/...` — e.g., `/ar/products/...` and `/en/products/...`. Root `/` redirects based on `Accept-Language` with manual override persisted in a cookie.
- **Translatable content model:** Every translatable field stored as JSONB with shape `{ en: "...", ar: "..." }` at the column level (e.g., `product.name`, `product.description`). This is simpler than a separate translations table and plays well with Drizzle.
- **RTL:** `dir` attribute driven by locale. Tailwind logical properties (`ps-4`/`pe-4`, `ms-auto`, `start-0`) throughout. No `left`/`right` in component code.
- **Arabic typography:** IBM Plex Sans Arabic or Tajawal loaded via `next/font`. Latin typography: Inter via `next/font`.
- **Arabic slugs:** Allow real Arabic in URLs (Google indexes them correctly). Product slugs are per-locale: `/en/products/sony-a7iv` ↔ `/ar/products/سوني-a7iv`.
- **hreflang:** Emit `hreflang="ar-SA"` and `hreflang="en-SA"` + `x-default` on every public page.
- **Locale fallback policy:** Content fields (product name, description, page copy, etc.) are stored per-locale in JSONB. When a field is missing in the requested locale, the public storefront **falls back to the other locale silently** — the shopper always sees something, never a broken placeholder. The admin UI, by contrast, **surfaces missing translations explicitly** with a visible badge so the owner knows what still needs translating. **The fallback is a safety net, not a launch strategy:** the platform launches bilingually in Phase 1b, with every seeded and live product carrying both `ar` and `en` content. The fallback exists to handle individual missing fields gracefully (e.g., a newly added product where the owner hasn't yet filled in one locale) — not to ship a half-translated experience.

### 3.3 Product variants (option-driven, industry-standard)

Catalog model from day one. The platform is multi-tenant, so the **shape** is fixed by the platform but the **content** is defined by each merchant — the platform ships no preset option list, no preset specifications, and no preset filters. Tenants selling cameras, perfume, speakers, or anything else all define their own option names per product.

- **Product** — the parent concept (e.g., a camera model, a perfume line, a speaker family — whatever the merchant sells).
- **ProductOption** — an axis of variation defined by the merchant on a specific product (e.g., "Colour", "Storage", "Connector", "Bottle volume"). Option names are merchant-defined per product; no global registry, no per-shop reusable templates at launch (those are a later polish chunk if pain emerges).
- **ProductOptionValue** — a value on an axis (e.g., "Black", "256GB", "XLR", "50ml").
- **ProductVariant** — a specific combination, carrying its own:
  - SKU
  - Price (base + sale)
  - Stock quantity
  - Weight / dimensions (affects shipping)
  - Optional **single cover image** drawn from the product's photo library (see 1a.7). Visual axes (colour, finish) typically set it; non-visual axes (storage capacity, RAM) leave it empty and inherit the product's cover. The underlying linkage allows multiple photos per variant in the future, but the v1 UI exposes only a single cover.
  - Barcode / EAN
- **Default variant:** every product has one; if a product has no real variations, it's a product with a single variant. This avoids branching logic everywhere.
- **Caps (matches industry standard).** At most **3 option types per product** and at most **100 variants per product**. Past those, the merchant splits into separate products. Both Shopify and Amazon enforce equivalent limits; storefront performance and operator UX both depend on these.
- **Variants are not specifications.** A *variant* is something the customer picks at purchase (gets its own price/stock/SKU). A *specification* is a fixed product fact, optionally surfaced as a catalogue filter on the listing page. Specifications and filters are a per-tenant configuration delivered in a later chunk; they do not block variant work.

Cart and orders reference **variants**, not products.

### 3.4 SEO foundation

Baked in from Phase 0:
- SSR/ISR for all public pages (no client-only rendering of product/category pages)
- `generateMetadata` with per-locale titles, descriptions, OG tags
- JSON-LD: `Product`, `Offer`, `AggregateRating`, `BreadcrumbList`, `Organization`
- Sitemaps per tenant per locale, referenced in `robots.txt`
- Canonical URLs (critical when the same product lives under multiple categories)
- Image sitemaps (AV is visual)
- 301 redirects on slug changes (admin-managed redirect table)

### 3.5 Compliance foundations

- **PDPL:** cookie consent banner, data export endpoint, data deletion endpoint, audit log for sensitive field access. Raw national IDs (when Nafath lands) stored encrypted at rest.
- **ZATCA:** invoice schema designed from day one with all required fields (seller/buyer VAT numbers, invoice hash chain, QR code payload). Actual API integration is Phase 6, but data model is Phase 0.
- **VAT:** 15% KSA, 5% UAE — region-aware tax engine from the start, even if only KSA is used initially.

### 3.6 Tenancy & auth interaction

- Users belong to the platform, not a tenant. A single user can have accounts across multiple tenant storefronts (different carts, different order histories), because the sister-company case means the same customer may shop both brands.
- Admin users belong to a **tenant** with a role (owner / staff / support) and permissions.
- **Launch roles are fixed with predefined permission sets.** A **custom role + permission builder** — letting the owner define new roles and attach fine-grained permissions (e.g., "view tokens", "create tokens", "revoke tokens" as separate capabilities) to each — is delivered in **Phase 7**. Phase 0–6 code gates on role identity; the Phase 7 migration converts those gates to permission-identity checks. To keep that migration surgical, all role gates in Phase 0–6 must route through a single authorization contract **per transport**: `requireRole` on tRPC, and the `McpTool.authorize` hook on MCP. Each tool owns its own `authorize` implementation; the *shape* of the contract is uniform, even where gate details vary per tool.
- A super-admin role exists for platform operators (us).
- **Transactional email links must be tenant-aware.** Magic link, password reset, email verification, and order confirmation emails all contain URLs — those URLs must be built against the **tenant's own custom domain**, not a shared domain. The auth layer passes tenant context into the `sendEmail` function so the link host matches where the user actually signed up. Same rule applies to any tenant-scoped email: the link always points to that tenant's domain. Email sender identity (From address, DKIM) is also per-tenant via Resend domains.

### 3.7 AI-first architecture

The platform is designed around a **single typed service layer** exposed through three transports. This is the most important architectural decision in the document.

```
                   ┌── Admin UI (tRPC / React Server Components)
Service layer ─────┼── MCP server (for Claude Desktop / Code / agents / ops)
                   └── Internal jobs & cron (direct imports)
```

Every write operation (`createProduct`, `updateInventory`, `refundOrder`, `createDiscountCode`, `adjustInventory`…) lives in **one place** as a typed function with a Zod input schema and a Zod output schema. The admin UI, the MCP server, and background jobs all call the same functions. No duplication, no drift. Everything the UI can do, AI can do — by construction, not by afterthought.

**Service layer rules:**
- Every service function has: a Zod input schema, a Zod output schema, a tenant-context-aware implementation, and an audit log entry on write.
- Destructive operations (delete, bulk update, refund above threshold) require an explicit `confirm: true` parameter.
- Large / expensive / irreversible operations support a `dryRun: true` mode.
- Service functions never contain transport concerns (no `req`/`res`, no HTTP status codes). Transport adapters translate.
- **Tier-B fields (see §6.5) require role-gated output schemas.** A service function returning a product to a customer-facing transport must omit `cost_price`, `supplier_notes`, and any other internal-only field; the same function called from an owner-role admin context returns them. The output schema, not the caller, is the gate — this prevents accidental leakage when a new transport (e.g., a future mobile app, a new MCP tool) reuses the same service function.

**MCP server:**
- Self-hosted alongside the Next.js app (same deploy, separate route), implemented with `@modelcontextprotocol/sdk`.
- Tools are auto-derived from service functions' Zod schemas — adding a tool = writing a service function + one line in the MCP registry.
- Authentication via **personal access tokens** issued by Better Auth, scoped by tenant and role. Tokens are revocable, rotatable, rate-limited, and audit-logged on every call.
- Tool set is **role-filtered**: a staff token sees fewer tools than an owner token; a customer support token sees only returns/refunds, etc.
- Super-admin (platform operator) has cross-tenant tools.
- A `run_sql_readonly` tool (sandboxed, row-limited, parameterized, no DDL) is available to owner-role tokens only, enabling ad-hoc natural-language analytics. Every query is logged.

**Retrieval-augmented generation (RAG):**
Deferred to post-launch (see §4 "Deferred"). Semantic search, `pgvector`, and the embeddings pipeline are not part of the core roadmap; they are revisited once revenue justifies the operational overhead. Owner-facing natural-language analytics happens through MCP clients (Claude Desktop / Claude Code) talking to the platform's MCP server — no in-app admin chat UI is built. It works without embeddings: MCP tools plus `run_sql_readonly` over structured data, not vector retrieval.

**Audit log:**
- Every service write is logged with: actor type (user/agent/system), actor ID, token ID (if any), tenant, operation, input, before state, after state, outcome, timestamp, correlation ID.
- **Reads of Tier-A fields (see §6.5) are also audit-logged** — including which actor decrypted a national ID or verification payload, when, and from what surface. Reads of Tier-B and Tier-C fields are not audit-logged (would drown the log in noise); access to those is controlled via role-gated output schemas and RLS instead.
- Audit log is append-only, tenant-scoped, and retained per PDPL requirements.
- The audit log is itself exposed as a read-only MCP tool (`search_audit_log`), so the owner can ask "who changed the price on product X and when?" in natural language.

**Autonomous ops agents:**
- Cron-triggered agents that reduce operational load:
  - Daily digest (yesterday's sales, anomalies, stock alerts) → email/Slack
  - Stock watchdog (low stock, velocity-based reorder suggestions)
  - Refund/fraud watcher (anomaly detection)
  - SEO drift watcher (Core Web Vitals + Search Console checks)
  - Log triage (daily Sentry summary with suggested root causes)
  - Backup verifier (weekly test restore to a temporary DB)
- Each agent is a small Claude tool-use loop calling the MCP server.
- Agents report to the owner; they never auto-execute destructive actions without human confirmation.

### 3.8 Client-agnostic API layer (web today, mobile later)

Three decisions, made in Phase 0, make a future native mobile app a drop-in rather than a refactor:

1. **tRPC + React Query as the primary API transport.** End-to-end TypeScript, works natively with Next.js today, and has first-class React Native support (`@trpc/react-query` on RN) for later. The service layer (3.7) is exposed via a tRPC router; the web uses it, and a future RN app imports the same client.
2. **Better Auth with the bearer-token plugin enabled from day one.** Web uses HTTP-only cookies (best for CSRF protection). Mobile will use `Authorization: Bearer <token>` headers. Both work against the same auth backend with no migration. Refresh token rotation and per-device sessions are enabled from the start.
3. **All transactional surfaces behind the tRPC router, not embedded in pages.** Anything a mobile app would need — browse, cart, checkout, order tracking, returns, account — exists as a tRPC procedure, not as logic buried in a Next.js page component. Next.js pages are thin consumers of the router.

**Consequence:** when (or if) we build a native mobile app later, we create a React Native + Expo project, install `@trpc/client` and `@anthropic-ai/sdk`, import the existing tRPC router types, and start calling procedures. No backend changes. Shared Zod schemas, shared i18n strings, shared business logic.

**PWA first:** before committing to a native app, we'll ship a Progressive Web App (later phase, low effort). Add-to-home-screen, push notifications (iOS 16.4+ supports web push), offline catalog, Apple Pay in Safari. For AV e-commerce in KSA, a PWA likely covers 85–90% of native-app value at 5% of the cost.

### 3.9 Testing philosophy & enforcement

**The rule:** No frontend feature is considered done until a Playwright test exists that drives a real browser through the full user flow, in both locales, on mobile viewport, and passes in CI. Unit and integration tests are complementary, not substitutes. "Tests pass" is not the same as "feature works" — we prove features work by exercising them as a user would.

This rule is non-negotiable because the codebase is AI-built. Without real browser verification, "passing" drifts from "working" in ways that surface only when a real user hits them.

**What counts as "a feature":**
- Any new page or route (public or admin)
- Any new form or user action
- Any auth flow (signup, login, logout, password reset, magic link, email verification)
- Any checkout step or payment flow
- Any new admin mutation
- Any change that alters an existing user-facing behavior

**Test requirements per feature:**
- Happy path + at least one critical error case
- Runs on **mobile viewport by default** (iPhone 14 / Pixel 7 profiles) — desktop is a secondary project
- Runs in **both `en` and `ar`** (Playwright projects parameterize the locale)
- Includes an `axe` accessibility assertion on the key pages touched
- Completes in under 30s (quarantine flaky tests within 24h; do not retry-until-green)

**Handling real-world dependencies:**
- **Email flows (password reset, magic link, email verification):** Mailpit runs alongside the app in dev and CI. Tests trigger the email, poll the Mailpit HTTP API for the message, parse the link, and follow it in the browser — exactly what a real user does.
- **Payments:** Moyasar test mode with test cards. Tests fill the real checkout, submit a test card, and verify the resulting order in admin. Webhooks are replayed via Playwright's `request` API.
- **External APIs (ZATCA, Nafath, Unifonic):** network interception at the Playwright layer to stub external calls; contract is verified separately by integration tests against sandbox environments.
- **Time-dependent logic:** Playwright's `clock` API for deterministic testing.

**Test data isolation:**
- Dedicated `test` tenant with seeded fixtures
- Tenant-scoped tables truncated and re-seeded before each test run (not per test — too slow; per run is fine with parallel workers scoped by tenant suffix)
- No shared mutable state between tests

**Enforcement (three independent mechanisms):**

1. **`CLAUDE.md` project instruction** at repo root — Claude Code reads this automatically and treats it as operational rule. Key directive: *every user-facing change must ship with a Playwright test covering the full flow in both locales on mobile viewport, and Claude must run `pnpm test:e2e` and confirm green before reporting a task as done.*
2. **CI gate:** GitHub Actions runs `playwright test` + `lighthouse-ci` + `vitest` on every push. Coolify deploy webhook only fires on green. There is no red-to-prod path.
3. **Coverage lint:** `scripts/check-e2e-coverage.ts` enumerates all Next.js routes + all tRPC mutations and asserts each has at least one referencing Playwright test. Fails CI if a new route lands without a test. This is the unforgeable enforcement.

**AI involvement in testing:**
- Claude Code writes Playwright tests as part of every feature, using the service layer's Zod schemas for typed inputs.
- **Test triage agent** (Phase 4+): when a test fails in CI, an agent reads the failure + changed diff + screenshot and posts a root-cause analysis. Human confirms the fix.
- **Exploratory agent** (Phase 8): optional Claude agent that drives Playwright in free-form mode to hunt for bugs not covered by scripted tests.

---

## 4. Phased Roadmap

Each phase ends with a clear deliverable. Phase 0 is foundation; Phase 1 onward ship something that can be used or monetized. AI capabilities are woven into every phase, not deferred.

### Phase 0 prerequisites — owner actions before Phase 0 can begin

Claude Code can automate almost everything, but it cannot create accounts or prove your identity to third parties. Before a fresh Claude session starts Phase 0, the owner must have the following in hand. Claude should ask for any of these values it needs and should halt rather than guess.

> **Note on phasing.** Phase 0 is scoped to **local-only foundation** work — no production host, no CI pipeline, no CDN, no error-monitoring DSN. Of the items below, only the **GitHub repo + PAT**, **Anthropic API key**, and **local dev machine** are strictly blocking for Phase 0. The **Hetzner Cloud account**, **Sentry DSN**, **domain registration**, and **launch domain names** are only required when the **Launch infrastructure** block (at the top of Phase 1b) is scheduled, which is closer to first public launch. The other hosting-related items in the "deferred but worth starting paperwork" table (Moyasar, Resend, Unifonic, BunnyCDN, ZATCA, Nafath, Apple Developer) are needed by the phase each row notes and are not blockers for Phase 0 or Launch infrastructure unless called out there.

**Accounts and credentials (required to start Phase 0):**

| Item | Purpose | What Claude needs |
|---|---|---|
| Hetzner Cloud account | VM hosting | API token with read/write |
| GitHub account + an empty repo | Code hosting + Actions | Repo URL, a classic PAT or fine-grained PAT with repo + workflow scopes |
| Anthropic (Claude) API key | All AI features from day zero | `ANTHROPIC_API_KEY` |
| Sentry account (free tier) | Error observability | Project DSN |
| A registered domain + DNS provider access | Custom domains per tenant | Registrar credentials or API access (Cloudflare recommended for DNS + WAF) |
| **Two domain names chosen** for the main tenant and the sister tenant | Launch infrastructure (top of Phase 1b) wires at least one into Traefik/Coolify | The actual strings (e.g., `brand-a.com`, `brand-b.com`) |
| A local machine with Docker, pnpm, and Node 22 LTS installed | Running the dev loop and Playwright locally | — |

**Accounts deferred but worth starting the paperwork for (can be collected later):**

| Item | Needed by | Notes |
|---|---|---|
| Moyasar merchant account | Phase 2 (commerce MVP) | Requires a Saudi Commercial Registration (CR). **Start the application early — it is the slowest prerequisite on the path to first revenue.** Test mode works without approval. |
| Resend account + domain verification per tenant | Phase 2 (transactional email) | DKIM records must be added per tenant domain |
| Unifonic account | Phase 2 (SMS/OTP) | KSA-based provider, CR-friendly |
| BunnyCDN account | Phase 1 (media delivery) | Storage zone + pull zone per tenant |
| ZATCA Fatoora portal registration | Phase 6 (e-invoicing) | Requires CR and VAT number; plan to start paperwork in Phase 4 |
| Nafath aggregator agreement (IAMX, Elm, or equivalent) | Phase 7 (identity verification) | 4–6 week lead time; start during Phase 5 |
| Apple Developer account | Phase 7 (Apple Pay domain verification) | Not needed before checkout goes live |

**Decisions the owner must make before Phase 0:**

1. **The two launch domain names.** Phase 5 launches both; the Launch infrastructure block inside Phase 1b needs at least one real name to wire into Coolify. Placeholders are acceptable for local dev but production domains must be real before Phase 1b's public URL goes live, and both before Phase 5.
2. **Company legal entity / CR number** for KSA compliance (used for VAT, ZATCA, Moyasar onboarding).
3. **Admin email address** for the first owner account and for Sentry / Resend / Hetzner notifications.
4. **Slack or email channel** where daily digests and agent alerts will land.
5. **Brand assets** (logos in SVG, primary + secondary colors, font license if using a custom typeface) for at least the main tenant.

**What Claude Code will do in the first Phase 0 session:**

1. Read `prd.md` and `CLAUDE.md` fully.
2. Ask the owner for the values in the tables above that are needed *right now* (GitHub repo + PAT, Claude API key, local dev machine details). Defer Hetzner, Sentry, and production domain names until the Launch infrastructure block of Phase 1b.
3. Store local-dev secrets in `.env.local` (gitignored); production secrets land in Coolify / GitHub Actions only when Launch infrastructure is scheduled.
4. Halt on anything it cannot obtain, explaining exactly what is missing.

---

### Phase 0 — Foundation (not shippable, local-only)

**Goal:** Local-runnable foundation — schema, auth skeleton, AI primitives, service-layer API, tenant isolation, testing harness, and observability prep. Nothing is deployed to a public host. The production VM, CI pipeline, CDN, and error-monitoring wiring live in the **Launch infrastructure** block at the top of Phase 1b, which ships closer to first public launch. Phase 0 is fully solo-developable on a laptop against local Docker Compose; its checks run locally and gate commits via developer discipline rather than a hosted CI pipeline.

**Why split this way (rationale, 2026-04-23):** at Phase 0 close, there is one developer, no production host, no staff, and no customers. A hosted CI pipeline and Coolify deploy webhook have no target to point at and no second set of hands whose pushes they would guard. The two pieces of the original "deploy pipeline" goal that are genuinely load-bearing today — error-log scrubbing (so that customer identifiers never leak into logs, before any error-monitoring DSN is wired) and boot-time production-safety guards (so that a misconfigured production env cannot start) — are kept in Phase 0. The rest (Hetzner VM, Coolify, CI workflow, Sentry DSN, Lighthouse CI enforcement, CDN, backups, uptime monitoring) moves to Launch infrastructure and lands in one coordinated pass before Phase 1b's public URL goes live.

**Work:**

*Application*
- Next.js 15 app scaffolded with TypeScript, Tailwind, shadcn/ui, Drizzle, Better Auth
- **tRPC router scaffolded** with tenant-scoped context and auth guards
- **Better Auth with bearer-token plugin enabled** (cookies for web, tokens ready for mobile)
- Base DB schema migrated (tenants, users, sessions, access_tokens, products, variants, options, categories, orders, order_items, addresses, carts, redirects, verifications, audit_log — all with `tenant_id` + RLS policies where applicable)
- Service layer pattern established: one example service function end-to-end (`createProduct`) wired to tRPC, MCP, and audit log
- Tenant resolution middleware (`Host` header → tenant context)
- i18n routing middleware (`/en`, `/ar`)

*Local services*
- Docker Compose stack: Postgres 16, Redis 7, Meilisearch 1.12, Mailpit (SMTP + web UI) — all on shifted local host ports to avoid colliding with other dev stacks

*AI primitives*
- `@anthropic-ai/sdk` initialized; Claude API key in env
- MCP server skeleton running (one tool live end-to-end as proof)
- Personal access token model in Better Auth (tenant- and role-scoped)
- Audit log middleware wrapping every service-layer write
- `run_sql_readonly` tool stubbed (gated, not yet exposed)

*Observability prep (precedes Sentry wiring in Launch infrastructure)*
- Error-log scrubbing across every error path — strip customer identifiers (email, PAT plaintext / hash, membership user id, etc.) and tenant IDs from messages, stack-frame extras, and contextual metadata before they reach stdout, so that when a Sentry DSN is eventually wired the `beforeSend` scrubber only has a narrow last-mile job. Includes the known `withTenant` flat-only throw that embeds the outer `tenantId` in its error message
- Boot-time production-safety guards — at `NODE_ENV=production`, refuse to start with any test-only switch active (`APP_ENV=e2e|seed`, `E2E_AUTH_RATE_LIMIT_DISABLED=1`, `MCP_RUN_SQL_ENABLED=1`), and refuse on first request if the reverse-proxy is not setting `x-real-ip` (503 `proxy_header_missing`). Hard-refuse boot check that `DATABASE_URL_BA` never points at `app_user` (would silently filter BA's writes under RLS)
- Magic-link audit log race fix — when two or more magic-link consumes race at the same instant, tolerate the `audit_payloads` primary-key collision so both forensic detail rows land (today, the losing racer's detail row is dropped; the companion `audit_log` row still lands). Regression test drives two simultaneous consumes against Mailpit and asserts both detail rows exist

*Testing infrastructure*
- Playwright installed and configured with mobile-first projects (iPhone 14, Pixel 7) + locale-parameterized projects (`en`, `ar`)
- `@axe-core/playwright` wired into a shared test helper
- Vitest configured for unit/integration tests
- Lighthouse CI **config present locally** with mobile perf budgets (LCP, INP, CLS, JS bundle size) — budgets are runnable on-demand, but CI-level enforcement (red → no deploy) moves to Launch infrastructure
- `scripts/check-e2e-coverage.ts` — enumerates routes + tRPC mutations, asserts each has a Playwright test (developer-runnable; hosted CI enforcement lands in Launch infrastructure)
- `scripts/check-role-invariants.ts` — AST walks for the R-1/R-2/R-3/R-4 invariants around role gates and pre-auth tenant helpers
- `CLAUDE.md` created at repo root with the testing rule and vibe-coding operational guidance
- One example Playwright test covering the seeded "hello world" page in both locales on mobile viewport — proves the local pipeline is green end-to-end

**Exit criteria:** A "hello world" page resolves on two different local-dev domains, each in both English and Arabic, with tenant isolation working at the DB level. The MCP server is reachable with a personal access token, and a test tool call against the single example service function succeeds and appears in the audit log. A tRPC procedure is callable from the web and returns typed data. **A Playwright test runs the hello-world page in both locales on mobile viewport and passes axe. All local checks — `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm check:e2e-coverage`, `pnpm check:role-invariants` — are green. Error-log scrubbing is in place across all error paths, boot-time production-safety guards are wired, and the magic-link audit race no longer drops forensic detail rows.** No hosted CI pipeline yet — that lands in Launch infrastructure.

---

### Phase 1a — Catalog backbone + bilingual AI product entry (not shippable, internal milestone)

**Goal:** The owner can create and manage fully bilingual products end-to-end — via the admin UI and via Claude. The public storefront does not exist yet; this phase exists to prove the bilingual content pipeline before any public traffic sees it.

**Already landed in Phase 0 (chunks 6 & 7):** `createProduct` service + tRPC + MCP (`create_product`) wired end-to-end through the adapter audit middleware, and the `/{locale}/admin/products/new` admin create form gated by `requireMembership(['owner','staff'])` with the RSC guard at `src/app/[locale]/admin/layout.tsx`. Phase 1a picks up from there — the remaining CRUD, the bilingual content model, the image pipeline, the catalog MCP surface, and the AI assist panel.

**Chunking:** Phase 1a is broken into small chunks; each chunk is scoped so an agent team can land it in a single session (service + transport + admin UI + Playwright in both locales on mobile + vitest + coverage lint). Chunk-level progress lives in `CLAUDE.md`. The sequence below is the intended landing order.

**Work:**

*Catalog (admin-side)*
- **1a.1 — Admin product list.** `/{locale}/admin/products` table view with `listProducts` service + tRPC query + read-only `list_products` MCP tool. Columns: name (in current locale), slug, status, last-updated. Pagination (20/page). Empty state with a link to the existing create form. No edit/delete/filter yet. Owner-or-staff gated via the existing RSC guard.
- **1a.2 — Edit a product.** `updateProduct` service + tRPC mutation + `update_product` MCP tool + admin edit form reached from the list row. Bilingual field pair polished during this chunk.
- **1a.3 — Soft-delete a product.** `deleteProduct` service + tRPC mutation + `delete_product` MCP tool (`confirm: true` required) + admin delete action with a recovery window. Hard-delete is a separate gated operation, out of scope here.
- **1a.4 — Category management.** Categories form a single tree with one parent per category, depth capped at three levels (categories may be shallower). Products are many-to-many with categories from day one (a product can live under several categories — matches Shopify/Amazon/Sweetwater shape). Each category has a single Latin slug shared across both locales (the owner chose Latin URLs over Arabic-script URLs for share-ability; bilingual `name`/`description` still apply). Three sub-chunks land in order: **1a.4.1** services + tRPC + MCP (`list_categories`, `create_category`, `update_category`) with depth/cycle/slug-uniqueness guards, no UI. **1a.4.2** admin list/create/edit pages mirroring the products admin UX, plus a multi-select category picker on the product edit form. **1a.4.3** soft-delete + restore + owner-only hard-purge sweeper mirroring 1a.3 — soft-deleting a parent cascades to descendants in the same transaction, and restoring a child whose parent is still removed is refused.
- **1a.5 — Variants.** Operator tooling for defining option types and managing variants (SKUs, prices, stock) per product; the data layer is partially in place via `product_options` / `product_option_values` / `product_variants` from Phase 0. Caps from §3.3 (≤3 option types per product, ≤100 variants per product) are enforced at the data layer. Per-variant cover photos wait for 1a.7's image pipeline (until then variants share the parent product's photos). Per-tenant **specifications + catalogue filters** are their own later chunk and do not block this work. The customer-facing variant **picker** (visible buttons, colour swatches, image swap, sticky add-to-cart, sold-out greying — per Baymard's product-page UX research and the patterns Shopify/Amazon/Apple/Sonos converge on) lands as part of Phase 1b's product detail page work; it cannot exist before there is a public product detail page. Three sub-chunks land in order: **1a.5.1** services + tRPC + MCP — `setProductOptions`, `setProductVariants`, `getProductWithVariants`; MCP tools `set_product_options` / `set_product_variants` (non-destructive set-replace, no `confirm: true`) — with Zod-enforced validation (≤3 options, ≤100 variants, no duplicate combinations, SKU uniqueness within tenant, price ≥ 0, stock ≥ 0), OCC on the parent product, and a per-tenant advisory lock during the variant-set diff to serialize concurrent edits to the same product. No UI. **1a.5.2** admin UX core — on the product edit page, an Options panel (add option types, add values per option) and a Variants grid (auto-generated from the cartesian product of the option values, per-row inline editing of SKU/price/stock); single-variant default mode (no options defined → simple SKU/price/stock form, not a grid); mobile-first list-style editor rather than a desktop data grid; both locales. **1a.5.3** admin UX polish — bulk select + apply price/stock to multiple rows; remove individual variant rows (hard delete; no soft-delete recovery for individual variant rows since the parent product's soft-delete already covers broader mistakes); remove an option type with cascade warning showing the live count of variant rows that will be removed; cap-hit pre-save error when defining options would generate more than 100 combinations; inline error messages for duplicate SKUs and out-of-range values.
- **1a.6 — Bilingual content polish + missing-translation badge. *Deferred 2026-05-02 to a post-must-have polish pass.*** The JSONB `{ en, ar }` input pair already ships on products / variants / categories from 1a.2 onward; the deferred scope is just the badge UI surface (per-field "missing translation" indicator) and a "show only items missing Arabic" filter on admin lists. Reason for deferring: pre-launch, solo operator, small catalog — the badge mostly tells the owner what they already know. Revisit when the catalog is large enough that the badge actually saves time, after images (1a.7), storefront (Phase 1b), and checkout/payments are in.
- **1a.7 — Image pipeline.** Photo upload, storage, processing, and admin tooling for products and variants. **Storage layer is swappable from day one** — a small adapter interface (`put` / `get` / `delete` / `list`) with two implementations: a **local-disk backend** for dev/test and a **BunnyCDN Storage Zone backend** for production. The implementation is selected by env config; no code change is required to flip backends. This avoids a migration step at Phase 1b launch and is forward-compatible with video (same vendor; short clips ride the same backend, longer content can use BunnyCDN Stream when we add it). The production Storage Zone + Pull Zone are provisioned inside Phase 1b's Launch infrastructure block; the adapter interface itself ships in 1a.7. Customer-facing photo rendering (gallery, swipe carousel, pinch-to-zoom, variant-aware refresh, OG meta tags, Product JSON-LD `image` field, browser priority/lazy hints) is Phase 1b's product detail page work — 1a.7 stops at "the data, the URLs, the derived sizes, the storage adapter, and the admin tooling exist". 1a.7 produces everything Phase 1b needs to render correctly; Phase 1b wires it into the storefront markup.

  *Acceptance rules on upload (validated server-side, client claims are not trusted):*
  - Accepted formats: JPEG, PNG, WebP.
  - **Minimum dimensions:** ≥ 1,000 px on the longest side. Below this, reject with a clear message (matches Amazon's zoom floor; below this anything looks bad on modern high-DPI screens).
  - **Maximum file size:** 10 MB per photo. **Maximum dimensions:** 25 megapixels (≈ 5,000 × 5,000). Above either, reject (matches Shopify's cap; defends against phone camera-RAW uploads).
  - **Per-product cap:** ≤ 10 photos.
  - Aspect ratio is **not** enforced at upload — accept any orientation. The display contract handles cropping.

  *Server-side processing pipeline (every upload):*
  - **EXIF orientation honoured first**, then EXIF metadata stripped (privacy: phone photos carry GPS coordinates, device model, and exact timestamps). The orientation flag is baked into the actual pixels before stripping so phone photos never appear sideways on the storefront.
  - **Five derived sizes:** thumbnail ~200 px, listing card ~400–600 px, product page ~800–1,200 px, zoom ~2,000 px, **share-preview 1,200 × 630** (the Open Graph dimension used by WhatsApp / Twitter / Facebook when shoppers share a product link — high-traffic share channels in the Gulf).
  - **Three formats per size:** AVIF (quality 70), WebP (quality 75), JPEG fallback (quality 82). Documented sweet spots — higher is wasted bytes, lower starts showing artifacts.
  - **Original is retained on disk** so all derivatives can be re-generated later without re-upload. Useful when we change the crop ratio, swap the storage backend (BunnyCDN), or tune compression.
  - **Per-derivative dimensions stored alongside the photo record** so the storefront can emit explicit `width`/`height` on every rendered `<img>` (prevents layout shift, a Core Web Vitals signal).
  - **Public URL is descriptive**, not opaque — e.g., `/images/<tenant>/<product-slug>-<n>.<ext>`. Internal storage IDs remain separate from public URLs. Per Google Search Central, descriptive filenames are a documented image-search ranking signal.
  - **Duplicate detection by content fingerprint** (SHA hash of the original bytes) within the same product — same photo uploaded twice surfaces a friendly "this looks like the photo you uploaded earlier" prompt; operator chooses to keep or skip. Cross-product duplicates are not flagged (legitimate reuse case: same item across multiple listings).
  - **Graceful failure path:** if processing chokes on a corrupt or weird file, the operator sees a clear per-photo error and the rest of the upload batch continues. The product save itself never fails because of one bad photo.

  *Display ratio:*
  - Customer-facing site shows photos at **1:1 square at every size**, centre-cropped at display time. Original aspect ratio preserved on disk so the display contract can change later without re-upload (e.g., switching to 4:5 portrait if a fashion vertical demands it). Identical aspect ratio across the catalogue and within every product gallery — universal industry practice (Shopify, Amazon, Salla, Apple, IKEA all enforce one ratio at display, not upload).

  *Cover photo + reorder (per product):*
  - First photo in the library is the cover. Cover changes via **tap-to-promote** on any photo — a "Set as cover" action that works identically on mobile and desktop. Photos are also fully reorderable via **drag-and-drop** (long-press on phone, click-and-drag on desktop, with keyboard-accessible alternatives and a polite live-region announcing the new position for screen readers). Moving a photo to position 1 makes it the new cover automatically. Reverses the earlier deferral — owner asked for it during 1a.7.2 testing; the data layer already carries a `position` column, so the addition was UI + a `reorderProductImages` service / tRPC / MCP surface.

  *Drag-and-drop file upload:*
  - The photo library accepts files dragged from the operator's file manager onto the section. Mirrors the existing button-triggered picker — same client-side validation, same byte-upload routes, same audit trail. Page-navigation guard in place so a missed drop never accidentally navigates the browser away while uploads are in flight. Mixed payloads (file + URL) only upload the file. Phones don't surface a meaningful drag-from-file-system metaphor, so this is a desktop affordance — but the events are wired regardless.

  *Per-variant cover:*
  - Each variant can be assigned a single cover photo from the product's photo library. Empty falls back to the product's cover. Storage-style variants (capacity, RAM, etc.) typically leave it empty; visual variants (colour, finish) typically set it. Variant cover picker uses the **same tap-to-promote pattern** as the main library, for consistency.
  - Storage shape (photo-to-variant relationship) supports multiple photos per variant tomorrow without schema change; the v1 admin UI enforces 0-or-1.

  *Replace-in-place:*
  - "Replace this photo" admin action swaps a photo's underlying file while preserving the photo record's identity, position in the library, alt text, and any variant linkage. Beats the delete-then-reupload-and-rewire workflow. Re-runs the full processing pipeline on the new file (EXIF strip, multi-size derivation, dimension store, fingerprint refresh).

  *Optional bilingual alt text:*
  - `{ en, ar }` per photo. Not required; surfaced as a polite nudge ("add a description for screen readers and search engines"), not a wall.

  *Mobile-first upload UX:*
  - Tap to open device camera or library, multi-select, per-tile progress, tap-to-delete, tap-to-set-cover, tap-to-edit-alt-text, tap-to-replace. No drag interactions on phone.

  *Storage lifecycle:*
  - Soft-deleted product → photos remain on disk, hidden in admin (matches the 30-day product recovery window from 1a.3).
  - Hard-purge product (post 30-day window, owner-only operation per 1a.3) → photo files **and** all derivatives deleted from disk in the same operation, otherwise disk fills over time. Disk-deletion failures are logged and retried, never block the product purge.

  *Service layer:*
  - `uploadProductImage`, `replaceProductImage`, `deleteProductImage`, `setProductCoverImage`, `setVariantCoverImage`, `setProductImageAltText` services per §2 (Zod-validated, audit-logged, tenant-scoped). Each gets a corresponding tRPC procedure and MCP tool. Destructive mutations (`deleteProductImage`, `replaceProductImage` since it overwrites the underlying file) require `confirm: true` on the MCP surface per §6.

  *Sub-chunks:*
  - **1a.7.1** services + tRPC + MCP, no UI. Includes the full processing pipeline (validation, EXIF strip + rotation, multi-size + multi-format derivation, dimension store, descriptive public URLs, duplicate detection, graceful failure path, storage cleanup on hard-purge).
  - **1a.7.2** admin upload UI on the product edit page (library grid, multi-upload, cover selection, alt-text editing, replace-in-place, delete).
  - **1a.7.3** per-variant cover assignment + mobile polish + e2e coverage in both locales on mobile viewport.

  *Explicitly deferred to later phases (do not build now):*
  - **Per-variant photo *galleries*** (multiple photos per variant, not just a single cover). Foundation supports this without schema change. Revisit when the catalogue includes apparel / accessories where colour-specific photo sets are genuinely needed (the Amazon / AliExpress model). Single cover-per-variant covers ~90% of small Gulf catalogues; demand evidence (30,000+ WooCommerce stores using free per-variant-gallery plugins, multiple Shopify add-ons surviving at $8–$20/month) confirms this is mostly a fashion/apparel concern. Likely lands in a post-launch polish chunk alongside the bilingual badge.
  - **In-app cropping or rotation tool.** Operators crop in their phone's native camera before upload; the centre-crop display contract handles the rest.
  - **AI background removal.**
  - **Video uploads, 360° spin, 3D product views.** When added, short product clips (≤30s, served as-is in HTML5 `<video>`) can ride the same storage adapter built in 1a.7 with no new infrastructure. Longer-form or higher-quality video would adopt BunnyCDN Stream (same vendor, separate service, handles transcoding + adaptive bitrate streaming). Either path keeps storage and CDN under one vendor relationship.
  - **Bulk import** (CSV manifest, URL ingest, FTP).
  - ~~**Drag-and-drop reordering on desktop.**~~ **Built in 1a.7.2 same-day follow-up (2026-05-02).** Owner reversed the deferral once the photo screens were live. Drag-reorder works on phone (long-press) and desktop (click-and-drag), with keyboard fallback and screen-reader announcements; moving a photo to position 1 makes it the new cover. See the *Cover photo + reorder* block above.
  - **Image moderation / NSFW detection.** Pointless for a controlled, owner-only catalogue.
  - **AI-generated bilingual alt text on upload** (Claude vision). This belongs to the AI-assisted bilingual entry workstream below, not the image pipeline chunk. Sequencing decided at the time the AI assist panel is scoped — it can land before or after 1a.7. The 1a.7 admin UI ships with a manual alt-text field that the AI assist will later auto-populate.
  - **Public CDN delivery (BunnyCDN Pull Zone).** The customer-facing CDN edge is provisioned at the top of Phase 1b's Launch infrastructure block — that's when public traffic begins. The 1a.7 storage adapter already supports the BunnyCDN Storage backend, so the Phase 1b switch is config-only (point production at the prod Storage Zone, attach a Pull Zone in front of it). Until launch, dev/test runs against the local-disk backend and serves files directly via `next/image`.

*AI-assisted bilingual entry*
- Admin product form has an "AI assist" panel:
  - One paragraph of input in **either** Arabic or English → auto-generate title, description, SEO title, SEO meta description, suggested category, suggested tags, **and the other-language translation**. Bilingual generation is mandatory, not optional.
  - Image upload → AI-generated alt text (Claude vision) in both `ar` and `en`
  - Optional: upload a product manual or spec sheet → AI extracts structured specs in both locales
- Arabic output is system-prompted to read natively (not machine-translated feel); the held-out Arabic evaluation set is begun in this phase and refined in Phase 3
- All AI assists are editable; nothing is auto-published without owner confirmation

*MCP surface for catalog (cumulative with the per-chunk tools above)*
- MCP tools live: `create_product` (done in Phase 0 chunk 7), `list_products`, `update_product`, `delete_product`, `restore_product`, `hard_delete_expired_products`, `search_products`, `get_product`, `set_product_categories`, `list_categories`, `create_category`, `update_category`, `delete_category`, `restore_category`, `hard_delete_expired_categories`, `set_product_options`, `set_product_variants`
- Tools accept and return bilingual fields; owner can drive product entry from Claude Desktop in either language

**Exit criteria:** The owner can add a fully bilingual product (`ar` + `en` content, images with alt text in both languages) via the admin UI **or** via Claude Desktop, and verify it via tRPC and MCP tool calls. No public storefront yet. **Playwright coverage: admin product CRUD with bilingual content entry; AI assist panel happy path in both directions (`ar`→`en` and `en`→`ar`). All on mobile viewport. Local checks (lint, typecheck, vitest, Playwright, coverage lint) green — hosted CI enforcement does not exist yet; it lands in the Launch infrastructure block at the top of Phase 1b.** *(The missing-translation badge that was originally part of 1a.6's exit was deferred 2026-05-02 — see the 1a.6 entry above.)*

---

### Phase 1b — Public bilingual storefront (shippable as a browse-only site)

**Goal:** The main tenant's domain is live, publicly indexable, and browseable in both Arabic and English from day one. Customers can find and view products in their preferred language with proper RTL layout; they cannot buy yet. This phase also delivers the production infrastructure that Phase 0 deferred: host, CI, CDN, error monitoring, and backups.

**Work:**

*Launch infrastructure (deferred from Phase 0 — must land before the public URL goes live)*

This is the first time the project touches production hosting. It is delivered as one coordinated pass so the public URL can be brought up with all guardrails in place simultaneously; nothing ships to a real domain before this block closes.

- Hetzner Cloud VM provisioned (CCX or CPX class, Ubuntu LTS)
- Coolify installed and configured
- Postgres, Redis, Meilisearch running as Coolify-managed services (parity with the local Docker Compose stack). PgBouncer (if introduced) configured with `pool_mode = transaction | session` — statement-mode pooling breaks RLS and is a hard-refuse
- BunnyCDN Storage Zone (production bucket) + Pull Zone created. The 1a.7 storage adapter already supports the BunnyCDN Storage backend, so this is provisioning + env config — no code change.
- Mailpit container running in Coolify for staging email preview (local dev continues to use Docker Compose)
- GitHub repo wired to GitHub Actions → Coolify deploy webhook
- GitHub Actions workflow, fails-closed: `lint → typecheck → vitest → playwright → lighthouse-ci → check-e2e-coverage → check-role-invariants → deploy webhook`
- Lighthouse CI enforcing mobile perf budgets on every build — red → no deploy
- `check:e2e-coverage` extended to cover MCP mutations (currently tRPC-only) so every transport's writes are forced to carry a Playwright test
- AST-level lint: `throw APIError` in a BA `hooks.before` must be preceded by an inline `writeAuditInOwnTx`; `after`-shape closed-set lint for `auth.*` operations (≤3 keys, structural-only)
- Env management + secrets in Coolify. CI env-lint rejects any test-only switch in production values (`APP_ENV=e2e|seed`, `E2E_AUTH_RATE_LIMIT_DISABLED=1`, `MCP_RUN_SQL_ENABLED=1`) and asserts Better Auth's internal rate-limiter stays disabled (our Redis sliding-window is authoritative)
- Sentry project wired up with a `beforeSend` scrubber that strips customer identifiers, PAT plaintext/hash, and captured React-component props. Builds on the Phase 0 error-log scrubbing pass so the scrubber is the last line of defense, not the only one
- Nightly `pg_dump` → Hetzner Storage Box with restore drill documented
- Basic health check / uptime monitoring
- Coolify GitHub PAT wired for auto-deploy on green CI

*Public storefront pages*
- Home (featured products, categories)
- Category listing with filters (brand, price range, option facets)
- Product detail page (variant selector, gallery, specs, related products). Gallery is a swipe carousel with visible thumbnails (not dot indicators — Baymard found 76% of mobile sites use dots-only and shoppers regularly miss photos). Pinch-to-zoom is table stakes; tap-to-zoom-overlay is the fallback. Variant switching swaps the cover photo using the per-variant cover assignment from 1a.7; the rest of the gallery stays the same in v1 (per-variant galleries are deferred — see 1a.7).
- Search (Meilisearch-powered, with Arabic tokenization tuned: stop words, normalization of ا/أ/إ, ة/ه, ي/ى)
- Basic static pages (about, contact)
- Mobile-first responsive design (see NFRs in section 6)
- **Image rendering hygiene** (consumes the data 1a.7 produces): explicit `width`/`height` on every rendered `<img>` (CLS prevention — Core Web Vitals signal); `fetchpriority="high"` on the hero / above-the-fold product image; `loading="lazy"` on every subsequent gallery image; `srcset` with the size set produced by 1a.7's pipeline so browsers fetch the right size for the device (high-DPI mobile gets the 1,200 px version; low-DPI gets the 600 px version).

*Bilingual launch surface*
- All seed products (20–30 realistic AV products across 2–3 categories) carry both `ar` and `en` content from launch
- Locale switcher component
- `hreflang` tags emitted on every public page (`ar-SA`, `en-SA`, `x-default`)
- Per-locale Arabic-friendly slugs supported (e.g., `/ar/products/سوني-a7iv`)
- RTL audit pass across every built public page
- Arabic typography (IBM Plex Sans Arabic or Tajawal) and Latin (Inter) loaded via `next/font`, aggressively subset

*SEO*
- `generateMetadata` with per-locale titles, descriptions, OG tags. Product pages emit a 1,200 × 630 OG image referencing the share-preview derivative produced by 1a.7's pipeline so shared product links render correctly on WhatsApp / Twitter / Facebook (high-traffic share channels in the Gulf, especially WhatsApp).
- JSON-LD: `Product` (with the photo library populated into the `image` array — required for Google's rich product cards in search), `Offer`, `BreadcrumbList`, `Organization`
- Sitemaps per tenant per locale, referenced in `robots.txt`
- Canonical URLs (critical when the same product lives under multiple categories)
- Image sitemaps (AV is visual) — entries reference the descriptive public URLs produced by 1a.7

*Compliance & polish*
- Cookie consent banner (PDPL-ready)

**Exit criteria:** The main tenant's domain is live, publicly accessible, indexable in both languages, and shows real bilingual products with working variant selection. A monolingual Arabic shopper can discover, browse, and view a product entirely in Arabic with proper RTL layout and Arabic search. The owner can add a product via Claude Desktop and see it live on the site within seconds — in both languages. A shopper can find a product via Google in either language and view it — but cannot buy. **Playwright coverage: home, category listing (with filters), product detail (with variant selection), search. Tests run in both `en` and `ar` on mobile viewport; the `ar` tests assert RTL layout, real Arabic content rendering (not fallback), and Arabic search results. CI green including Lighthouse budgets.**

**Why ship this:** SEO takes weeks to build traction in **both** languages. Start the clock early on both, not just one. The bilingual seed catalog from Phase 1a makes this a launch, not a placeholder.

---

### Phase 2 — Commerce MVP + commerce MCP tools (FIRST REVENUE)

**Goal:** A shopper can complete a real purchase with real money — in Arabic or English. KSA only. The owner can manage orders via Claude.

**Work:**

*Commerce*
- Cart (persistent, guest-allowed, variant-aware)
- Guest checkout (email + KSA National Address format + phone with `+966` validation)
- Shipping zones + flat-rate / weight-based shipping rules
- VAT calculation (15% KSA)
- Moyasar integration: Mada, Visa/MC, Apple Pay
- Order creation + stock decrement (transactional — no overselling)
- Order confirmation email (Resend) + SMS (Unifonic) — bilingual templates rendered per the customer's locale preference at order time
- Basic admin order view (list, detail, mark as shipped/cancelled)
- Shipping integration stub (manual tracking number entry for now; carrier API later)
- Refund flow (admin-initiated, Moyasar refund API)
- Invoice PDF generation (ZATCA-schema-compliant data model, not yet submitted to ZATCA)

*MCP surface for commerce*
- MCP tools live: `list_orders`, `get_order`, `refund_order` (with `confirm: true`), `mark_order_shipped`, `adjust_inventory`, `get_inventory`, `search_customers`, `get_customer`

*First autonomous agents*
- **Daily digest agent** (cron): summarizes yesterday — new orders, revenue, top products, low stock, anomalies — and emails the owner. Implemented as a Claude tool-use loop calling the MCP server.
- **Stock watchdog agent** (cron, hourly): scans inventory, flags low-stock variants with velocity-based reorder suggestions.

**Exit criteria:** A real customer can place and pay for a real order in either language, get a localized confirmation, and the admin can fulfill it. First riyal earned. The owner receives a daily digest email and can refund/ship orders from Claude Desktop. **Playwright coverage: full cart → guest checkout → Moyasar test-card payment → order confirmation email (via Mailpit, asserted per locale: Arabic email for `ar` checkout, English email for `en` checkout) → admin marks shipped → customer sees shipped status. Refund flow end-to-end. All in both locales on mobile viewport.**

---

### Phase 3 — Bilingual AI hardening + RTL polish

**Goal:** Now that the platform launched bilingually in Phases 1b and 2, this phase hardens Arabic AI quality, matures the translation-management workflow, and runs a comprehensive RTL audit across everything built so far. This is polish, not launch — the launch already happened.

**Work:**
- Translation management UI in admin: review missing strings, accept AI-suggested translations, mark approved, see coverage per locale
- Comprehensive RTL audit and fixes across every page built through Phase 2 (storefront + checkout + admin + emails) — visual regression snapshots locked
- Arabic typography polish: Western numerals 0–9 for prices to match KSA banking UX, font weight pass, line-height tuning for mixed Arabic/Latin runs
- **Bilingual AI hardening:**
  - MCP tools accept and respond in Arabic (input language detection, response in same language)
  - Daily digest available in Arabic
  - AI content generation Arabic quality tuned and evaluated against a **held-out set of real AV product descriptions** — pass threshold defined and measured
  - System prompt tuning so Arabic output reads natively (not machine-translated feel)
  - Eval harness checked into the repo and runnable via `pnpm eval:ar`

**Exit criteria:** Arabic AI output passes the held-out eval set at the agreed threshold. The owner can run the store via Claude entirely in Arabic with native-feeling responses. Translation coverage UI shows ≥ 99% per locale across all UI strings. **Playwright coverage: every existing test continues to pass green in `ar` locale. Visual regression snapshots locked for RTL home, PDP, checkout, and admin. Translation management UI tested end-to-end.**

---

### Phase 4 — Accounts, Inventory, Admin v2

**Goal:** The business can run on the platform day-to-day, and the owner barely ever opens a dashboard.

**Work:**

*Accounts & ops*
- Better Auth: email/password + magic link + social (Google, Apple)
- User account area: profile, addresses, order history, reorder
- Wishlist
- Inventory management UI: stock levels per variant, low-stock alerts, stock adjustments with reason codes, stock movement history
- Admin dashboard v2: sales metrics, top products, low stock, abandoned carts overview
- Order fulfillment workflow: pending → paid → packed → shipped → delivered, with timestamps
- Discount codes (percentage / fixed, per-product / cart-wide, usage limits, expiry)
- Returns & refund workflow (customer-initiated request → admin approval → refund)
- Role-based admin: **fixed roles** (owner, staff, support) with predefined permission sets. A custom role + permission builder is Phase 7 (see §3.6) — every role gate in this phase must route through a single authorization contract per transport (tRPC: `requireRole`; MCP: `McpTool.authorize`) so the Phase 7 migration stays surgical.

*Admin-via-MCP coverage*
- The owner runs natural-language operations (sales analysis, revenue, inventory, customer lookups, discount creation, order management) through MCP clients (Claude Desktop / Claude Code) connected to the platform's MCP server using their personal access token. No in-app admin chat page is built.
- `run_sql_readonly` tool fully exposed (owner role only) for ad-hoc analytics: "show me average order value by category this quarter".
- Phase 4 work here is to make sure the MCP tool surface and personal-access-token UX are complete enough that this end-to-end workflow is comfortable from any MCP client.

*New autonomous agents*
- **Refund/fraud watcher:** flags unusual refund or chargeback patterns
- **SEO drift watcher:** Core Web Vitals + Search Console checks weekly, alerts on drops
- **Log triage:** daily Sentry summary with suggested root causes

**Exit criteria:** The owner can run the store without opening the admin dashboard for routine tasks. From an MCP client (Claude Desktop / Claude Code) connected to the platform's MCP server, answers to "how is the business doing" arrive in seconds. The agents catch the issues a human would otherwise miss. **Playwright coverage: signup → magic link (via Mailpit) → login → password reset (via Mailpit) → account profile → order history → reorder → discount code apply → return request → admin approval. All in both locales on mobile viewport. (The MCP-based admin workflow is exercised by MCP-mutation coverage and integration tests, not Playwright, since there is no in-app chat page to drive.)**

---

### Phase 5 — Second tenant launch + tenant-aware MCP

**Goal:** Sister company goes live on its own domain, its own catalog, its own branding, its own AI agents.

**Work:**
- Tenant onboarding flow (create tenant, assign domain, upload logo, theme tokens, locale defaults)
- Per-tenant theming (CSS variables driven by tenant config)
- Custom domain setup in Coolify/Traefik with auto-SSL
- Tenant-scoped admin (admins only see their tenant's data)
- Platform super-admin view for the owner to manage all tenants
- Separate Sentry projects per tenant
- Separate analytics properties per tenant
- Multi-tenant audit: re-verify RLS policies, adversarial isolation testing
- Separate Resend sender domains per tenant
- **Tenant-aware MCP:** personal access tokens scoped to tenant; super-admin tokens offer cross-tenant tools (`list_tenants`, `create_tenant`, cross-tenant analytics)
- Per-tenant daily digests and agent runs

**Exit criteria:** Both brands live on their own domains, fully isolated, fully branded, running from one codebase and one deploy. The owner can ask Claude "how did tenant A do vs tenant B last week" and get a real answer. **Playwright coverage: adversarial tenant isolation tests — tenant A user cannot see or mutate tenant B data via any surface (UI, tRPC, MCP). Per-tenant theming asserted via screenshot diff. Tenant-scoped token tests: an A-scoped token rejected on B-scoped operations.**

---

### Phase 6 — ZATCA e-invoicing

**Goal:** Legally compliant invoicing in KSA.

**Work:**
- Decide SDK vs direct ZATCA API (evaluate Wafeq, ClearTax, Zoho Books API, or direct integration)
- Invoice hash chain implementation
- QR code generation (Base64 TLV payload per ZATCA spec)
- Clearance (B2B) and reporting (B2C) integration
- Cryptographic signing (CSID / PCSID provisioning flow)
- Invoice storage and retrieval (6-year retention)
- Credit notes and debit notes
- Sandbox → production cutover plan
- MCP tools: `get_invoice`, `resubmit_invoice_to_zatca`, `list_invoices`

**Exit criteria:** Every sale produces a ZATCA-compliant invoice submitted to the Fatoora portal, with QR code printable on receipts. **Playwright coverage: checkout → invoice generated → QR code renders on receipt page → invoice PDF downloadable. Integration tests (Vitest) against the ZATCA sandbox for hash chain and signature correctness.**

---

### Phase 7 — Growth features + team scaling

**Goal:** Features that move the needle on conversion, AOV, and retention — plus the team-scaling features needed as the business grows beyond solo operation. The customer-facing AI assistant originally scoped here has been deferred (see §4 "Deferred") — this phase ships the non-AI growth features, the AI writing-assist features that don't depend on semantic retrieval, and a custom RBAC model for scaling the admin team.

**Work:**

*AI-assisted growth features (Claude text generation, no embeddings)*
- AI-generated abandoned cart emails (personalized copy per recovered cart, owner review before send)
- AI blog post drafting (SEO content marketing) with owner review
- Rule-based cross-sell / upsell recommendations (admin-curated "frequently bought together" mappings, plus simple category-based suggestions; semantic/vector-backed recommendations are deferred — see §4 "Deferred")

*Team & operations (custom RBAC)*
- **Custom role + permission builder.** Owner can define new roles per tenant and attach fine-grained permissions to each. Replaces the fixed owner/staff/support triad from Phase 4 with a data-driven model.
  - **Permission catalog** (seeded from code, not user-editable): every sensitive operation the platform exposes is a named permission (e.g., `tokens.view`, `tokens.create`, `tokens.revoke`, `products.create`, `orders.refund`, `inventory.adjust`, `run_sql_readonly`, etc.). Permissions are grouped by domain for UI.
  - **Roles table** (per-tenant, tenant-editable): name + description + ordered permission set. The three launch roles (owner, staff, support) are seeded as system roles and remain un-deletable; the owner can clone them into custom roles or create fresh ones.
  - **Memberships** reference a role (not a hardcoded role string), making "make this user a 'fulfillment clerk'" a one-click reassignment.
  - **Permission checks migrate from role-equals-X to permission-in-set.** Every gate in the codebase (tRPC procedures, MCP tool visibility, admin UI affordances) asks "does the caller hold permission Y?" rather than "is the caller role X?". The two authorization contracts introduced in Phase 0–6 (§3.6) — tRPC's `requireRole` and MCP's per-tool `authorize` hook — are the places that change.
  - **Audit log records the permission that authorized each operation**, not just the role, so forensics can answer "who had 'refund orders' when?" after the fact.
  - **MCP personal access tokens** become permission-scoped: minting a token selects a subset of the caller's current permissions (cannot widen beyond caller). Role-based scoping in Phase 0–6 upgrades transparently — a token minted with "staff role" migrates to the permission set that role held at mint time.
  - **Admin UI:** roles list, role editor (name + permissions checklist), membership-to-role reassignment, role deletion guard (cannot delete a role with active memberships).
  - **Super-admin** retains cross-tenant god-mode independent of per-tenant RBAC; a tenant owner cannot escalate themselves to super-admin.

*Other growth features*
- **BNPL:** Tabby and Tamara via Moyasar or direct
- **Nafath integration** (identity verification for high-value orders, B2B accounts, fraud-flagged orders) — see section 5
- **Reviews & ratings** with photo uploads, moderated (AI-assisted moderation)
- **Product bundles**
- **Newsletter + marketing opt-in** (PDPL-compliant double opt-in)
- **Blog / content marketing** (MDX or small CMS)
- **Gift cards** (if desired)
- **Loyalty points** (if desired)
- **Referral program**

**Exit criteria:** Abandoned cart recovery emails are AI-generated and measurably lifting recovered revenue. BNPL checkout works end-to-end. Nafath sandbox verification is integrated. Owner can create a custom role, assign permissions to it, attach a team member to that role, and have every authorization gate (web admin, MCP, personal access tokens) honor the new role immediately — with audit entries recording the permission that authorized each action. **Playwright coverage: BNPL checkout flow with Tabby/Tamara test mode; review submission with moderation; Nafath sandbox verification flow; custom-role create → permission assign → member assign → gated action succeeds → same action by different-role member blocked → audit shows permission name. All in both locales on mobile viewport.**

---

### Phase 8 — Hardening, scale, AI safety

**Goal:** Sleep well at night.

**Work:**

*Traditional hardening*
- Full observability: structured logs, metrics dashboards, alerting
- Load testing (k6 or Artillery)
- Performance pass: Core Web Vitals at p75 on mid-range Android over 4G
- Security audit: dependency scanning, OWASP top 10 review, rate limiting, WAF rules
- Disaster recovery drill: restore from backup, measure RTO
- Read replicas for Postgres if query load justifies it
- CDN cache tuning
- Database index tuning based on real query patterns

*AI safety*
- Cost monitoring and budget caps on Claude API, per agent and per tenant
- Output filtering and PII scrubbing in AI responses (owner-facing chat, admin responses, AI-generated content)
- Agent behavior audit (what tools were called, with what args, with what outcomes)
- Eval harness for AI content generation (factuality, tone, Arabic quality)
- (Customer-bot prompt-injection red-teaming is part of the deferred customer-bot work — see §4 "Deferred")

*PWA polish*
- Add-to-home-screen manifest
- Web push (iOS 16.4+ supported)
- Offline catalog browsing
- Service worker with sensible cache policy

---

### Deferred — revisit when revenue supports the operational cost

The following capabilities were scoped out of the phased roadmap as nice-to-haves. They add real ongoing cost (Claude API spend on high-volume customer traffic, Voyage API for embeddings, eval harness upkeep, adversarial test-set maintenance) and do not block first revenue. Ship the store without them, validate that the business generates revenue, and revisit once a profit signal justifies the operational overhead.

*Semantic search infrastructure*
- `pgvector` Postgres extension enabled (one-line migration; trivial to add when needed)
- Embedding columns on relevant tables (products, policies, FAQs, blog)
- Voyage AI (or alternative) embeddings pipeline triggered on content writes
- Backfill script to embed the existing catalog when turned on
- Decision point at revisit time: pgvector + Voyage vs. stronger Meilisearch tuning alone

*Customer-facing AI assistant*
- Embedded storefront chatbot (bilingual Arabic/English), streaming UI via Vercel AI SDK
- RAG grounded in catalog + policies + FAQ + blog (depends on the semantic-search infrastructure above, or Meilisearch-backed retrieval as a lighter alternative)
- Strictly scoped tools: `search_products`, `get_product`, `check_stock`, `get_my_order` (authenticated user only), `start_return`, `handoff_to_human` (WhatsApp Business)
- Hard-enforced server-side scoping — cannot see other users' data, cannot mutate beyond the current user's scope
- Per-session, per-IP, and per-authenticated-user rate limits; cost guardrails; output filtering for PII
- System prompt forbids hallucinating product specs — every factual claim grounded in retrieved context
- Adversarial prompt-injection test suite
- Full Playwright coverage of bot flows in both locales, mobile viewport

**When revisiting:** the first decision is whether to ship the bot on Meilisearch-backed retrieval (faster to land, weaker multilingual semantics) or to add pgvector + Voyage first for better Arabic/English semantic retrieval. Either path is roughly a phase of work. The design rules in §6.4, §9.2, and §9.4 that reference the customer bot apply when this work is revived; they are documented now so the principles persist.

**What is *not* deferred** and stays in the core roadmap: the MCP server and all operator tools (the owner runs admin workflows through MCP clients like Claude Desktop / Claude Code — no in-app admin chat page is built), AI-assisted bilingual product entry (Phase 1a), AI-generated abandoned cart emails and blog drafting (Phase 7), and all autonomous ops agents (Phase 2 onward). Those use Claude text generation and MCP tool-use, not embeddings.

---

## 5. Future-proofing for Nafath (design now, build later)

To make Phase 7's Nafath integration a drop-in rather than a refactor, Phase 0 bakes in:

1. `users.identity_verified` (boolean), `users.identity_verified_at` (timestamp), `users.identity_provider` (string)
2. A `verifications` table recording every verification event: provider, level, timestamp, expiry, metadata (encrypted)
3. Better Auth as the auth layer from day one (Nafath = adding a custom OIDC provider later)
4. Encrypted-at-rest storage for national ID (pgcrypto or app-level envelope encryption)
5. An abstract `IdentityVerificationService` interface — the only implementation in Phase 0–6 is a no-op — so that adding Nafath later is wiring, not plumbing.

---

## 6. Non-functional requirements

### 6.1 Performance (mobile-first, hard constraints)

- **p75 LCP < 2.5s** on mid-range Android over 4G, measured from KSA, for public catalog pages.
- **p75 INP < 200ms** on the same profile.
- **p75 CLS < 0.1.**
- JS bundle budget for public pages: **< 200 KB gzipped** on initial load (excluding images).
- Arabic and Latin fonts self-hosted via `next/font`, subset aggressively, `font-display: swap`.
- All public pages SSR/ISR; no client-only rendering for product/category pages.
- Images via `next/image` with explicit `sizes`, AVIF/WebP, blur placeholders, lazy below the fold.
- **Enforced automatically by Lighthouse CI in GitHub Actions.** A PR that regresses any budget above fails CI and blocks deploy. Not measured manually.

### 6.2 Mobile-first UX (hard rules from Phase 0)

- Design breakpoints start at **360px** and scale up. No "design for desktop then shrink."
- Bottom navigation on storefront mobile views (categories / search / cart / account); sticky CTA on product pages so "Add to cart" is always thumb-reachable.
- Touch targets **≥ 44×44px**. No hover-dependent UI anywhere — every hover state has a tap equivalent.
- Form UX: `inputmode` hints, `autocomplete` attributes, Arabic keyboard support, `+966` phone prefix built into the control.
- No layout shift — reserve space for images, async content, cart badge.
- Testing on real mid-range Android device before each phase exit, not just Chrome DevTools.

### 6.3 Availability & ops

- **Availability:** 99.5% at launch, 99.9% once the business depends on it.
- **Backups:** nightly full + WAL archiving; quarterly restore drill.
- **Security:** HTTPS everywhere, HSTS, CSP, rate limiting on auth + checkout, encrypted secrets, least-privilege DB users per service. **Hetzner volumes provisioned with LUKS encryption from day one. TLS required for all app↔Postgres connections (no plaintext on any network hop). Nightly `pg_dump` backups encrypted with `age` before upload to Hetzner Storage Box; the decryption key is stored separately from the backup destination.**
- **PDPL:** consent, export, deletion, audit log for sensitive field access.
- **Accessibility:** WCAG 2.1 AA for public storefront.

### 6.4 AI-specific NFRs

- **Latency:** owner-facing MCP calls complete in < 2s p95 for read tools.
- **Cost ceiling:** monthly Claude API spend capped per tenant with circuit breaker; alert at 80%.
- **Grounding** *(applies when customer bot is revived per §4 "Deferred")*: the customer bot must ground every factual claim in retrieved context; no free-form spec claims.
- **Safety** *(applies when customer bot is revived per §4 "Deferred")*: the customer bot cannot call mutation tools beyond the authenticated user's own scope.

### 6.5 Data classification & at-rest protection

Every stored field falls into one of three tiers. The protection strategy follows from the tier — encryption is not applied uniformly because uniform encryption creates complexity without reducing real risk for fields the app must routinely decrypt.

**Tier A — Encrypted at the column level** (pgcrypto envelope encryption). The app holds a per-tenant data-encryption key (DEK) wrapped by a key-encryption key (KEK) loaded from env at boot; the wrapped DEK lives in the DB, the KEK never does. Reads are audit-logged (see §3.7).
- National ID numbers (when Nafath lands in Phase 7)
- Raw identity verification payloads
- Stored payment tokens not handled by Moyasar (rare; most card data never touches our DB)
- Any future field carrying regulator-defined PII

**Tier B — Access-controlled, not encrypted at column level.** Encryption would not help: the app must decrypt routinely to display in admin, so the keys would have to live where the app lives — meaning anyone who pops the app gets the data anyway. Protection is role-gated output schemas in the service layer (§3.7), strict tenant scoping (§3.1, §5), and RLS as defense in depth.
- Cost prices and supplier-side pricing
- Internal product notes / supplier notes
- Customer PII visible to staff (email, phone, shipping address)
- Order-level internal annotations

**Tier C — Public.** No special protection beyond standard tenant scoping.
- Product names, descriptions, retail prices, images
- Public order status

**Cross-cutting at-rest protections that apply to all tiers** (per §6.3): Hetzner LUKS volume encryption, TLS to Postgres, encrypted nightly backups with the key stored separately from the backup destination. These exist so disk theft, network snooping, and backup leaks do not bypass the tiered controls above — they are defense in depth, not a substitute for the tier-specific controls.

---

## 7. Open questions / decisions deferred

- **ZATCA provider:** SDK vs direct API — decide at start of Phase 6.
- **Shipping carriers:** SMSA vs Aramex vs Naqel vs SPL — decide during Phase 2 based on business relationships.
- **B2B features:** do either tenant sell to businesses (tax-exempt, quotes, purchase orders, net-30 terms)? If yes, this is a meaningful Phase 4–5 addition.
- **Repair / service / installation:** AV companies often offer installation. Is this in scope? Would add a service-booking module.
- **Returns policy specifics:** KSA consumer protection law has specific rules — confirm with legal.
- **Vector search at all:** deferred to post-launch (§4 "Deferred"). The revisit decision is Meilisearch-only vs. pgvector + Voyage, driven by customer-bot reactivation.
- **PWA phase:** target Phase 8 for full PWA polish, but basic manifest + installability can arrive earlier if cheap.
- **Native mobile app:** React Native + Expo, deferred to "much later" (Phase 50, per user). The three decisions in section 3.8 ensure no refactor is required when the time comes.

---

## 8. What is explicitly NOT in scope (at least for now)

- Native mobile apps — deferred. Web is mobile-first; PWA fills the gap. Architecture in section 3.8 keeps a native app as a future drop-in.
- Marketplace model (third-party sellers)
- Subscriptions / recurring billing
- Live chat with humans (at launch, customers reach the owner via WhatsApp Business directly; the deferred customer bot in §4 "Deferred" will add AI-triaged handoff when revived)
- Custom ERP integrations (we are the ERP)
- International shipping outside Gulf

---

## 9. AI risk & cost controls

AI is first-class, which means its failure modes are first-class too. These controls are designed in from Phase 0, not bolted on later.

### 9.1 Cost controls

- **Model routing:** Haiku for classification, routing, and simple extraction. Sonnet for reasoning, content generation, and agent tool loops. Opus only for complex multi-step agent work.
- **Prompt caching** enabled for long system prompts and RAG context.
- **Per-tenant monthly budget cap** on Claude API spend, with circuit breaker that disables non-essential AI features when hit.
- **Alert at 80%** of cap to the owner via the daily digest.
- **Customer bot rate limits:** per-session, per-IP, per-authenticated-user.
- **Response caching:** identical customer queries within a short window return cached answers.

### 9.2 Prompt injection & safety (customer bot)

*These rules apply when the customer bot is revived per §4 "Deferred". They are documented here so the design principles persist and do not need to be re-derived.*

- Tools are **hard-scoped server-side** to the authenticated user's own data. Prompt cannot widen scope.
- **Never trust model output as a tool argument selector alone** — always validate against the authenticated user's permissions and the tool's Zod schema.
- Output filtering: strip anything that looks like a token, email, phone, national ID, or order from another user.
- System prompt explicitly forbids role-playing, instructions in user content, and "ignore previous instructions" style prompts.
- Adversarial test suite maintained from Phase 7 onward.

### 9.3 AI mistakes in writes (operator MCP)

- Destructive tools (`delete_*`, `bulk_update_*`, `refund_order` above threshold) require `confirm: true`.
- Dry-run mode for bulk operations returns a preview without executing.
- Complete audit log of every tool call with before/after state.
- Soft deletes for catalog entities (products, categories) with a recovery window.
- Financial operations (refunds, discounts over a threshold) require a second confirmation step even from the owner.

### 9.4 Hallucination in customer-facing content

- Customer bot is **strictly RAG-grounded.** System prompt forbids stating any spec, price, or availability that isn't in the retrieved context.
- AI-generated product copy, blog posts, and abandoned cart emails all require owner review before publishing/sending (no auto-publish).
- Eval harness (Phase 8) checks AI-generated Arabic against a held-out reference set.

### 9.5 Token security

- Personal access tokens are tenant- and role-scoped, short-lived, revocable.
- Tokens are never logged.
- Token rotation is one click in admin.
- Rate limit per token.
- All MCP calls audit-logged with token ID (not token value).
