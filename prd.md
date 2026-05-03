# Product Requirements — ecom-ruq

**Owner:** Bassel
**Last updated:** 2026-05-04

This is the canonical "what we're building, why, and what's next" document. Read this every session.

**Session start checklist:**
1. Read this file (vision + current state + phased plan).
2. The next thing to build is **the first phase below not marked ✅ Done**.
3. Read `CLAUDE.md` for operational rules.
4. Open `docs/decisions.md`, `docs/architecture.md`, or `docs/standards.md` only if relevant to the chunk you're about to start.

---

## 1. Vision

A modern, SEO-optimized, **AI-native** e-commerce platform for an audio/visual products company, serving customers primarily in the Kingdom of Saudi Arabia and the wider Gulf. The platform supports **two storefronts at launch** (the main brand and a sister company), each on its **own custom domain**, with the architecture ready to onboard a third tenant later.

The platform is the **source of truth** for products, inventory, and orders — there is no upstream ERP. It must be reliable enough to run the business, not just front-end another system.

"AI-native" is a first-class requirement: the owner must be able to manage the store and ask business questions in natural language from day zero. The architecture is shaped around a typed service layer exposed uniformly to the UI, to MCP, and (later) to native mobile clients.

## 2. Target market

- **Primary geography:** Saudi Arabia, with Gulf expansion (UAE first).
- **Languages:** Arabic (RTL, dominant in KSA) and English. URL structure, search, and SEO must be first-class for both.
- **Devices:** mobile-dominant, often mid-range Android. **Mobile-first UX is non-negotiable** — desktop is an afterthought.
- **Currency:** SAR primary at launch; AED when UAE opens.
- **Payments:** Mada (essential), Apple Pay (essential in Gulf), Visa/MC, BNPL via Tabby/Tamara (near-essential for mid-to-high ticket AV items).

## 3. Constraints that shape every decision

- **Solo development** with Claude Code as the primary implementation partner. Tech choices favor well-typed, schema-first, conventional setups an AI agent can reason about. No clever/magical abstractions.
- **Near-zero ops burden on the owner.** Infrastructure, deployments, monitoring, and routine store ops should be automatable by AI agents and accessible via natural language. The owner does not want to configure things by hand or open dashboards to answer routine questions.
- **Self-hosted on Hetzner.** We accept the Europe-Gulf latency trade-off and mitigate aggressively with a CDN that has Gulf POPs.
- **Budget-conscious but not bootstrapped.** SaaS where self-hosting creates disproportionate ops burden (Sentry, Resend, Moyasar, Claude API); self-host the rest.
- **Compliance:** KSA's ZATCA e-invoicing (Phase 2 / Fatoora) and PDPL (personal data protection) are non-negotiable for operating legally in KSA.

## 4. Differentiators

- True multi-tenant — custom domain per brand, isolated catalog, shared codebase
- Bilingual Arabic/English with real RTL, not translated-and-hoped-for-the-best
- Gulf-native payments and shipping from day one
- Variant-based catalog (pick size, color, storage — price and stock per variant)
- SEO-first architecture (SSR/ISR, structured data, hreflang, Arabic-friendly slugs)
- **AI-native from day zero:** natural-language store management via MCP, AI-assisted product entry, autonomous ops agents reducing manual work toward zero. A customer-facing AI assistant is deferred — see `docs/decisions.md`.
- **Client-agnostic API layer:** web today, native mobile later, with no refactor required.

## 5. Current state (2026-05-04)

- **Phase 0 — Foundation:** ✅ Done.
- **Phase 1 — Catalog backbone + bilingual AI product entry:** ✅ Done.
- **Next: Phase 2 — Storefront + commerce MVP** (local-only; no public launch).

For chunk-by-chunk landing history, see `git log` and `docs/runbooks/`.

---

## 6. Phased plan

Each phase ends with a clear deliverable. AI capabilities are woven into every phase, not deferred. Past phases are one-liners; current and upcoming phases carry full detail.

### Phase 0 — Foundation ✅ Done

Local-runnable foundation: Next.js + Drizzle schema, Better Auth (cookies + bearer), tenant resolution, RLS policies, tRPC, MCP server skeleton, audit log, Docker Compose stack, Playwright + Vitest harness, error-log scrubbing, boot-time production-safety guards. No production host yet — that lands in Phase 6.

### Phase 1 — Catalog backbone + bilingual AI product entry ✅ Done

