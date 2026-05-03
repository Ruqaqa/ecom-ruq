# Testing strategy

Canonical rules for **what we test, where it lives, and what we don't bother testing.** Every other testing reference in the repo (CLAUDE.md §1, the TDD agent definition, the coverage lint) defers to this file.

The goal is **maximum confidence per minute of CI time and per token of agent context.** Lighter, sharper tests pay back every time the TDD teammate (or any future teammate) reads them.

---

## 1. The tiers

| Tier | What it is | Where it lives | Speed target | Use it for |
|---|---|---|---|---|
| **Tier 1 — Static** | TypeScript strict + ESLint | `pnpm typecheck`, `pnpm lint` | < 30 s combined | Type contracts, dead code, obvious bugs |
| **Tier 2 — Fast** | Vitest against the real local Postgres + faked Redis | `tests/unit/`, ~1.3k tests today, ~5 s wall | full suite < 30 s | Service-layer behavior, validation, role/tenant gates, audit-trail correctness, MCP tool authorize, request-shape rules |
| **Tier 3 — Medium** | Vitest driving a real HTTP route handler against the real DB | `tests/integration/` | each test < 5 s | The handful of HTTP-boundary contracts that matter — wire shape, error mapping, CSRF guard, PII exclusion. **Sparing.** |
| **Tier 4 — Browser** | Playwright through `pnpm build && pnpm start` | `tests/e2e/` | each test < 30 s, suite < 10 min | Real user journeys: auth, the operator's golden paths, customer-facing critical flows |

Tier 1 + Tier 2 are where most testing happens. Tier 4 is **deliberately small and stays small**.

---

## 2. The bar for a Tier-4 (browser) test

> "If we could only have **twenty** browser tests in this repo, would this one be in the top twenty?"

If the answer is no, the behavior belongs in Tier 2. Apply this question every time the TDD agent considers writing a Playwright spec.

A behavior earns a browser test when **all** of these are true:

1. A real human (operator or customer) triggers it by clicking, typing, or submitting.
2. The bug it catches is one that Tier 2 cannot meaningfully express — typically an integration of: routing + form serialization + client-side validation + server response handling + post-mutation refetch + visible state.
3. It's on the critical path for revenue, security, or trust.

If two of those three are present, it's a judgement call — prefer Tier 2.

---

## 3. What we test, and where

### Always Tier 2 (fast)

- Service-layer business logic (pricing, validation, transformations)
- Role and tenant gates (defense-in-depth at the service)
- MCP tool `authorize` and `isVisibleFor`
- Audit-trail shape and forensic invariants (load-bearing — keep strict)
- Zod input/output schemas (focus: cross-tenant attack shapes, strict-mode rejections)
- Request-shape rules (body-size cap, CSRF guard at the lib layer)
- Error-code mapping (closed-set translation)

### Tier 3 (medium / HTTP boundary) — kept small

One representative test per HTTP surface, not one per tool:

- **MCP transport** — one happy path + one adversarial-tenant attack against the route, total. The per-tool rules already pass at Tier 2.
- **CSRF guard** at the real upload route — one test, not three.
- **PII / token plaintext exclusion** in JSON-RPC error bodies — one test.

Adding a Tier-3 test requires a real reason a Tier-2 test cannot cover. Default answer: it can.

### Tier 4 (browser) — Phase 1 target list

The shipped test estate should converge on roughly these — not every page, every mutation, or every variant.

**Auth (always real browser):**
- Sign-up password happy path + rejected breached password (one locale per phone)
- Sign-in password happy path
- Magic-link round-trip via Mailpit
- Logout + cookie scope smoke

**Operator golden paths (one happy path + one critical error each):**
- Create product
- Edit product (covers OCC stale-write banner)
- Soft-delete + restore product
- Create category, edit category, reorder categories (cover dnd-kit pointer activation as a smoke)
- Manage product photos (upload → set cover → remove; the full mutation chain is one test, not seven)
- Manage product variants (one happy path that exercises the option → variant cascade)
- Manage tokens (one mint + one revoke)

**Adversarial smoke (one good test, not many):**
- Cross-tenant denial: anonymous, customer, and tenant-A user cannot reach tenant-B admin pages — one parametrised spec.

**That's roughly 15–20 browser specs.** Anything beyond that needs the §2 bar.

### What does NOT get a Tier-4 test

