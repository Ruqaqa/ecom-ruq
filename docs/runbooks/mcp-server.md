# MCP server runbook — operator + developer

## What this is

A Model Context Protocol (MCP) HTTP endpoint that exposes the typed
service layer to Claude Desktop, Claude Code, and any autonomous
agent holding a valid personal access token (PAT). Every write the
admin UI can do, MCP can do — by construction, not by afterthought
(prd §3.7).

- **Endpoint shape:** single Next.js POST route at
  `/api/mcp/[transport]`. `[transport]` is the SDK's transport name;
  today it's `streamable-http`. A request URL looks like
  `https://<tenant-domain>/api/mcp/streamable-http`.
- **Auth:** bearer-only. `Authorization: Bearer <pat>` header.
  Anonymous callers are rejected BEFORE any SDK or audit dispatch
  runs. No session cookies; MCP deliberately doesn't consult them.
- **Tenant resolution:** via the request Host header → tenants table
  → `TenantContext`. Cross-tenant tokens fail closed: a PAT minted on
  tenant A called against tenant B's Host returns null from
  `lookupBearerToken` before any tool sees the request.
- **Body cap:** 64KB enforced before any JSON parse; larger bodies
  return 413 without touching the parser. Matches the tRPC catch-all
  cap.

## Access tokens — owner-only, session-minted

Access tokens are minted and revoked only via the admin web UI at
`/{locale}/admin/tokens` by a logged-in owner. Staff cannot view or
mint tokens (the page renders an "owner-only" notice); bearer tokens
cannot mint more bearer tokens (`tokens.create` requires
`identity: 'session'`; see `auth.md` §"`tokens.*` routes are
session-only").

### Minting a token

1. Open the storefront at `/{locale}/signin` and sign in as an owner.
2. Navigate to `/{locale}/admin/tokens`.
3. Click "Create token". Name it (free text — the name is yours,
   not cryptographic; use it to remember what this token is for).
4. Choose the scope (`owner` | `staff` | `support` for role; optional
   experimental `tools` allowlist — today just `run_sql_readonly`,
   which stays off at the platform flag regardless).
5. The owner-scope grant requires an explicit `ownerScopeConfirm`
   tick — a guardrail so "give Claude owner powers" is never a silent
   checkbox.
6. If you're granting the experimental `tools` scope, a second
   `experimentalToolsConfirm` tick is required (same reasoning).
7. Submit. The plaintext token appears **once**, prefixed with
   `ru_`. Copy it. There is no second chance — revoke and mint again
   if you miss the copy.
8. Paste an "I've saved this token" confirmation to dismiss the
   reveal panel. Leaving the panel open does NOT leak — the plaintext
   lives only in React state, never in localStorage, URL, or the RSC
   payload — but the confirmation step enforces deliberate action.

### Connecting Claude Desktop

Claude Desktop doesn't speak streamable-HTTP natively; use
`mcp-remote` as an HTTP bridge. Install it globally
(`npm i -g mcp-remote`) or via `npx`. Then add an entry to Claude
Desktop's config (location depends on OS — macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ecom-ruq": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<tenant-domain>/api/mcp/streamable-http",
        "--header",
        "Authorization: Bearer <paste-token-here>"
      ]
    }
  }
}
```

Quit Claude Desktop fully (Cmd-Q on macOS — the red dot top-left is
NOT a full quit) and relaunch. The MCP server appears in the list of
connected tools. Ask Claude "list the products you can see" to
verify.

**In dev, the tenant domain is `http://localhost:5001`** (the dev
port; see `project_local_port.md` in the memory index). The dev
tenant is seeded by `pnpm db:seed:dev`.

**Gotcha: stale PAT.** If Claude Desktop was pointed at a PAT that
has since been revoked, tool calls silently fail (the SDK surfaces a
generic error). Check the admin token list — revoked tokens are
hidden there; if you don't see your token, it was revoked. Mint a
new one and update the config.

### Connecting Claude Code

