/**
 * BA `hooks.before` rate-limit enforcement.
 *
 * Wires the Redis sliding-window primitive (`./rate-limit.ts`) into the
 * auth endpoints that matter: sign-up, sign-in (password + magic-link),
 * forget/reset-password. Called from `auth-server.ts` inside
 * `createAuthMiddleware`, which provides the raw `Request` + parsed body.
 *
 * Policy (per-endpoint, chosen for attack-mix defense — see block 5 brief):
 *   - Per-IP + per-identity two-tier: one lock per attack vector. Password
 *     spray across many emails from one IP is caught by the per-IP bucket;
 *     credential stuffing hammering one email from many IPs is caught by
 *     the per-identity bucket.
 *   - Bucket key prefix `auth:{tenantId}:{path}:` — the tenantId is the
 *     isolation boundary. Tenant A's attack cannot lock tenant B, and one
 *     tenant's traffic does not share a key space with another.
 *
 * IP extraction: reads ONLY `x-real-ip` (Traefik's default trusted-client
 * header, which the proxy overwrites on each request). We deliberately
 * do NOT read `x-forwarded-for` — an attacker can submit XFF directly,
 * and Traefik's default is append-mode, so the first entry is
 * attacker-controlled. In dev (no proxy in front of `pnpm dev`) the
 * fallback activates and every caller shares the 'unknown-ip' bucket;
 * NODE_ENV-gated dev-skip below prevents this collapsing dev usability.
 * In prod Coolify + Traefik set `x-real-ip`; if the proxy is
 * misconfigured and drops it, we fail closed against the global
 * 'unknown-ip' bucket. See High-02 note in docs/runbooks/auth.md.
 *
 * Fail-closed on Redis outage: `checkRateLimit` throws when the Redis
 * pipeline returns null. We wrap in try/catch and convert to an
 * APIError('SERVICE_UNAVAILABLE'). We NEVER swallow the error and allow
 * the auth request through — that would be fail-open, which is the
 * wrong default for auth.
 */
import { APIError } from "better-auth/api";
import { checkRateLimit } from "./rate-limit";
import { writeAuditInOwnTx } from "@/server/audit/write";
import {
  assertProxyHeaderPresent,
  ProductionGuardError,
} from "@/server/boot/production-guards";

interface AuthLimitPolicy {
  /** Requests per IP within ipWindow seconds. */
  ipLimit: number;
  ipWindow: number;
  /** Requests per identity (email) within idWindow seconds. Set undefined to skip the tier. */
  idLimit?: number;
  idWindow?: number;
  /** Which identity field we key on. `'email'` reads from body.email; `'ip'` means no identity-tier bucket. */
  identityKey: "ip" | "email";
}

export const AUTH_LIMITS: Record<string, AuthLimitPolicy> = {
  // 20/min per IP catches password-spray; 5/15min per email catches enumeration.
  "/sign-up/email": {
    ipLimit: 20,
    ipWindow: 60,
    idLimit: 5,
    idWindow: 900,
    identityKey: "email",
  },
  // Same IP window as sign-up; tighter per-email window (5/min) catches
  // credential stuffing against a known-valid email.
  "/sign-in/email": {
    ipLimit: 20,
    ipWindow: 60,
    idLimit: 5,
    idWindow: 60,
    identityKey: "email",
  },
  // Forget-password triggers a high-cost side effect (email send). Tight
  // per-email limit (3/hour) forces an attacker to enumerate targets;
  // moderate per-IP (10/5min) still catches mass scanning.
  "/forget-password": {
    ipLimit: 10,
    ipWindow: 300,
    idLimit: 3,
    idWindow: 3600,
    identityKey: "email",
  },
  // Reset-password is token-gated (BA issues a one-shot token in the email
  // link). Tight per-IP (5/min) post-Low-06: token entropy already defeats
  // brute force; the limit exists to keep audit-chain signal clean and
  // prevent CSRF-hammering patterns without making a legitimate fat-finger
  // retry impossible.
  "/reset-password": {
    ipLimit: 5,
    ipWindow: 60,
    idLimit: 10,
    idWindow: 900,
    identityKey: "ip",
  },
  // Magic-link request: tight per-email (3/15min) — expensive email send.
  "/sign-in/magic-link": {
    ipLimit: 10,
    ipWindow: 60,
    idLimit: 3,
    idWindow: 900,
    identityKey: "email",
  },
  // Magic-link verify: loose — token-gated, cheap, and legitimate users
  // clicking the email link from a shared IP shouldn't hit a cap.
  "/magic-link/verify": {
    ipLimit: 30,
    ipWindow: 60,
    idLimit: 20,
    idWindow: 60,
    identityKey: "ip",
  },
};

