# ADR 0001 — PAT storage

Status: accepted (Phase 0)
Date: 2026-04-17

## Context

Personal access tokens (PATs) are how human admins and autonomous agents (Claude
Code, Claude Desktop) authenticate to MCP tools and tRPC mutations, per prd.md
§3.7. We need a storage model that is:

1. tenant-scoped (tokens cannot cross tenants);
2. fast to verify on every request (MCP and API traffic is hot-path);
3. resistant to DB-only compromise (a leaked `SELECT *` should not yield usable
   credentials);
4. compatible with Better Auth's bearer-token plugin so we do not rebuild auth.

## Decision

Store tokens in an `access_tokens` table (see `src/server/db/schema/tokens.ts`):

- Plaintext format: `eruq_pat_<base64url(32 random bytes)>`. The `eruq_pat_`
  prefix is for human recognition in the admin UI and to trigger GitHub /
  scanner detection. The 32 random bytes provide 256 bits of entropy.
- Hash algorithm: **HMAC-SHA-256 with a server-side pepper**
  (`TOKEN_HASH_PEPPER` env var, 32 base64 bytes, generated per-environment).
  Stored as 32-byte `bytea` in `token_hash`, with a unique index.
- `token_prefix text` stores the first 8 chars of the plaintext (post-`eruq_pat_`),
  shown in the admin UI so operators can distinguish their own tokens without
  ever seeing the full secret again.
- `tenant_id uuid NOT NULL` with a CHECK constraint (`access_tokens_tenant_not_null`).
  Phase 0 tokens are always tenant-scoped. The CHECK gets dropped when
  super-admin tokens (platform-scope) land in a later chunk.
- `scopes jsonb` stores a structured object: `{ role: 'owner'|'staff'|'support',
  tools?: string[] }`. Zod schema in `src/server/services/` is the source of
  truth for shape.

### Why HMAC-SHA-256, not argon2id

Argon2id is the right choice for human passwords — intentionally slow to
frustrate offline brute force on low-entropy inputs. PATs are high-entropy
(256 bits) and are looked up on **every MCP/API request**. A sub-millisecond
HMAC comparison is appropriate; argon2id would add ~100ms of CPU per request.
The pepper (stored outside the DB) provides the defense against a DB-only
compromise that a slow KDF would otherwise provide.

### Better Auth integration

Phase 0 defines the schema. Issuance and verification land in chunk 7 (MCP
server) via Better Auth's bearer-token plugin. Two options depending on the
plugin's extensibility:

- **(a) Preferred:** override Better Auth's hash function via a plugin hook
  to use our HMAC-SHA-256-with-pepper. All tokens stay in the same row shape
  the plugin expects, plus our additions (tenant_id, name, token_prefix,
  scopes, last_used_at, revoked_at).
- **(b) Fallback if (a) is not supported by Better Auth v1:** maintain our
  own lookup path for PATs at the MCP/tRPC adapter layer; Better Auth still
  manages sessions for the web UI. Two lookup paths, one database, shared user
  identity. This ADR is updated with (a) or (b) once chunk 7 confirms what BA
  supports.

## Issuance and revocation (chunk 7)

- Token plaintext is shown to the admin **exactly once** at creation and never
  stored. The admin gets the plaintext; the DB stores only `token_hash` +
  `token_prefix`.
- `tenant_id` at creation is derived from the authenticated admin's membership
  context, **not** from the request body. This prevents a compromised admin
  of tenant A from minting a token valid for tenant B.
- Revocation sets `revoked_at` (soft revoke) and is checked on every lookup.
- `last_used_at` is updated opportunistically with debouncing (≤1 write per
  minute per token) so we do not overwhelm writes on hot tokens.

## Consequences

- Pepper rotation requires rehashing every active token. Procedure is similar
  to KEK rotation (see `docs/runbooks/kek-rotation.md`) — issue new tokens
  under the new pepper, deprecate old tokens, retire the old pepper once the
  deprecation window closes.
- Tokens cannot be recovered if the plaintext is lost. Admins must mint a new
  one. This is expected and aligns with the "shown exactly once" guarantee.
- Audit every issuance, use, and revocation via the audit adapter (chunk 6).
