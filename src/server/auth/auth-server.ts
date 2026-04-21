/**
 * Better Auth server instance.
 *
 * Responsibilities:
 *   - Cookie sessions for the web UI (host-only; no Domain attribute —
 *     prd.md §3.1 tenants live on different eTLDs, so a Domain cookie
 *     would either not apply or violate the tenant boundary).
 *   - Email+password sign-up with verification and a bloom-listed
 *     breached-password check (chunk 5 v0: simple top-200 Set).
 *   - Magic-link sign-in with a 10-minute TTL and HMAC-peppered token
 *     hashing via BA's `storeToken: { type: 'custom-hasher' }`.
 *   - Tenant-aware email: every link points at the resolved tenant's
 *     primaryDomain. Resolution happens at the send-callback layer using
 *     the Host header of the incoming request, via `resolveTenant`.
 *     Unknown hosts fail closed (the resolver returns null and we throw).
 *   - Bearer plugin enabled — BA converts signed session JWTs to cookies
 *     for non-browser clients. This does NOT cover PATs (see ADR 0001
 *     option (b) — PATs have a separate lookup at `src/server/auth/bearer-lookup.ts`).
 *   - DB-level rate limiting is off; we gate sign-up / sign-in /
 *     magic-link with our own Redis sliding window at the adapter layer
 *     (see `src/server/auth/rate-limit.ts`). Chunk 5 ships the shared
 *     infrastructure; chunk 6 owns the adapter wrap.
 *
 * Types from `better-auth` MUST NOT leak past this module. Callers consume
 * `auth.api.getSession({ headers })` via `resolve-request-identity.ts`,
 * which returns our own narrow `RequestIdentity` discriminated union.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins/magic-link";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/server/db/schema";
import { resolveTenant } from "@/server/tenant";
import { sendTenantEmail } from "@/server/email/send-tenant-email";
import { isBreachedPassword } from "./breached-passwords";
import { hashMagicLinkToken } from "./magic-link-hash";
import { enforceAuthRateLimit } from "./rate-limit-auth-hook";
import {
  userCreateAfter,
  userUpdateAfter,
  verificationCreateAfter,
  sessionCreateAfter,
  sessionDeleteAfter,
} from "./audit-hooks";
import { writeAuditInOwnTx } from "@/server/audit/write";
import type { AuditErrorCode } from "@/server/audit/error-codes";
import { randomUUID } from "node:crypto";
import type { Locale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";

function mapBAErrorToAuditCode(err: {
  message?: string;
  statusCode?: number;
}): AuditErrorCode {
  const msg = err.message ?? "";
  if (msg.includes("USER_ALREADY_EXISTS")) return "conflict";
  if (err.statusCode === 429) return "rate_limited";
  if (
    msg.includes("PASSWORD_COMPROMISED") ||
    msg.includes("PASSWORD_TOO_SHORT") ||
    msg.includes("new_user_signup_disabled")
  ) {
    return "validation_failed";
  }
  return "internal_error";
}

// We need to build our own Drizzle client here because BA's drizzle adapter
// expects the *original* drizzle client (not the lazy Nullable appDb). Also
// the one we pass here owns the auth table writes, which we deliberately
// run with superuser privileges during sign-up (BA needs to INSERT into
// `user`, `account`, `verification`, `session`). In staging/prod, that
// privilege is held by `app_migrator`-equivalent or a dedicated BA role.
const databaseUrl = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
const baClient = databaseUrl ? postgres(databaseUrl, { max: 4 }) : null;
const baDb = baClient ? drizzle(baClient, { schema }) : null;

if (!baDb) {
  // Fail fast — no DB means the auth routes cannot answer anyway.
  // The `[...all]` handler will surface this as a 500 at request time,
  // which is what we want; we do NOT want to crash the process at import
  // time (the tests and dev-time type-check should still run).
  // In production, a missing DATABASE_URL is a deploy-config bug.
  console.warn("[auth] DATABASE_URL not set; auth routes will 500.");
}

function localeFromRequest(request?: Request): Locale {
  if (!request) return routing.defaultLocale;
  // Primary source: the Referer / Origin path prefix, since the auth
  // pages live under /{locale}/... and the form's fetch target ("/api/auth/...")
  // does not itself carry the locale. This is more deterministic than
  // Accept-Language across browser engines — WebKit quietly appends its
  // own Accept-Language in some configurations.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const path = new URL(referer).pathname;
      if (path.startsWith("/ar/")) return "ar";
      if (path.startsWith("/en/")) return "en";
    } catch {
      /* fall through */
    }
  }
  const accept = request.headers.get("accept-language") ?? "";
  if (/^ar\b/i.test(accept)) return "ar";
  if (/^en\b/i.test(accept)) return "en";
  return routing.defaultLocale;
}