Same principle, different config. Claude Code reads
`~/.claude/mcp.json` (or a project-local `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "ecom-ruq": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<tenant-domain>/api/mcp/streamable-http",
        "--header",
        "Authorization: Bearer <paste-token-here>"
      ]
    }
  }
}
```

## Revoking a token

From the admin tokens page, click "Revoke" on the row. A native
`<dialog>` confirmation opens — backdrop click does NOT dismiss
(this is deliberate: a destructive action is not a
click-anywhere-to-dismiss affair). Confirm via the explicit Revoke
button.

Revocation is immediate. The token's `revoked_at` timestamp is set
(soft delete — the audit trail for the revoked token stays). A
revoked token fails the bearer lookup on the very next request
(`lookupBearerToken` filters `isNull(accessTokens.revokedAt)`).

Revoked tokens are hidden from the admin list. That's a deliberate
operational choice — the live inventory shows what's usable; the
audit log is where dead keys live for forensics. Query the audit log
by `operation='tokens.revoke'` to find when a token was killed.

## Tool visibility by role

Tool exposure is per-tool via the `isVisibleFor(ctx)` hook in each
tool's registry entry. Summary:

| Tool | Owner PAT | Staff PAT | Support PAT | Anonymous |
|---|---|---|---|---|
| `ping` | visible | visible | visible | rejected at adapter |
| `create_product` | visible | visible | hidden | rejected |
| `run_sql_readonly` | hidden (see below) | hidden | hidden | rejected |

"Hidden" means the tool is not listed in `tools/list`. A direct
`tools/call` against a hidden tool still reaches `authorize`, which
throws FORBIDDEN with an audit row recording the refusal — even for
read tools where audit-mode is `"none"`, the forbidden refusal is
audited (Decision 1 — adapter widens audit for `forbidden` outcomes
regardless of audit mode).

**Staff can call `create_product`.** Staff is a write role; product
creation is part of staff's normal workflow. This is correct behavior
per prd §3.7 ("Tool set is role-filtered: a staff token sees fewer
tools than an owner token").

## `run_sql_readonly` is off by design (chunk 7.4 stub)

Registered, visible-gated, but hard-locked at `authorize`. Two
independent conditions control VISIBILITY (both required, default
off):

1. Platform flag `MCP_RUN_SQL_ENABLED === "1"` (read via function,
   not a module-top-level constant, so integration tests can flip it
   per-test).
2. Caller's PAT has `run_sql_readonly` in its `scopes.tools` array.

Even when BOTH visibility conditions are met, `authorize` still
throws `McpError("forbidden", …)`. The forbidden audit row lands via
the shared adapter. Direct invoke is impossible in 7.4.

**How to unlock when the sandbox is ready** (post-Phase-4, when the
read-only Postgres role + SQL sanitizer + prompt-injection hardening
land):

1. Add a dedicated Postgres role (`app_readonly_sandbox` or similar)
   with SELECT grants scoped to safe tables only, no DDL, no DML.
2. Add a SQL sanitizer that rejects statements containing DDL /
   DML / procedural extensions (CTE, DO, COPY, COMMENT ON, SET, etc.).
   White-list approach, not blacklist.
3. Add row-limit clamping (`LIMIT 1000` appended if absent).
4. Add statement-timeout on the sandbox role.
5. Unlock the `authorize` hook — replace the unconditional throw with
   an owner-role + scope-tools check.
6. Flip `MCP_RUN_SQL_ENABLED=1` in production Coolify config (NEVER
   in CI — chunk 9 env-lint rejects this flag in prod deploys until
   the above hardening lands).
7. Mint a fresh owner token with `scopes.tools: ["run_sql_readonly"]`.
   Existing tokens do not inherit the new capability; the opt-in
   is explicit per-token.

Until all six happen, `run_sql_readonly` stays locked. The locked
state is exercised by `tests/integration/mcp/run-sql-readonly.test.ts`
to catch accidental unlocking.

## Deferred items (not blocking MCP operation)

- **Customer-facing chatbot.** Deferred to post-revenue (prd §4
  "Deferred"). MCP today is operator-only.
- **Autonomous ops agents.** Cron-triggered agents (daily digest,
  stock watchdog, refund/fraud watcher, SEO drift, log triage, backup
  verifier) land in Phase 2+. Each is a Claude tool-use loop calling
  MCP. Agent tokens will be scoped to the minimum tool set per agent
  — don't hand an owner-role PAT to a cron job.
- **`search_audit_log` MCP tool.** Planned for Phase 4 so owners can
  ask "who changed the price on product X?". Not in chunk 7.
- **`search_products` / `get_product` / `list_categories`.** Catalog
  read tools in Phase 1a/1b. Not in chunk 7; `create_product` is the
  chunk-7 proof-of-shape write.

## Debugging tips

- **"Tool called but nothing happened."** Check `last_used_at` on the
  token in the admin UI — if it's not updating, the token never
  reached the adapter (routing / auth problem). If it IS updating
  but the tool failed, check the audit log (owner audit via
  `pnpm db:seed:dev` + a local Postgres client for dev).
- **"Claude Desktop says 'tool not available'."** The tool was
  hidden by `isVisibleFor(ctx)`. Check the role on the PAT you're
  using. Owner-scope PATs see the most; support sees the least.
- **"MCP server returns 413."** Request body exceeded 64KB. Almost
  always a malformed or accidentally-huge tool-call payload. The cap
  is deliberate.
- **"MCP server returns 403 with `session required`."** You're trying
  to call a tRPC route (`tokens.*`) via the tRPC HTTP endpoint with a
  bearer token. Those routes require session-login. Use the admin
  UI for token management.
- **Arabic response from a tool.** Tool response locale follows the
  caller's identity locale preference, not the tool invocation
  language. Phase 3 adds Arabic MCP response tuning; today tool
  responses are English-biased.

## Phase 7 changes ahead (for awareness)

When the custom RBAC system lands in Phase 7, PATs become
permission-scoped rather than role-scoped. The mint form will offer
a checklist of permissions (e.g. `products.create`, `orders.refund`,
`tokens.manage`) drawn from the caller's own permission set. Tokens
cannot be minted wider than the minter's current capabilities.

The MCP `authorize` contract across tools will also migrate: each
tool's `isVisibleFor` / `authorize` will ask "does the caller hold
permission X?" rather than "is the caller role R?". Whether this
migration extracts a shared `requireWritePermission` helper (parallel
to tRPC's `requireRole` → `requirePermission`) or keeps each tool
owning its own check is a 7.6.3 CP-review call — see `auth.md`
§"Parallel-path question for MCP".

## See also

- `auth.md` — session cookies, bearer tokens, `requireRole`
  middleware, `tokens.*` session-only posture.
- `audit-log.md` — hash chain, PDPL scrub path, correlation IDs.
- `database-roles.md` — `app_user` / `app_migrator` /
  `app_tenant_lookup` split + RLS. Relevant because bearer
  authentication queries run through `withPreAuthTenant` under
  `app_user`.
