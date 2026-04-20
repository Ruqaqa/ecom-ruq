# audit_log runbook

## Chain topology

`audit_log` has one tamper-evident chain per tenant (and a dormant
platform-scope chain, keyed by the all-zeros UUID, used only by
`app_platform` when super-admin lands).

Each row carries:
- `prev_log_hash` — the `row_hash` of the immediately-preceding row in the
  same tenant. NULL on the first row per tenant. Stamped by the
  `audit_log_fill_chain` BEFORE INSERT trigger (migrations/0003).
- `row_hash` — HMAC-SHA-256(HASH_PEPPER, canonical_json(...)) over:
    - the row's metadata (`tenant_id`, `correlation_id`, `operation`,
      `resource_type`, `resource_id`, `outcome`, `actor_type`, `actor_id`,
      `token_id`, `error`, `created_at`)
    - the content-hash columns (`input_hash`, `before_hash`, `after_hash`)
    - `prev_log_hash`
  Computed by the audit middleware at the adapter layer (chunk 6) using the
  canonicalization scheme in `src/lib/canonical-json.ts` (RFC 8785 JCS).

The BEFORE INSERT trigger acquires
`pg_advisory_xact_lock(hashtext('audit_log:' || tenant_id))` before reading
the previous row_hash, so two concurrent writers in the same tenant
serialize without blocking other tenants.

## Verifying a chain

Given the current `HASH_PEPPER` and an ordered dump of a tenant's audit_log
rows:

1. Start with `prev := NULL`.
2. For each row in `(created_at, id)` order:
    a. Assert `row.prev_log_hash === prev`.
    b. Recompute `expected := HMAC-SHA-256(HASH_PEPPER, canonical_json(row minus id and row_hash minus trigger-stamped prev_log_hash but with the stamped value))`.
    c. Assert `row.row_hash === expected`.
    d. Set `prev := row.row_hash`.
3. A mismatch at row N means rows 1..N-1 are intact and row N (or later) was
   tampered with after the trigger ran — which also requires bypassing the
   append-only triggers, so it's an extraordinarily loud event.

A verification script lives at `scripts/verify-audit-chain.ts` (to be added
in chunk 6 alongside the audit middleware).

## Pepper rotation

A `HASH_PEPPER` rotation invalidates every pre-rotation row_hash from the
verifier's perspective. Rotation procedure:

1. Before rotating, run the verification script and checkpoint the current
   chain head (store the `row_hash` of the most recent row per tenant).
2. Rotate the secret. New rows will hash under the new pepper; old rows
   still verify under the old pepper.
3. Keep the old pepper available to the verifier under `HASH_PEPPER_PREVIOUS`
   for the agreed retention window; after that window, rows older than the
   rotation are considered unverifiable from the verifier's current state
   but still valid in the archived checkpoint.

## Known gap — chain-head external witnessing

Phase 0 only stores the chain inside Postgres. A motivated attacker with DB
superuser can rewrite the chain (disable triggers, rewrite rows, recompute
hashes, re-enable triggers) — no external witness would catch it.

Phase 4+ adds a weekly job that emails each tenant owner their chain head
(current `row_hash` + `created_at`) for operator capture. Tenant owners can
archive those emails to an external, tamper-evident store (e.g., their own
mailbox at a third-party provider). The verifier then checks DB-reported
chain heads against the witnessed heads.

Until that lands, the tamper-evidence story relies on the append-only
triggers + the REVOKE TRUNCATE + the SECURITY DEFINER scrub path — none of
which defend against a DB superuser acting in bad faith.
