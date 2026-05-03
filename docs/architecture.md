# Architecture

Tech stack and architectural decisions. Read when designing or making non-trivial structural choices. The "what we're building and why" lives in `prd.md`; the day-to-day rules live in `CLAUDE.md`.

---

## 1. Runtime & repo

- **Package manager:** pnpm. Never `npm` or `yarn`.
- **Node:** 22.x LTS, pinned in `.nvmrc` and `package.json > engines`.
- **Repo:** single Next.js app at the root, not a monorepo. Monorepo split is deferred to a hypothetical native-mobile phase.
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
  - `scripts/` — CI helpers
- **Environments:** `local` → `staging` → `production`. Destructive AI tools and new agents are exercised against staging before production.
- **Git workflow:** push to main; CI gates deploy. No feature-branch PR process. Never bypass hooks.

## 2. Tech stack (locked)

### Application

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router) + TypeScript strict |
| Styling | Tailwind + shadcn/ui (logical properties for RTL) |
| API | tRPC + React Query (typed, RN-ready) |
| ORM | Drizzle (SQL-first, RLS-friendly) |
| Validation | Zod (source of truth for types, MCP tools, API contracts) |
| Database | PostgreSQL 16, self-hosted on Hetzner |
| Auth | Better Auth + bearer-token plugin (cookies for web, tokens for mobile) |
| Cache / queues | Redis (or Dragonfly) + BullMQ |
| Search | Meilisearch (Arabic tokenization, self-hosted) |
| Media | BunnyCDN Storage + Pull Zone (Gulf POPs, ~1/10th the cost) |
| Payments KSA | Moyasar (Mada + Visa/MC + Apple Pay + Tabby/Tamara) |
| Payments intl | Stripe (fallback) |
| Email | Resend (per-tenant sender domains) |
| SMS / OTP | Unifonic (KSA-based) |

### AI

| Layer | Choice |
|---|---|
| Model provider | Anthropic Claude API |
| Server SDK | `@anthropic-ai/sdk` |
| Client streaming | Vercel AI SDK (only for the deferred customer bot — owner admin chat is via MCP clients, not in-app) |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript) |
| Agent orchestration | Plain Claude tool-use loops (no LangChain) |

### Platform & ops

| Layer | Choice |
|---|---|
| PaaS | Coolify on Hetzner (self-hosted "Vercel") |
| Reverse proxy | Traefik (bundled with Coolify) |
| Observability | Sentry SaaS free tier |
| Analytics | Plausible (self-hosted) + GA4 |
| Backups | `pg_dump` → Hetzner Storage Box, encrypted with `age` |
| CI/CD | GitHub Actions → Coolify webhook (no red-to-prod path) |

### Testing

| Layer | Choice |
|---|---|
| E2E | Playwright + TypeScript (mobile-first projects, locale-parameterized) |
| Accessibility | `@axe-core/playwright` (asserted on key pages) |
| Email tests | Mailpit (real captured emails clicked through) |
| Performance | Lighthouse CI (mobile budgets enforced; red → no deploy) |
| Visual regression | Playwright screenshot diff |
| Unit / integration | Vitest |

**Explicitly rejected:** Vercel/Supabase/Clerk (not self-hosted), Prisma (worse RLS story than Drizzle), Elasticsearch/Algolia (overkill or not self-hosted), LangChain/LangGraph (too opaque for vibe coding), microservices (start monolith, split only if needed).

## 3. Multi-tenancy

- **Model:** single database, shared schema, `tenant_id` column on every tenant-scoped table, enforced via Postgres RLS.
- **Tenant resolution:** request → `Host` header in middleware → tenant lookup by domain → `tenantId` attached to request context → all DB queries scoped automatically.
- **Why custom domain per tenant** (not subdomains): brand SEO and trust.
- **Why not schema-per-tenant:** operationally painful, migrations get weird, overkill for 2–3 tenants.
- **Never accept `tenantId` from user input.** Read it from the resolution middleware. RLS is the safety net; application-layer scoping is primary.

## 4. Internationalization