The owner can create and manage fully bilingual products end-to-end via admin UI or Claude. Public storefront does not exist yet.

**Shipped:** admin product list, product edit with bilingual content, soft-delete + restore + owner-only purge, category management (single tree, depth ≤ 3, many-to-many products↔categories), variants foundation + admin UX (≤ 3 option types, ≤ 100 variants, set-replace semantics), image pipeline (swappable storage adapter, multi-size + multi-format derivation, EXIF strip, dedupe by fingerprint, replace-in-place, drag-reorder, drag-to-upload), AI-assisted bilingual entry panel.

The bilingual missing-translation badge was relocated from this phase to Phase 9 — see `docs/decisions.md`.

---

### Phase 2 — Storefront + commerce MVP (local-only, no public launch)

**Goal:** build the entire customer-facing storefront and commerce surface end-to-end in both languages, on a self-built mock payment provider. All work happens locally; no public deploy this phase.

**Why local-only:** real KSA revenue requires Moyasar (paperwork-gated by Saudi CR), ZATCA-compliant invoicing (Phase 4), and production hosting (Phase 6) ready together. A self-built mock provider lets the storefront and commerce surface be developed and de-risked locally. When Phase 5 wires Moyasar and Phase 6 stands up production, both are drop-in steps behind interfaces this phase ships.

#### Public storefront pages

- Home (featured products, categories)
- Category listing with filters (brand, price range, option facets)
- Product detail (variant selector, gallery, specs, related products). Gallery is a swipe carousel with visible thumbnails (not dot indicators — Baymard found 76% of mobile sites use dots-only and shoppers miss photos). Pinch-to-zoom is table stakes; tap-to-zoom-overlay is the fallback. Variant switching swaps the cover photo using the per-variant cover; the rest of the gallery stays the same in v1.
- Search (Meilisearch with Arabic tokenization tuned: stop words, normalization of ا/أ/إ, ة/ه, ي/ى)
- Static pages (about, contact)
- Mobile-first responsive design (see `docs/standards.md`)
- **Image rendering hygiene:** explicit `width`/`height` on every `<img>` (CLS prevention), `fetchpriority="high"` on hero, `loading="lazy"` on subsequent gallery images, `srcset` so browsers fetch the right size for the device.

#### Bilingual launch surface

- 20–30 realistic AV products carrying both `ar` and `en` from launch
- Locale switcher
- `hreflang` (`ar-SA`, `en-SA`, `x-default`) on every public page
- Per-locale Arabic-friendly slugs (`/ar/products/سوني-a7iv`)
- RTL audit pass across every public page
- Arabic typography (IBM Plex Sans Arabic or Tajawal) + Latin (Inter) via `next/font`, aggressively subset

#### SEO