- Internal MCP tools (covered at Tier 2 for logic, Tier 3 once for transport)
- Internal mutations the operator does not click (e.g., `images.setVariantCover` if it's only called from one component already covered by the parent flow)
- Per-feature touch-target checks — assert once at the design system level
- Per-page accessibility scans — see §4
- Validation paths that have a Tier-2 equivalent (slug too long, sku duplicate, etc.)
- Stale-write OCC banners on every form — one test on one form covers the pattern

---

## 4. Device and language matrix

**Diagonal sampling, not full matrix.** Industry guidance: 8–12 device-locale combinations cover 90%+ of users. Ours is far smaller because we're a single-tenant audio-visual platform on a tight stack.

**Phase 1 matrix per Tier-4 spec (default):**

| Profile | Locale | Purpose |
|---|---|---|
| iPhone 14 | English | Primary mobile, LTR layout |
| Pixel 7 | Arabic | Mobile RTL coverage on a different vendor |

**Optional desktop project**, English only, for the small set of admin pages that have desktop-specific layout (the catalog list, the variants grid). RTL desktop is not run by default — pseudo-localization (§4.1) catches the layout breakage that would matter.

**Drop the inner-language loops** (`for (const locale of ["en","ar"])` inside a test body). Each project already pins a locale; the inner loop is pure duplication.

### 4.1 Pseudo-localization for layout safety

Use a pseudo-locale (text expanded ~35%, accented characters, RTL markers) as a **layout stress harness** on Tier 4. Run a small dedicated spec that walks the operator pages and asserts no layout breakage / overflow / hardcoded English. This catches the bugs that running every test in real Arabic was trying to catch — without paying for it on every test.

Real Arabic is reserved for journeys where the **meaning** of the Arabic text matters (sign-up confirmation, customer-facing messages). Native-speaker review is the only thing that catches translation quality; automation cannot.

### 4.2 Accessibility

`@axe-core/playwright` runs per **distinct visual page**, not per test. One axe pass per: signin, signup, account home, admin product list, admin product edit, admin category list, admin category edit, admin tokens, admin photos, admin variants. Run it once per locale on that page, not once per test that visits it.

---

## 5. Hard rules per test

- **30-second hard cap per Tier-4 test.** A slow test must be fixed, not given a bigger timeout. `test.setTimeout(60_000)` and friends are not acceptable for new tests.
- **No flake tolerance.** A flaky test is quarantined within 24 h and the root cause fixed. Never `test.retry()` to mask flake.
- **No `waitForTimeout` for arbitrary sleep.** Use `waitFor` against a real condition.
- **One test, one behavior.** "and" in the test name means split it.
- **Real code over mocks** at every tier. Mock only at boundaries we don't own (Moyasar, ZATCA, Bunny CDN, Nafath, Unifonic).
- **Bug fix protocol.** Reproduce with a failing test at the lowest tier that can express the bug, then fix.

---

## 6. What we don't test at all

- Static UI strings unless the string IS the behavior (an error message wired to a closed-set code is the behavior)
- CSS classes, styling, layout details
- Component rendering with no logic
- Pass-through wrappers
- Internal data-shape lockdowns (the audit chain is the only exception — that's forensic)
- Test infrastructure (the helpers themselves; if they break, the suite fails loudly)
- One-liner getters/setters

---

## 7. Coverage lint

`pnpm check:e2e-coverage` enforces the substring contract:

- **Page routes** (`src/app/**/page.tsx`) must appear in some `tests/e2e/**/*.spec.ts`. Pages are user-visible by definition.
- **tRPC mutations** must appear in **any** test source — `tests/e2e`, `tests/unit`, or `tests/integration`. Tier 2 / 3 coverage satisfies the lint; only the page-route portion is browser-tier-only.

If a mutation is reachable only through a page that already has a Tier-4 test, that page's spec naturally name-mentions the mutation and the lint is satisfied. The lint never forces an extra browser test for an internal mutation that has solid Tier-2 coverage.

---

## 8. Definition of done

A feature is done when:

1. `pnpm typecheck` and `pnpm lint` are clean.
2. `pnpm test` is green.
3. `pnpm check:e2e-coverage` is green.
4. **If** the feature meets the §2 bar for Tier-4, `pnpm test:e2e` is green for the relevant spec on the matrix in §4.
5. If it doesn't meet the §2 bar, Tier-2 (and where appropriate Tier-3) coverage is in place — and that is sufficient. Tier-4 is **not** a default requirement.

This replaces the prior "every feature needs a Playwright test on mobile in both locales" rule. That rule is the reason the suite has 144 specs running across six profiles. The new rule is: **fewer browser tests, picked deliberately, kept fast.**
