# Standards

Non-functional requirements, AI safety, data classification, and out-of-scope. Read when touching performance, security, or data-handling code.

---

## 1. Performance (mobile-first, hard constraints)

- **p75 LCP < 2.5s** on mid-range Android over 4G, measured from KSA, for public catalog pages.
- **p75 INP < 200ms** on the same profile.
- **p75 CLS < 0.1.**
- **JS bundle < 200 KB gzipped** on initial load (excluding images).
- Arabic and Latin fonts self-hosted via `next/font`, subset aggressively, `font-display: swap`.
- All public pages SSR/ISR; no client-only product/category rendering.
- Images via `next/image` with explicit `sizes`, AVIF/WebP, blur placeholders, lazy below the fold.
- **Enforced automatically by Lighthouse CI.** Regressions fail CI and block deploy. Never measured by hand.

## 2. Mobile-first UX (hard rules)

- Design starts at **360px** and scales up. No "design for desktop then shrink."
- **Bottom navigation** on storefront mobile (categories / search / cart / account); sticky CTA on product pages so "Add to cart" is always thumb-reachable.
- **Touch targets ≥ 44×44px.** No hover-dependent UI anywhere — every hover state has a tap equivalent.
- Form UX: `inputmode` hints, `autocomplete`, Arabic keyboard support, `+966` prefix on phone inputs.
- **No layout shift** — reserve space for images, async content, cart badge.
- Test on real mid-range Android before each phase exit, not just Chrome DevTools.

## 3. Availability & ops

- **Availability:** 99.5% at launch, 99.9% once the business depends on it.
- **Backups:** nightly `pg_dump` + WAL archiving; quarterly restore drill.
- **Security:** HTTPS everywhere, HSTS, CSP, rate limiting on auth + checkout, encrypted secrets, least-privilege DB users per service. Hetzner volumes use LUKS encryption from day one. TLS required for all app↔Postgres connections (no plaintext on any hop). Nightly backups encrypted with `age` before upload to Hetzner Storage Box; the decryption key is stored separately from the backup destination.
- **PDPL:** consent, export, deletion, audit log for sensitive field access.
- **Accessibility:** WCAG 2.1 AA for the public storefront.

## 4. AI-specific NFRs

- **Latency:** owner-facing MCP read calls complete in < 2s p95.
- **Cost ceiling:** monthly Claude API spend capped per tenant; circuit breaker disables non-essential AI when hit; alert at 80%.
- **Grounding** (when customer bot is revived): every factual claim grounded in retrieved context; no free-form spec claims.
- **Safety** (when customer bot is revived): cannot call mutation tools beyond the authenticated user's own scope.

## 5. Data classification (three tiers)

Encryption is not applied uniformly because uniform encryption creates complexity without reducing real risk for fields the app must routinely decrypt.

### Tier A — Encrypted at the column level

pgcrypto envelope encryption. Per-tenant data-encryption key (DEK) wrapped by a key-encryption key (KEK) loaded from env at boot; the wrapped DEK lives in the DB, the KEK never does. **Reads are audit-logged.**

- National ID numbers (when Nafath lands)
- Raw identity verification payloads
- Stored payment tokens not handled by Moyasar (rare; most card data never touches our DB)
- Any future field carrying regulator-defined PII

### Tier B — Access-controlled, not encrypted at column level

Encryption would not help: the app must decrypt routinely to display in admin, so keys would have to live where the app lives — anyone who pops the app gets the data anyway. Protection is role-gated output schemas in the service layer + tenant scoping + RLS as defense in depth.

- Cost prices and supplier-side pricing
- Internal product / supplier notes
- Customer PII visible to staff (email, phone, shipping address)
- Order-level internal annotations

### Tier C — Public

No special protection beyond standard tenant scoping.

- Product names, descriptions, retail prices, images
- Public order status

**Cross-cutting at-rest protections** (apply to all tiers): Hetzner LUKS volumes, TLS to Postgres, encrypted nightly backups with key stored separately. Defense in depth — not a substitute for the tier-specific controls above.

## 6. AI risk & cost controls

### Cost

- **Model routing:** Haiku for classification/routing/simple extraction. Sonnet for reasoning, content gen, agent loops. Opus only for complex multi-step agents.
- **Prompt caching** for long system prompts and RAG context.
- **Per-tenant monthly budget cap** with circuit breaker.
- **Alert at 80%** of cap via daily digest.
- **Customer bot rate limits** per session, per IP, per authenticated user.
- **Response caching:** identical customer queries within a short window return cached answers.

### Prompt injection & safety (customer bot — applies when revived)

- Tools **hard-scoped server-side** to the authenticated user's own data. Prompt cannot widen scope.
- Never trust model output as a tool argument selector alone — always validate against the user's permissions and the tool's Zod schema.
- Output filtering strips anything that looks like a token, email, phone, national ID, or order from another user.
- System prompt forbids role-playing, instructions in user content, and "ignore previous instructions" attacks.
- Adversarial test suite maintained from the moment the bot ships.

### AI mistakes in writes (operator MCP)

- Destructive tools require `confirm: true`.
- Dry-run mode for bulk operations returns a preview without executing.
- Complete audit log of every tool call with before/after state.
- Soft deletes for catalog entities with a recovery window.
- Financial operations (refunds, discounts over a threshold) require a second confirmation even from the owner.

### Hallucination in customer-facing content

- Customer bot is **strictly RAG-grounded** when revived. System prompt forbids any spec, price, or availability not in retrieved context.
- AI-generated product copy, blog posts, and abandoned-cart emails require owner review before publish/send. No auto-publish.
- Eval harness checks AI-generated Arabic against a held-out reference set.

### Token security

- Personal access tokens are tenant- and role-scoped, short-lived, revocable.
- Tokens never logged.
- Token rotation is one click in admin.
- Rate limit per token.

## 7. Out of scope (at least for now)

- Native mobile apps — deferred. Web is mobile-first; PWA fills the gap. Architecture keeps a native app as a future drop-in.
- Marketplace model (third-party sellers).
- Subscriptions / recurring billing.
- Live chat with humans (at launch, customers reach the owner via WhatsApp Business; the deferred customer bot will add AI-triaged handoff when revived).
- Custom ERP integrations (we are the ERP).
- International shipping outside Gulf.