- `generateMetadata` per-locale; product pages emit a 1,200 × 630 OG image so shared product links render correctly on WhatsApp / Twitter / Facebook
- JSON-LD: `Product` (with photo library populated into the `image` array — required for Google's rich product cards), `Offer`, `BreadcrumbList`, `Organization`
- Sitemaps per tenant per locale, in `robots.txt`
- Canonical URLs
- Image sitemaps

#### Commerce

- Cart (persistent, guest-allowed, variant-aware)
- Guest checkout (email + KSA National Address + `+966` phone validation)
- Shipping zones + flat-rate / weight-based rules
- VAT calculation (15% KSA)
- **Payment provider abstraction:** a single `PaymentProvider` interface (`createPayment`, `capturePayment`, `refundPayment`, `handleWebhook`, status normalization) behind one runtime registry — same pattern as the storage adapter from Phase 1. Moyasar (Phase 5), Stripe, Tabby, Tamara all become additional implementations.
- **Self-built mock payment provider** — the local "Mailpit equivalent" for payments. Completes the purchase flow against an in-process fake: no network calls, no real cards, deterministic outcomes selectable per checkout (success, declined, 3DS challenge, webhook delay). Runs identically in dev, e2e, and pre-launch staging.
- Order creation + transactional stock decrement (no overselling)
- Order confirmation email (Resend) + SMS (Unifonic), bilingual templates per customer locale
- Basic admin order view (list, detail, mark shipped/cancelled)
- Shipping integration stub (manual tracking number for now; carrier API later)
- Refund flow (admin-initiated against the mock; identical UI in Phase 5)
- Invoice PDF generation (ZATCA-schema-compliant data, not yet submitted — Phase 4)

#### Compliance & polish

- Cookie consent banner (PDPL-ready)

#### MCP surface for commerce

`list_orders`, `get_order`, `refund_order` (`confirm: true`), `mark_order_shipped`, `adjust_inventory`, `get_inventory`, `search_customers`, `get_customer`.

#### First autonomous agents

- **Daily digest** (cron): yesterday's new orders, revenue, top products, low stock, anomalies — emailed to owner. Claude tool-use loop calling MCP.
- **Stock watchdog** (cron, hourly): scans inventory, flags low-stock variants with velocity-based reorder suggestions.

**Exit:** locally, a shopper can browse the storefront in either language with proper RTL, complete a full purchase against the mock provider, get a localized bilingual confirmation, and the admin can fulfil or refund. Owner gets a daily digest and can refund/ship from Claude Desktop. **Playwright:** home, category (with filters), PDP (with variant selection), search; full cart → guest checkout → mock-payment success → order confirmation email (asserted per locale) → admin marks shipped → customer sees shipped status. Mock-payment failure paths covered (declined, 3DS challenge). Refund flow end-to-end. Both locales on mobile viewport. The `ar` tests assert RTL layout, real Arabic content (not fallback), and Arabic search results.

---

### Phase 3 — Accounts, inventory, admin v2

**Goal:** the business can run on the platform day-to-day, and the owner barely opens a dashboard.

#### Accounts & ops

- Better Auth: email/password + magic link + social (Google, Apple)
- User account area: profile, addresses, order history, reorder
- Wishlist
- Inventory management UI: stock per variant, low-stock alerts, stock adjustments with reason codes, movement history
- Admin dashboard v2: sales metrics, top products, low stock, abandoned carts overview
- Order fulfilment workflow: pending → paid → packed → shipped → delivered, with timestamps
- Discount codes (percentage / fixed, per-product / cart-wide, usage limits, expiry)
- Returns & refund workflow (customer-initiated request → admin approval → refund)
- Role-based admin: **fixed roles** (owner, staff, support). Custom role builder is Phase 7. All gates route through the single authorization contract per transport.

#### Admin-via-MCP coverage

- The owner runs natural-language operations (sales analysis, revenue, inventory, customer lookups, discount creation, order management) through MCP clients connected to the platform's MCP server. No in-app admin chat page is built.
- `run_sql_readonly` fully exposed (owner role only) for ad-hoc analytics: "average order value by category this quarter".
- Phase 3 work here is making the MCP tool surface and PAT UX comfortable enough that this end-to-end workflow feels good from any MCP client.

#### New autonomous agents

- **Refund/fraud watcher:** flags unusual refund or chargeback patterns
- **SEO drift watcher:** Core Web Vitals + Search Console weekly, alerts on drops
- **Log triage:** daily Sentry summary with suggested root causes

**Exit:** owner runs the store without opening admin for routine tasks. From an MCP client, "how is the business doing" answers in seconds. Agents catch what a human would miss. **Playwright:** signup → magic link (Mailpit) → login → password reset (Mailpit) → account profile → order history → reorder → discount code apply → return request → admin approval. Both locales on mobile viewport.

---

### Phase 4 — ZATCA e-invoicing

**Goal:** legally compliant invoicing in KSA, ready to switch on the moment Phase 5 wires real payments. ZATCA submission lands first because real KSA money cannot legally flow without it; finishing it before Moyasar means the Phase 5 cutover is a single coordinated release.

#### Work

- Decide SDK vs direct ZATCA API (evaluate Wafeq, ClearTax, Zoho Books API, or direct integration)
- Invoice hash chain implementation
- QR code generation (Base64 TLV payload per ZATCA spec)
- Clearance (B2B) and reporting (B2C) integration
- Cryptographic signing (CSID / PCSID provisioning flow)
- Invoice storage and retrieval (6-year retention)
- Credit notes and debit notes
- Sandbox → production cutover plan (executed when Phase 5 flips real Moyasar on)
- MCP tools: `get_invoice`, `resubmit_invoice_to_zatca`, `list_invoices`

**Exit:** mock-paid orders from Phase 2 produce ZATCA-compliant invoices submitted to the Fatoora **sandbox**. QR code on the receipt. Invoice PDF downloadable. Hash chain and signature correctness verified against sandbox. Production-ready behind an env flag — Phase 5 flips it to live submission.

---

### Phase 5 — KSA payments via Moyasar

**Goal:** wire the real Moyasar provider behind the Phase 2 abstraction, with ZATCA's submission path proven against the sandbox and ready to flip to production. All work is local / staging — no public deploy yet, so no real money flows. The "first riyal" milestone moves to Phase 6.

#### Work

- **Moyasar `PaymentProvider` implementation** behind the Phase 2 interface. Methods: Mada, Visa/MC, Apple Pay. Webhooks wired to the same `handleWebhook` contract the mock implements — the rest of the commerce surface does not change.
- Provider registry routes to `moyasar` in non-local environments; staging exercises real Moyasar sandbox end-to-end.
- Apple Pay domain verification with the Apple Developer account (against staging domain; production verification waits for Phase 6).
- Refund flow validated against Moyasar's sandbox refund — same admin UI as Phase 2, same `refundPayment` contract.
- ZATCA submission validated end-to-end against the Fatoora sandbox using Moyasar-paid test orders; production-flip path documented for Phase 6's coordinated release.
- Failed-payment retry / abandoned-cart hooks unchanged from Phase 2.

**Exit:** against staging with Moyasar sandbox, a checkout completes with a real Mada/Visa test card; the order produces a ZATCA-compliant invoice posted to Fatoora sandbox; refunds work end-to-end. Production cutover plan reviewed and ready for Phase 6.

---

### Phase 6 — Launch infrastructure + go live (FIRST REVENUE)

**Goal:** stand up production hosting, point the storefront at it, flip every "sandbox" switch to "production" in a single coordinated release, and earn the first real riyal. Delivered as one coordinated pass so the public URL comes up with all guardrails in place simultaneously.

#### Production hosting

- Hetzner Cloud VM (CCX or CPX, Ubuntu LTS)
- Coolify installed and configured
- Postgres, Redis, Meilisearch as Coolify-managed services (parity with local Docker Compose). PgBouncer (if introduced) configured with `pool_mode = transaction | session` — statement-mode breaks RLS and is a hard refuse.
- BunnyCDN Storage Zone (production bucket) + Pull Zone. The Phase 1 storage adapter already supports BunnyCDN, so this is provisioning + env config — no code change.
- Mailpit container in Coolify for staging email preview
- Custom domain in Coolify/Traefik with auto-SSL (main tenant; second tenant waits for Phase 11)

#### CI / deploy pipeline

- GitHub repo wired to GitHub Actions → Coolify deploy webhook
- Workflow, fails-closed: `lint → typecheck → vitest → playwright → lighthouse-ci → check-e2e-coverage → check-role-invariants → deploy`
- Lighthouse CI enforcing mobile perf budgets — red → no deploy
- `check:e2e-coverage` extended to MCP mutations (currently tRPC-only)
- AST-level lint: `throw APIError` in a BA `hooks.before` must be preceded by an inline `writeAuditInOwnTx`; `after`-shape closed-set lint for `auth.*` operations
- Env management + secrets in Coolify. CI env-lint rejects test-only switches in production values (`APP_ENV=e2e|seed`, `E2E_AUTH_RATE_LIMIT_DISABLED=1`, `MCP_RUN_SQL_ENABLED=1`) and asserts Better Auth's internal rate-limiter stays disabled (our Redis sliding-window is authoritative)

#### Observability + safety nets

- Sentry project wired with a `beforeSend` scrubber that strips customer identifiers, PAT plaintext/hash, and captured React-component props. Builds on the Phase 0 error-log scrubbing pass so the scrubber is the last line of defence, not the only one.
- Nightly `pg_dump` → Hetzner Storage Box, restore drill exercised at least once before go-live
- Health check / uptime monitoring

#### Coordinated go-live cutover

- Production env brought up with payment-provider = `moyasar` (production credentials) and ZATCA = `production` (Fatoora portal) — both flips in one coordinated release, rehearsed on staging first
- Apple Pay domain verification against the production domain
- Sentry, BunnyCDN Pull Zone, uptime monitoring confirmed reporting before traffic is sent

**Exit:** main tenant's domain is live, publicly accessible, indexable in both languages. A real customer can place and pay for a real order in either language with a Mada or Visa card, get a localized bilingual confirmation, and the admin can fulfil or refund. Every order produces a live ZATCA-compliant invoice in Fatoora. **First riyal earned.**

---

### Phase 7 — Growth features + team scaling

**Goal:** features that move the needle on conversion, AOV, and retention — plus team-scaling features needed as the business grows beyond solo operation. The customer-facing AI assistant originally scoped here is deferred (see `docs/decisions.md`).

#### AI-assisted growth (no embeddings)

- AI-generated abandoned-cart emails (personalized copy, owner review before send)
- AI blog post drafting (SEO content marketing) with owner review
- Rule-based cross-sell / upsell (admin-curated "frequently bought together" + simple category suggestions; semantic recommendations deferred)

#### Team & operations (custom RBAC)

**Custom role + permission builder.** Owner can define new roles per tenant and attach fine-grained permissions to each. Replaces the fixed owner/staff/support triad with a data-driven model.

- **Permission catalog** seeded from code (not user-editable): every sensitive operation is a named permission (`tokens.view`, `tokens.create`, `tokens.revoke`, `products.create`, `orders.refund`, `inventory.adjust`, `run_sql_readonly`, …). Grouped by domain for UI.
- **Roles table** per-tenant, tenant-editable: name + description + ordered permission set. The three launch roles are seeded as system roles and remain un-deletable; owner can clone them or create fresh ones.
- **Memberships** reference a role (not a hardcoded role string). One-click reassignment.
- **Permission checks migrate from role-equals-X to permission-in-set.** Every gate (tRPC, MCP visibility, admin UI affordances) asks "does the caller hold permission Y?". The two authorization contracts introduced earlier (`requireRole` on tRPC, `McpTool.authorize` on MCP) are the only places that change.
- **Audit log records the permission that authorized each operation**, not just the role.
- **MCP personal access tokens** become permission-scoped: minting a token selects a subset of the caller's current permissions (cannot widen). Existing role-scoped tokens upgrade transparently.
- **Admin UI:** roles list, role editor (name + permissions checklist), membership-to-role reassignment, role deletion guard.
- **Super-admin** retains cross-tenant god-mode independent of per-tenant RBAC.

#### Other growth features

- **BNPL:** Tabby and Tamara via Moyasar or direct
- **Nafath integration** (identity verification for high-value orders, B2B accounts, fraud-flagged orders)
- **Reviews & ratings** with photo uploads, AI-assisted moderation
- **Product bundles**
- **Newsletter + marketing opt-in** (PDPL-compliant double opt-in)
- **Blog / content marketing** (MDX or small CMS)
- **Gift cards** (if desired)
- **Loyalty points** (if desired)
- **Referral program**

---

### Phase 8 — Hardening, scale, AI safety

**Goal:** sleep well at night.

#### Traditional hardening

- Full observability: structured logs, metrics dashboards, alerting
- Load testing (k6 or Artillery)
- Performance pass: Core Web Vitals at p75 on mid-range Android over 4G
- Security audit: dependency scanning, OWASP top 10, rate limiting, WAF
- Disaster recovery drill: restore from backup, measure RTO
- Read replicas if query load justifies
- CDN cache tuning
- Database index tuning based on real query patterns

#### AI safety

- Cost monitoring + budget caps on Claude API, per agent + per tenant
- Output filtering and PII scrubbing in AI responses
- Agent behaviour audit (tools called, args, outcomes)
- Eval harness for AI content (factuality, tone, Arabic quality)

#### PWA polish

- Add-to-home-screen manifest
- Web push (iOS 16.4+)
- Offline catalog browsing
- Service worker with sensible cache policy

---

### Phase 9 — Bilingual AI hardening + RTL polish

**Goal:** polish — not a launch blocker. Lands once catalog, growth, and hardening are done and the store has enough scale to justify the eval harness, translation-management UI, and Arabic-native AI tone tuning. Also absorbs the missing-translation badge originally scoped in Phase 1.

#### Work

- Translation management UI in admin: review missing strings, accept AI-suggested translations, mark approved, see coverage per locale
- **Missing-translation badge** (formerly Phase 1's 1a.6): per-field indicator on admin product / variant / category forms + a "show only items missing Arabic" filter on each admin list
- Comprehensive RTL audit and fixes across every page through Phase 2 — visual regression snapshots locked
- Arabic typography polish: Western numerals 0–9 for prices to match KSA banking UX, font weight pass, line-height tuning for mixed Arabic/Latin runs
- **Bilingual AI hardening:**
  - MCP tools accept and respond in Arabic (input language detection, response in same language)
  - Daily digest available in Arabic
  - AI content generation Arabic quality tuned and evaluated against a held-out set of real AV product descriptions — pass threshold defined and measured
  - System prompt tuning so Arabic output reads natively
  - Eval harness checked in and runnable via `pnpm eval:ar`

**Exit:** Arabic AI output passes the held-out eval set at the agreed threshold. Owner can run the store via Claude entirely in Arabic with native-feeling responses. Translation coverage UI shows ≥ 99% per locale. Missing-translation badge surfaces every gap.

---

### Phase 10 — Catalog visual polish

**Goal:** extend the catalog past Phase 1's must-have surface (single cover per variant, photos only). Two additions: per-variant photo galleries, and product video. Both ride existing infrastructure — feature work, not new plumbing.

#### Work

- **Per-variant photo galleries.** Multiple photos per variant (not just a single cover). Foundation supports it without schema change. This phase lifts the v1 cap, adds a per-variant photo manager UI, and updates the customer PDP to swap the gallery on variant selection (Amazon / AliExpress pattern). Justified once the catalogue includes apparel, accessories, or other colour-specific photo sets.
- **Product video uploads.** Short clips (≤ 30s) served as-is via HTML5 `<video>`, riding the same storage adapter. Admin upload UI mirrors the photo pipeline. Storefront renders video alongside photos in the product gallery. If demand emerges for longer-form, BunnyCDN Stream is the planned upgrade path — same vendor, no migration of existing photo storage.
- **Out of scope:** 360° spin viewers, 3D product views, in-app cropping, AI background removal, bulk import, image moderation. Revisit if a real catalog need surfaces.

**Exit:** a variant can carry its own photo set; the customer PDP swaps the gallery on variant selection. Products can carry video; admin upload + replace + delete work; storefront renders video inline.

---

### Phase 11 — Second tenant launch + tenant-aware MCP

**Goal:** sister company goes live on its own domain, its own catalog, its own branding, its own AI agents. The multi-tenant *architecture* is already in from Phase 0 — this phase adds provisioning, theming, separate sender domains, super-admin views, and adversarial cross-tenant testing.

#### Work

- Tenant onboarding flow (create tenant, assign domain, upload logo, theme tokens, locale defaults)
- Per-tenant theming (CSS variables driven by tenant config)
- Custom domain setup in Coolify/Traefik with auto-SSL
- Tenant-scoped admin (admins only see their tenant's data)
- Platform super-admin view for the owner to manage all tenants
- Separate Sentry projects per tenant
- Separate analytics properties per tenant
- Multi-tenant audit: re-verify RLS policies, adversarial isolation testing
- Separate Resend sender domains per tenant
- **Tenant-aware MCP:** PATs scoped to tenant; super-admin tokens offer cross-tenant tools (`list_tenants`, `create_tenant`, cross-tenant analytics)
- Per-tenant daily digests and agent runs

**Exit:** both brands live on their own domains, fully isolated, fully branded, running from one codebase and one deploy. Owner can ask Claude "how did tenant A do vs tenant B last week" and get a real answer.

---

## 7. Open questions / still-undecided

- **ZATCA provider:** SDK vs direct API — decide at start of Phase 4.
- **Shipping carriers:** SMSA vs Aramex vs Naqel vs SPL — decide during Phase 2 based on business relationships.
- **B2B features:** does either tenant sell to businesses (tax-exempt, quotes, POs, net-30)? If yes, meaningful Phase 3–4 addition.
- **Repair / service / installation:** AV companies often offer installation. Is this in scope?
- **Returns policy specifics:** KSA consumer protection law has specific rules — confirm with legal.

---

## 8. Where to look for more

| Document | When to read |
|---|---|
| `CLAUDE.md` | Every session start. Operational rules — how we work. |
| `docs/architecture.md` | Tech stack and architectural decisions. Read when designing. |
| `docs/standards.md` | Performance / accessibility / security / AI safety / data tiers. Read when relevant. |
| `docs/decisions.md` | Reversed and deferred decisions, with the *why*. Read before re-litigating. |
| `docs/adr/` | Architecture decision records (deeper than `decisions.md` — for specific technical choices). |
| `docs/runbooks/` | Operational guides for shipped surfaces (auth, audit, MCP, KEK rotation, database roles). |
