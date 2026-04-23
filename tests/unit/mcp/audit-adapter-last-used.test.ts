/**
 * `bumpLastUsedAt` under the REAL `app_user` role — sub-chunk 7.6.1
 * Block F-3.
 *
 * The bump writes `access_tokens.last_used_at = now()`. Before Block D,
 * it called `appDb.update(...)` directly without a `withTenant` scope:
 * under `app_user`, the RLS `USING (tenant_id = ...)` predicate would
 * filter the UPDATE to zero rows. After Block D, the audit-adapter
 * caller wraps the bump in `withTenant` which sets `app.tenant_id`
 * before the UPDATE fires.
 *
 * F-3-round-trip is intentionally NOT covered here — `bumpLastUsedAt`
 * rides `withTenant` proper (not the pre-auth helper), and
 * `withTenant`'s round-trip verify is already covered at
 * tests/unit/db/with-tenant.test.ts. Adding a third round-trip spec
 * would be duplication.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { accessTokens } from "@/server/db/schema/tokens";
import { dispatchTool } from "@/server/mcp/audit-adapter";
import type { McpRequestContext } from "@/server/mcp/context";
import type { McpTool } from "@/server/mcp/tools/registry";
import type { Tenant } from "@/server/tenant";
import { __setRedisForTests } from "@/server/auth/last-used-debounce";
import { z } from "zod";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

const superSql = postgres(DATABASE_URL, { max: 2 });

const tenantA = randomUUID();
const userId = randomUUID();
let tokenRowId: string | null = null;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.TOKEN_HASH_PEPPER) {
    env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
  }

  const nameA = { en: "A", ar: "أ" };
  await superSql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, status, name, sender_email)
    VALUES (
      ${tenantA},
      ${`lu-a-${tenantA.slice(0, 8)}`},
      ${`lu-a-${tenantA.slice(0, 8)}.test.local`},
      'en', 'active', ${superSql.json(nameA)},
      ${`no-reply@lu-a-${tenantA.slice(0, 8)}.test.local`}
    )
  `;
  await superSql`
    INSERT INTO "user" (id, email, email_verified)
    VALUES (${userId}, ${`lu-${userId.slice(0, 8)}@example.com`}, true)
  `;
  await superSql`
    INSERT INTO memberships (id, tenant_id, user_id, role)
    VALUES (${randomUUID()}, ${tenantA}, ${userId}, 'owner')
  `;
  const [row] = await superSql<Array<{ id: string }>>`
    INSERT INTO access_tokens (user_id, tenant_id, name, token_hash, token_prefix, scopes)
    VALUES (
      ${userId}, ${tenantA}, 'lu-a',
      ${Buffer.alloc(32, 1)}, 'luprefix', ${superSql.json({ role: "owner" })}
    )
    RETURNING id
  `;
  if (!row) throw new Error("failed to seed access_tokens row");
  tokenRowId = row.id;
});

afterAll(async () => {
  if (tokenRowId) {
    await superSql`DELETE FROM access_tokens WHERE id = ${tokenRowId}`;
  }
  await superSql`DELETE FROM memberships WHERE user_id = ${userId}`;
  await superSql`DELETE FROM "user" WHERE id = ${userId}`;
  await superSql`DELETE FROM tenants WHERE id = ${tenantA}`;
  await superSql.end({ timeout: 5 });
});

function tenantRec(): Tenant {
  return {
    id: tenantA,
    slug: `lu-a-${tenantA.slice(0, 8)}`,
    primaryDomain: `lu-a-${tenantA.slice(0, 8)}.test.local`,
    defaultLocale: "en",
    senderEmail: `no-reply@lu-a-${tenantA.slice(0, 8)}.test.local`,
    name: { en: "A", ar: "أ" },
  };
}

function ctxBearer(tokenId: string): McpRequestContext {
  return {
    tenant: tenantRec(),
    identity: {
      type: "bearer",
      userId,
      tokenId,
      role: "owner",
      scopes: { role: "owner" },
    },
    correlationId: "cid-lu",
  };
}

interface EchoIn {
  x: number;
}
interface EchoOut {
  x: number;
}
const echoTool: McpTool<EchoIn, EchoOut> = {
  name: "echo_lu",
  description: "echo for last-used bump tests",
  inputSchema: z.object({ x: z.number() }).strict(),
  outputSchema: z.object({ x: z.number() }),
  isVisibleFor: () => true,
  authorize: () => {},
  handler: async (_ctx, input) => ({ x: input.x }),
};

describe("audit-adapter — last_used_at bump wrapped in withTenant (Block D)", () => {
  it("F-3-green: after a successful dispatch the token's last_used_at is updated", async () => {
    if (!tokenRowId) throw new Error("missing tokenRowId");
    __setRedisForTests({ set: async () => "OK" } as never);

    const beforeRows = await superSql<Array<{ last_used_at: Date | null }>>`
      SELECT last_used_at FROM access_tokens WHERE id = ${tokenRowId}
    `;
    const beforeTs = beforeRows[0]?.last_used_at ?? null;

    const out = await dispatchTool(
      ctxBearer(tokenRowId),
      echoTool,
      { x: 42 },
      { auditMode: "none" },
    );
    expect(out).toEqual({ x: 42 });

    const afterRows = await superSql<Array<{ last_used_at: Date | null }>>`
      SELECT last_used_at FROM access_tokens WHERE id = ${tokenRowId}
    `;
    const afterTs = afterRows[0]?.last_used_at ?? null;
    expect(afterTs).not.toBeNull();
    if (beforeTs !== null) {
      expect(afterTs!.getTime()).toBeGreaterThanOrEqual(beforeTs.getTime());
    }
  });

  it("F-3-red-gate: raw unwrapped UPDATE under app_user + no GUC updates zero rows (regression detector)", async () => {
    if (!tokenRowId) throw new Error("missing tokenRowId");

    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      // UPDATE under app_user with no app.tenant_id GUC. RLS filters the
      // WHERE predicate (tenant_id = nullif(current_setting, '')::uuid)
      // to NULL — the UPDATE affects zero rows. This stays green after
      // Block D as a regression detector: any future callsite that
      // tries to bump last_used_at without entering a withTenant scope
      // hits this same failure mode.
      const result = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        return tx
          .update(accessTokens)
          .set({ lastUsedAt: sql`now()` })
          .where(
            and(
              eq(accessTokens.id, tokenRowId!),
              eq(accessTokens.tenantId, tenantA),
            ),
          )
          .returning({ id: accessTokens.id });
      });
      expect(result).toEqual([]);
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });
});