/**
 * IP extraction reads ONLY `x-real-ip`. We deliberately do NOT read
 * `x-forwarded-for` — an attacker can submit XFF directly and Traefik's
 * default is to APPEND (not overwrite), so reading the first entry gives
 * the attacker-chosen value. Instead we require Coolify/Traefik to set
 * `x-real-ip` (Traefik's default trusted-client-IP header). The reverse
 * proxy overwrites any client-supplied `x-real-ip`, so this header is
 * the single-source-of-truth client IP.
 *
 * Deployments without this proxy config will see `'unknown-ip'` for
 * every caller — the dev-bypass branch covers this for `pnpm dev`; prod
 * deployments without Traefik's x-real-ip config fail closed (per-IP
 * tier still applies against a single global 'unknown-ip' bucket,
 * annoying for legitimate users but NOT an exfiltration risk).
 *
 * Runbook at docs/runbooks/auth.md documents the Traefik requirement.
 */
export function extractIp(headers: Headers): string {
  const xri = headers.get("x-real-ip");
  if (xri) {
    const trimmed = xri.trim();
    if (trimmed) return trimmed;
  }
  return "unknown-ip";
}

/**
 * Normalize email for rate-limit bucket keys. Lower-cases, NFKC-normalizes,
 * trims whitespace, AND strips the plus-alias suffix of the local-part.
 * This is the BUCKET key normalization ONLY — NEVER passed to Better Auth
 * or stored anywhere. BA must see the raw caller-supplied email to do its
 * own lookup; the bucket normalization exists so an attacker cannot defeat
 * the per-email tier by rotating `victim+1@`, `victim+2@`, ...
 *
 * Accepts false positives on the rare corporate `team+dev@...` case where
 * two real users share a prefix: they'll share the per-email limit,
 * acceptable cost for the bypass prevention.
 *
 * Unicode: NFKC normalizes compatibility-equivalent sequences but does
 * NOT fold visual homoglyphs (e.g. Latin 'i' vs Turkish dotless 'ı'
 * stay distinct). Plus-alias = merge; homoglyphs = separate buckets.
 *
 * Returns null on malformed input; caller SHOULD treat null as "skip
 * per-email tier" rather than rejecting the request entirely (BA will
 * produce its own validation error).
 */
export function normalizeEmailForBucket(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().normalize("NFKC");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
  const atIdx = cleaned.lastIndexOf("@");
  const local = cleaned.slice(0, atIdx);
  const domain = cleaned.slice(atIdx + 1);
  const plusIdx = local.indexOf("+");
  const canonicalLocal = plusIdx >= 0 ? local.slice(0, plusIdx) : local;
  return `${canonicalLocal}@${domain}`;
}

export interface EnforceInput {
  path: string;
  tenantId: string;
  headers: Headers;
  body: unknown;
}

export interface EnforceResult {
  allowed: boolean;
  /** When `allowed === false`, which tier rejected: 'ip' or the identity key. */
  reason?: "ip" | "email";
}

/**
 * Returns `{ allowed: true }` when the request may proceed. Returns
 * `{ allowed: false, reason }` when rejected AFTER writing the audit row.
 * Callers (the BA hook) should convert a rejection into
 * `APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED' })`.
 *
 * Throws `APIError('SERVICE_UNAVAILABLE')` on Redis outage — fail-closed.
 */
