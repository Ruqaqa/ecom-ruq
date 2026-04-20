# Services contract

All writes to the database go through this directory. Each service function has:

- a Zod input schema
- a Zod output schema
- a tenant-scoped implementation that takes an open Drizzle transaction as its
  first argument; it **never** opens its own transaction and **never** reads
  `app.tenant_id` from the environment.

## The adapter rule

Service functions are wrapped by an *adapter* (tRPC procedure, MCP tool handler,
or internal job). The adapter is responsible for everything the service must
not touch:

```
adapter:
  withTenant(appDb, tenantId, async (tx) => {
    const before = await loadCurrentState(tx, input)     // optional
    const after  = await serviceFn(tx, input)
    await auditInsert(tx, { operation, actor, input, before, after, outcome: 'success' })
    return after
  })
```

If any step throws, the whole transaction rolls back. Audit rows cannot exist
without the state they describe, and state cannot exist without its audit row.

## What services must NOT do

- Open a transaction (`db.transaction`, `db.begin`).
- Call `withTenant` (the adapter already did).
- Write audit rows directly.
- Read `app.tenant_id` via `current_setting(...)` — read `tenantId` from their
  explicit function arguments.
- Import `NextResponse`, `Headers`, or anything HTTP-specific.
- Call external services that aren't part of the domain (emails are a domain
  concern wrapped in their own service; webhooks from payments come through
  dedicated adapters).

## Why this split

1. **Testability.** A service function takes a `tx` and a typed input, returns
   a typed output. Unit tests open a tx against a local Postgres and exercise
   the function directly.
2. **Reuse.** The same service function serves tRPC (web), MCP (AI), and cron
   (background) without duplication.
3. **Audit correctness.** Audit is cross-cutting. Putting it at the adapter
   ensures every mutation path records it; putting it inside service functions
   means every new service author must remember to call it.
4. **Transaction correctness.** Opening the tx at the adapter is the only way
   to guarantee `SET LOCAL app.tenant_id` survives across the service body *and*
   the audit insert.

See prd.md §3.7 for the broader service + MCP doctrine.
