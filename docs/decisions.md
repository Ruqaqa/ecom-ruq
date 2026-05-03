# Decisions log

Reversed and deferred decisions, with the reasoning. Read this before re-litigating something. New entries go at the top with a date.

---

## 2026-05-03 — Phase 1a.6 (bilingual badge) relocated to Phase 9

The JSONB `{ en, ar }` input pair already ships on products / variants / categories from 1a.2 onward. The relocated scope is just the per-field "missing translation" badge and a "show only items missing Arabic" filter on admin lists.

**Why:** pre-launch, solo operator, small catalog → the badge mostly tells the owner what they already know. Lives more naturally with the rest of the bilingual hardening pass in Phase 9, when the catalog is large enough that the badge actually saves time.

## 2026-05-03 — Phase order rebalanced

Originally the second tenant launched in old Phase 4 and bilingual AI hardening was old Phase 3. Both moved to the end of the roadmap.

**Why second tenant moved late:** the multi-tenant architecture is already in from Phase 0 (RLS, scoped queries, audit, tenant-resolved request context). What the launch phase actually adds is provisioning, theming, separate sender domains, super-admin views, and adversarial cross-tenant testing — "we have a proven playbook to clone" work. Doing it before one brand earns real revenue splits attention prematurely.

**Why bilingual hardening moved late:** every existing browser test runs in both Arabic and English on mobile from day one, so RTL regressions surface immediately. The owner reviews every product entry personally before publishing. The dedicated hardening pass (translation management UI, eval harness, Arabic-native AI tone tuning) is polish, not a launch blocker.

## 2026-05-02 — Drag-to-reorder for product photos un-deferred

Originally listed as deferred in Phase 1's image pipeline. Built in 1a.7.2 same-day.

**Why reversed:** owner asked for it during testing. The data layer already carried a `position` column, so the addition was UI + a single service surface. Cheap once the photo screens were live.

## 2026-04-23 — Launch infrastructure deferred to top of Phase 1b (now Phase 6)

Hetzner VM, Coolify, GitHub Actions pipeline, Sentry DSN wiring, Lighthouse CI enforcement, CDN, backups, uptime monitoring — all moved out of Phase 0 and consolidated into a single coordinated pass closer to public launch.

**Why:** at Phase 0 close there was one developer, no production host, no staff, no customers. A hosted CI pipeline and Coolify deploy webhook had no target to point at and no second set of hands whose pushes they would guard. The two genuinely load-bearing pieces (error-log scrubbing so customer identifiers never leak into logs, and boot-time production-safety guards so a misconfigured prod env cannot start) were kept in Phase 0. The rest lands in Phase 6 with the public URL.

## 2026-04-17 — Customer-facing AI assistant, pgvector, and Voyage AI deferred to post-revenue

The customer-facing storefront chatbot, semantic search infrastructure (`pgvector` extension, embedding columns, embeddings pipeline), and Voyage AI embeddings provider were scoped out of the phased roadmap.

**Why:** they add real ongoing cost (Claude API spend on customer traffic, Voyage API spend, eval harness upkeep, adversarial test-set maintenance) and do not block first revenue. Ship the store without them, validate that the business generates revenue, revisit once a profit signal justifies the operational overhead.

**Not deferred:** the MCP server and all operator tools (owner runs admin workflows through Claude Desktop / Claude Code), AI-assisted bilingual product entry (Phase 1), AI-generated abandoned-cart emails and blog drafting (Phase 7), all autonomous ops agents (Phase 2 onward). These use Claude text generation and MCP tool-use, not embeddings.

## Standing deferrals (no specific date — design intent)

- **Per-tenant variant specifications + catalogue filters.** Variant data layer is ready; the merchant-defined specifications and storefront filters are their own later chunk. Doesn't block variant work.
- **Native mobile app.** PWA covers ~85–90% of native-app value at ~5% of cost for Gulf AV e-commerce. Architecture (tRPC, bearer tokens, transactional surfaces behind tRPC) keeps a native app as a future drop-in.
- **Per-variant photo galleries** (multiple photos per variant, not just a single cover). Foundation supports it without schema change. Single cover-per-variant covers ~90% of small Gulf catalogues. Lands in Phase 10 once apparel/accessories actually appear.
- **Product video, 360° spin, 3D views.** Lands in Phase 10. Short clips ride the same storage adapter built for photos; longer-form would adopt BunnyCDN Stream.
- **In-app cropping / rotation, AI background removal, bulk import (CSV / URL / FTP), image moderation.** Owner crops in phone camera; centre-crop display contract handles the rest. Catalogue is owner-only, so moderation is pointless.
- **AI-generated bilingual alt text on upload** (Claude vision). Belongs to the AI-assist workstream, not the image pipeline. The admin UI ships with a manual alt-text field that the AI assist will later auto-populate.

## Standing rejections (do not re-litigate)

- **Vercel / Supabase / Clerk** — not self-hosted.
- **Prisma** — heavier than Drizzle, worse RLS story.
- **Elasticsearch / Algolia** — overkill or not self-hosted.
- **LangChain / LangGraph** — too opaque for vibe coding; direct Claude tool loops are clearer.
- **Microservices** — start monolith, split only if needed.
- **Subdomains for tenants** — chose custom domain per tenant for brand SEO and trust.
- **Schema-per-tenant** — operationally painful, migrations get weird, overkill for 2–3 tenants.
- **Statement-mode PgBouncer pooling** — breaks RLS. Hard refuse.