- **Locales at launch:** `en` and `ar`. Architecture must not assume two.
- **Routing:** `/{locale}/...`. Root `/` redirects on `Accept-Language` with a manual override cookie.
- **Translatable content model:** JSONB `{ en, ar }` at the column level (e.g., `product.name`). Simpler than a separate translations table.
- **RTL:** `dir` attribute driven by locale. Tailwind logical properties (`ps-4`, `ms-auto`, `start-0`). No `left`/`right` in component code.
- **Typography:** IBM Plex Sans Arabic or Tajawal (Arabic), Inter (Latin), via `next/font`, aggressively subset.
- **Arabic slugs** allowed: `/ar/products/سوني-a7iv`. Per-locale slug.
- **hreflang:** `ar-SA`, `en-SA`, `x-default` on every public page.
- **Fallback policy:** missing field in requested locale → public storefront silently falls back to the other locale; admin surfaces a missing-translation badge. Fallback is a safety net for individual fields, not a launch strategy.

## 5. Product variants

Catalog model from day one. Industry-standard option-driven variants. The platform fixes the *shape*; merchants define the *content* (no preset specs, no preset filters).

- **Product** — parent concept (camera model, perfume line, speaker family).
- **ProductOption** — axis of variation defined by merchant on a specific product (e.g., "Colour", "Storage").
- **ProductOptionValue** — value on an axis (e.g., "Black", "256GB").
- **ProductVariant** — a specific combination, carrying its own SKU, price (base + sale), stock, weight/dimensions, optional cover image (drawn from the product's photo library), barcode/EAN.
- **Default variant** every product has one; no-options product = one-variant product. Avoids branching everywhere.
- **Caps:** ≤ 3 option types per product, ≤ 100 variants per product. Matches Shopify/Amazon. Past those, merchant splits products.
- **Variants vs specifications:** a variant is something the customer picks at purchase (own price/stock/SKU). A specification is a fixed product fact, optionally a catalogue filter. Specifications are a separate later chunk.

Cart and orders reference variants, not products.

## 6. SEO foundation

Baked in from Phase 0:
- SSR/ISR for all public pages (no client-only product/category rendering)
- `generateMetadata` per-locale (titles, descriptions, OG tags)
- JSON-LD: `Product`, `Offer`, `AggregateRating`, `BreadcrumbList`, `Organization`
- Sitemaps per tenant per locale, in `robots.txt`
- Canonical URLs (critical when same product lives under multiple categories)
- Image sitemaps
- 301 redirects on slug changes (admin-managed redirect table)

## 7. Compliance foundations

- **PDPL:** cookie consent, data export, data deletion, audit log for sensitive field access. Raw national IDs (Nafath) stored encrypted at rest.
- **ZATCA:** invoice schema designed from day one with all required fields (seller/buyer VAT, hash chain, QR code payload). API integration is a later phase; data model is foundational.
- **VAT:** 15% KSA, 5% UAE — region-aware tax engine from the start.

## 8. Tenancy & auth interaction

- Users belong to the platform, not a tenant. A single user can have accounts across multiple tenant storefronts (sister-company customers shop both brands).
- Admin users belong to a tenant with a role. **Launch roles are fixed** (owner / staff / support) with predefined permission sets. A custom role + permission builder lands later; until then, all gates route through one authorization contract per transport (`requireRole` on tRPC, `McpTool.authorize` on MCP) so the future migration is surgical.
- A super-admin role exists for platform operators.
- **Transactional email links are tenant-aware.** Magic link, password reset, email verification, order confirmation — all built against the tenant's own domain, not a shared one. Email sender identity (From, DKIM) is per-tenant via Resend domains.

## 9. AI-first architecture

The most important architectural decision in the document: a **single typed service layer** exposed through three transports.

```
                   ┌── Admin UI (tRPC / RSC)
Service layer ─────┼── MCP server (Claude Desktop / Code / agents)
                   └── Internal jobs & cron (direct imports)
```

Every write (`createProduct`, `updateInventory`, `refundOrder`, …) lives in **one place** as a typed function with Zod input/output schemas. The admin UI, MCP server, and background jobs all call the same function. Adding a capability = one service function + one line in the MCP registry + one tRPC procedure.

### Service layer rules

- Every service function: Zod input, Zod output, tenant-context-aware impl, audit log on write (via middleware).
- **Destructive ops** (`delete_*`, `bulk_update_*`, refunds above threshold) require explicit `confirm: true`.
- **Expensive / irreversible ops** support `dryRun: true`.
- No transport concerns inside services (no `req`/`res`, no HTTP status codes). Throw typed errors; transport adapters translate.
- **Tier-B fields** (cost prices, supplier notes — see standards.md) require role-gated output schemas. The schema, not the caller, is the gate.

### MCP server

- Self-hosted alongside Next.js (same deploy, separate route).
- Tools auto-derived from service Zod schemas.
- Auth via Better Auth personal access tokens, scoped by tenant + role; revocable, rotatable, rate-limited, audit-logged.
- Tool set is **role-filtered** (staff sees fewer tools than owner; support sees only returns/refunds).
- Super-admin tokens have cross-tenant tools.
- `run_sql_readonly` (sandboxed, row-limited, parameterized, no DDL) available to owner-role tokens. Every query logged.

### Audit log

- Every service write logged: actor type/id, token id (if any), tenant, operation, input, before/after, outcome, timestamp, correlation id.
- **Tier-A reads are audit-logged** (national IDs, verification payloads — see standards.md). Tier-B and Tier-C reads are not (would drown the log).
- Append-only, tenant-scoped, retained per PDPL.
- Exposed as a read-only MCP tool (`search_audit_log`) so the owner can ask "who changed price on product X?" in natural language.

### Autonomous ops agents

Cron-triggered Claude tool-use loops calling MCP. They report; they never auto-execute destructive actions without human confirmation.

- Daily digest (yesterday's sales, anomalies, stock alerts)
- Stock watchdog (low stock, velocity-based reorder suggestions)
- Refund/fraud watcher
- SEO drift watcher (Core Web Vitals + Search Console)
- Log triage (daily Sentry summary with suggested root causes)
- Backup verifier (weekly test restore)

## 10. Client-agnostic API layer (web today, mobile later)

Three decisions make a future native app a drop-in rather than a refactor:

1. **tRPC + React Query as primary transport.** End-to-end TypeScript, native RN support via `@trpc/react-query`. Web uses it; future RN imports the same client.
2. **Better Auth bearer-token plugin enabled from day one.** Web uses HTTP-only cookies (CSRF protection); mobile uses `Authorization: Bearer`. Same backend, no migration. Refresh-token rotation and per-device sessions on from start.
3. **All transactional surfaces behind tRPC, not embedded in pages.** Browse, cart, checkout, order tracking, returns, account — all tRPC procedures. Next.js pages are thin consumers.

**PWA first:** before a native app, ship a PWA (add-to-home-screen, push, offline catalog, Apple Pay in Safari). For Gulf AV e-commerce, likely covers 85–90% of native-app value at 5% of the cost.

## 11. Testing philosophy

The non-negotiable rule lives in `CLAUDE.md` Section 1. Summary: every user-facing change ships with a Playwright test covering the full flow in both locales on mobile viewport, in CI green, before being considered done.

Three independent enforcement mechanisms:

1. `CLAUDE.md` operational rule (Claude Code reads automatically).
2. CI gate (GitHub Actions: lint → typecheck → vitest → playwright → lighthouse → coverage → role-invariants → deploy webhook). No red-to-prod path.
3. Coverage lint (`scripts/check-e2e-coverage.ts`) enumerates routes + tRPC mutations and asserts each has a referencing Playwright test. Unforgeable.

## 12. Future-proofing for Nafath (design now, build later)

To make Nafath integration a drop-in:

1. `users.identity_verified` (boolean), `users.identity_verified_at`, `users.identity_provider` columns.
2. A `verifications` table recording every verification event: provider, level, timestamp, expiry, encrypted metadata.
3. Better Auth as the auth layer (Nafath = adding a custom OIDC provider later).
4. Encrypted-at-rest storage for national ID (pgcrypto or app-level envelope encryption).
5. An abstract `IdentityVerificationService` interface — only impl until Nafath lands is a no-op — so adding Nafath later is wiring, not plumbing.