export async function enforceAuthRateLimit(input: EnforceInput): Promise<EnforceResult> {
  // Chunk 10 proxy-header guard — in real production, require x-real-ip.
  // The /api/auth/* routes are excluded from the Next.js middleware matcher,
  // and this is the critical consumer of x-real-ip (per-IP bucket key).
  // In dev / e2e, `isRealProduction()` returns false and this is a no-op.
  try {
    assertProxyHeaderPresent(input.headers);
  } catch (err) {
    if (err instanceof ProductionGuardError) {
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Reverse proxy did not set x-real-ip.",
        code: "PROXY_HEADER_MISSING",
      });
    }
    throw err;
  }

  const policy = AUTH_LIMITS[input.path];
  if (!policy) return { allowed: true };

  // ---------------------------------------------------------------
  // E2E bypass — DOUBLE-GATED and prod-unreachable by design.
  // ---------------------------------------------------------------
  // Playwright runs against `pnpm build && pnpm start` (NODE_ENV=production
  // per Next.js, per CLAUDE.md §1). A single NODE_ENV gate would block
  // the bypass under E2E. We therefore separate "runtime mode"
  // (NODE_ENV, owned by Next.js) from "deployment target" (APP_ENV,
  // ours). APP_ENV is set by Playwright's webServer.env to `"e2e"` and
  // by nothing else. Real prod deploys (Coolify) neither set APP_ENV
  // nor E2E_AUTH_RATE_LIMIT_DISABLED, so the bypass is unreachable.
  //
  // Two independent conditions BOTH required:
  //   - `APP_ENV === 'e2e'` — deliberate test deployment target.
  //   - `E2E_AUTH_RATE_LIMIT_DISABLED === '1'` — explicit opt-in flag.
  // Either missing in a prod container → bypass OFF.
  //
  // Per-request opt-OUT: the block-8 PII canary tests need the real
  // rate-limit-exceeded audit path to fire, but the E2E server-level
  // bypass disables it. Request header `x-dev-only-enforce-rate-limit: 1`
  // disables the bypass for that one call, letting the test saturate
  // the per-email budget and exercise the failure-audit write. The
  // opt-out is nested UNDER the outer bypass gate, so a prod
  // container (APP_ENV unset) ignores the header entirely — the
  // outer condition fails first and rate-limiting runs as normal.
  // This does not widen the prod attack surface.
  if (
    process.env.E2E_AUTH_RATE_LIMIT_DISABLED === "1" &&
    process.env.APP_ENV === "e2e" &&
    input.headers.get("x-dev-only-enforce-rate-limit") !== "1"
  ) {
    return { allowed: true };
  }

  const ip = extractIp(input.headers);

  // ---------------------------------------------------------------
  // Dev-unknown-proxy IP-tier skip.
  // ---------------------------------------------------------------
  // pnpm dev has no reverse proxy, so extractIp() returns 'unknown-ip'
  // for every caller and the cap collapses dev usability. Skip the
  // per-IP tier when BOTH:
  //   - ip === 'unknown-ip' (no proxy header observed), AND
  //   - NODE_ENV !== 'production' (we're on a dev machine, not a
  //     deployed container).
  // The per-identity (email) tier STILL fires, so credential-stuffing
  // dev tests remain meaningful. Production containers have
  // NODE_ENV=production AND a Traefik/Coolify proxy setting
  // `x-real-ip` — if the proxy is ever misconfigured and drops it,
  // this branch does NOT activate (NODE_ENV gate blocks it) and prod
  // fails closed against the global 'unknown-ip' bucket.
  const skipIpTierInDevUnknownProxy =
    ip === "unknown-ip" && process.env.NODE_ENV !== "production";

  const ipBucket = `auth:${input.tenantId}:${input.path}:ip:${ip}`;

  let ipAllowed = true;
  let idAllowed = true;
  let idTriggered = false;
  try {
    if (!skipIpTierInDevUnknownProxy) {
      const ipResult = await checkRateLimit({
        bucket: ipBucket,
        limit: policy.ipLimit,
        windowSeconds: policy.ipWindow,
      });
      ipAllowed = ipResult.allowed;
    }

    if (policy.identityKey === "email" && policy.idLimit && policy.idWindow) {
      const body = (input.body ?? {}) as { email?: unknown };
      const emailRaw = typeof body.email === "string" ? body.email : null;
      const email = emailRaw ? normalizeEmailForBucket(emailRaw) : null;
      if (email) {
        const idBucket = `auth:${input.tenantId}:${input.path}:email:${email}`;
        const idResult = await checkRateLimit({
          bucket: idBucket,
          limit: policy.idLimit,
          windowSeconds: policy.idWindow,
        });
        idAllowed = idResult.allowed;
        idTriggered = true;
      }
    }
  } catch (err) {
    // Fail-closed: Redis is down. Convert to 503 so the client retries
    // the whole request rather than silently being allowed through.
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Rate limiter unavailable. Please retry.",
      code: "RATE_LIMITER_UNAVAILABLE",
      cause: err,
    });
  }

  if (ipAllowed && idAllowed) {
    return { allowed: true };
  }

  // Reject path: audit the event before returning. `errorCode: "rate_limited"`
  // lands `audit_log.error = '{"code":"rate_limited"}'` per the block-2
  // closed-set invariant. Input carries only the structural facts — never
  // the raw body (which would embed a Tier-B email in the chain).
  const reason: "ip" | "email" = !ipAllowed ? "ip" : "email";
  await writeAuditInOwnTx({
    tenantId: input.tenantId,
    operation: "auth.rate-limit-exceeded",
    actorType: "anonymous",
    actorId: null,
    tokenId: null,
    outcome: "failure",
    input: {
      path: input.path,
      ipLimited: !ipAllowed,
      emailLimited: idTriggered && !idAllowed,
    },
    errorCode: "rate_limited",
  });

  return { allowed: false, reason };
}
