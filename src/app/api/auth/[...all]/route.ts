/**
 * Better Auth catch-all handler.
 *
 * Every BA endpoint (sign-up, sign-in, sign-out, verify-email,
 * sign-in/magic-link, etc.) is served under `/api/auth/*`. The locale-
 * prefixed pages call into this handler via `fetch('/api/auth/...')`;
 * tenants live on different hosts so this route is per-tenant-host by
 * virtue of the request's Host header reaching our resolver.
 *
 * We do NOT prefix auth routes by locale. Auth is tenant-scoped, not
 * locale-scoped — the locale of the email content is carried by the
 * `Accept-Language` header at send time.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth-server";

export const { POST, GET } = toNextJsHandler(auth);