function hostFromRequest(request?: Request): string | null {
  if (!request) return null;
  // `new URL(request.url).host` includes the port, which is what we want
  // for localhost:5001 matching. Fall back to Host header if url is
  // relative (BA sometimes passes a pre-constructed URL).
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return request.headers.get("host")?.toLowerCase() ?? null;
  }
}

export const auth = betterAuth({
  appName: "ecom-ruq",
  // Host-only cookies: leave baseURL unset per-request; BA resolves it from
  // the request's own host. Tenants live on distinct eTLDs so there is no
  // shared cookie domain.
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: ["http://localhost:5001", "https://localhost:5001"],
  rateLimit: {
    // BA's built-in rate limiter is disabled. We own auth rate-limiting
    // at the adapter layer via `src/server/auth/rate-limit.ts` (Redis
    // sliding window). Keeping BA's in-memory counter on would double
    // the policy and cause confusing collisions in parallel tests.
    enabled: false,
  },
  database: baDb
    ? drizzleAdapter(baDb, { provider: "pg", schema, usePlural: false })
    : undefined,
  advanced: {
    // No crossSubDomainCookies => BA omits Domain; cookie is host-only.
    // Explicit `undefined` is belt-and-braces so a future editor cannot
    // flip this without noticing.
    crossSubDomainCookies: undefined,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      // `Secure` only on real HTTPS URLs. When running the production
      // build locally over http://localhost:5001 (e.g. the Playwright
      // suite), Secure cookies would be dropped by the browser and break
      // the flow. We key off the baseURL scheme, not NODE_ENV.
      secure: (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
    },
    database: {
      // Use the DB default `gen_random_uuid()` for id columns (our schema
      // is uuid-typed, not BA's default string ids).
      generateId: false,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url, token: _token }, request) => {
      const tenant = await resolveTenant(hostFromRequest(request));
      if (!tenant) throw new Error("sendResetPassword: no tenant resolved for Host");
      // BA gives us a URL against its own baseURL. We re-route the token
      // into our own landing via sendTenantEmail / buildTenantUrl to keep
      // link construction on the tenant's domain.
      const parsed = new URL(url);
      const extractedToken = parsed.searchParams.get("token") ?? _token;
      await sendTenantEmail({
        tenant,
        to: user.email,
        locale: localeFromRequest(request),
        template: "verify-email",
        params: { token: extractedToken },
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24, // 24h per chunk 5 plan.
    sendVerificationEmail: async ({ user, url, token }, request) => {
      const tenant = await resolveTenant(hostFromRequest(request));
      if (!tenant) throw new Error("sendVerificationEmail: no tenant resolved for Host");
      // Re-route the verify URL at tenant.primaryDomain. BA ships its own
      // /verify-email endpoint under baseURL; we want the user to land on
      // the tenant's domain, hit `/api/auth/verify-email?token=…` there
      // (which is this same BA handler via the `[...all]` route), and then
      // get redirected to `/{locale}/account`.
      const parsed = new URL(url);
      const extractedToken = parsed.searchParams.get("token") ?? token;
      await sendTenantEmail({
        tenant,
        to: user.email,
        locale: localeFromRequest(request),
        template: "verify-email",
        params: { token: extractedToken },
      });
    },
  },
  plugins: [
    bearer(),
    magicLink({
      expiresIn: 60 * 10, // 10 minutes per chunk 5 plan.
      disableSignUp: false,
      storeToken: {
        type: "custom-hasher",
        hash: hashMagicLinkToken,
      },
      sendMagicLink: async ({ email, url, token }, ctx) => {
        const request = ctx?.request ?? undefined;
        const tenant = await resolveTenant(hostFromRequest(request));
        if (!tenant) throw new Error("sendMagicLink: no tenant resolved for Host");
        const parsed = new URL(url);
        const extractedToken = parsed.searchParams.get("token") ?? token;
        await sendTenantEmail({
          tenant,
          to: email,
          locale: localeFromRequest(request),
          template: "magic-link",
          params: { token: extractedToken },
        });
      },
    }),
  ],
  hooks: {
    // Two-step before-chain: rate-limit first (fail-fast, cheaper to
    // reject hostile traffic before any crypto/DB work), then
    // breached-password check on password-writing paths.
    //
    // The rate-limit helper owns: policy lookup, per-tenant bucket key
    // construction, IP/email two-tier check, Redis-outage fail-closed,
    // and audit write on reject. See ./rate-limit-auth-hook.ts.
    before: createAuthMiddleware(async (ctx) => {
      const path = (ctx.path ?? "") as string;

      // Step 1 — rate-limit gate. Only fires for paths in AUTH_LIMITS;
      // unknown paths short-circuit allowed inside the helper.
      const tenant = await resolveTenant(hostFromRequest(ctx.request));
      if (tenant) {
        const result = await enforceAuthRateLimit({
          path,
          tenantId: tenant.id,
          headers: ctx.request?.headers ?? new Headers(),
          body: ctx.body,
        });
        if (!result.allowed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many attempts. Please wait and try again.",
            code: "RATE_LIMITED",
          });
        }
      }

      // Step 2 — breached-password filter on password-writing paths.
      const writesPassword =
        path === "/sign-up/email" ||
        path === "/change-password" ||
        path === "/reset-password";
      if (!writesPassword) return;
      const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
      const candidate =
        typeof body.password === "string"
          ? body.password
          : typeof body.newPassword === "string"
            ? body.newPassword
            : null;
      if (candidate && isBreachedPassword(candidate)) {
        // Audit INLINE before throwing — BA doesn't call hooks.after
        // when hooks.before throws (to-auth-endpoints.mjs:92–93
        // short-circuits). For any audit path that fires from inside
        // hooks.before, write the failure row here. Tenant resolution
        // option B: skip on unknown host.
        if (path === "/sign-up/email" && tenant) {
          await writeAuditInOwnTx({
            tenantId: tenant.id,
            operation: "auth.signup",
            actorType: "anonymous",
            actorId: null,
            tokenId: null,
            outcome: "failure",
            correlationId: randomUUID(),
            errorCode: "validation_failed",
          });
        }
        throw new APIError("BAD_REQUEST", {
          message: "That password has been seen in a breach. Please choose a different one.",
          code: "PASSWORD_COMPROMISED",
        });
      }
    }),
    // Failure-path audit for /sign-up/email. Success is audited at
    // user.create.after (audit-hooks.ts:userCreateAfter). A failure
    // here means BA threw before user creation — duplicate email,
    // validation, rate-limit, etc. Tenant resolution option B: skip
    // on unknown host; Sentry-alert unless APP_ENV=seed.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      const returned = ctx.context.returned as unknown;
      const isError =
        returned != null &&
        typeof returned === "object" &&
        ((returned as { name?: string }).name === "APIError" ||
          returned instanceof Error);
      if (!isError) return;
      const err = returned as { message?: string; statusCode?: number };
      const errorCode = mapBAErrorToAuditCode(err);

      let host: string | null = null;
      if (ctx.request) {
        try {
          host = new URL(ctx.request.url).host.toLowerCase();
        } catch {
          host = null;
        }
      }
      const tenant = host ? await resolveTenant(host) : null;
      if (!tenant) {
        if (process.env.APP_ENV !== "seed") {
          const { captureMessage } = await import("@/server/obs/sentry");
          captureMessage("audit_write_failure", {
            level: "error",
            tags: {
              reason: "tenant_resolution_lost_at_hook",
              operation: "auth.signup",
            },
          });
        }
        return;
      }
      await writeAuditInOwnTx({
        tenantId: tenant.id,
        operation: "auth.signup",
        actorType: "anonymous",
        actorId: null,
        tokenId: null,
        outcome: "failure",
        correlationId: randomUUID(),
        errorCode,
        // NO input, NO after — chain holds structure; Sentry holds
        // detail. Per block-2 High-01 invariant.
      });
    }),
  },
  databaseHooks: {
    user: {
      create: { after: userCreateAfter },
      update: { after: userUpdateAfter },
    },
    session: {
      create: { after: sessionCreateAfter },
      delete: { after: sessionDeleteAfter },
    },
    verification: {
      create: { after: verificationCreateAfter },
    },
  },
});
