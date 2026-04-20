/**
 * Same-origin returnTo whitelist for auth landings.
 *
 * Open-redirect prevention: any non-relative target is rejected. The only
 * accepted shape is a single-leading-slash path (optionally with query +
 * hash). We reject path traversal, backslash smuggling, control chars,
 * absolute URLs, protocol-relative URLs, and non-http schemes.
 *
 * Per the chunk 5 plan, this is the only gate between a user-supplied
 * ?returnTo= and the post-verify redirect. Callers MUST fall back to a safe
 * default (e.g. `/{locale}/account`) when this returns false.
 */
export function isSafeReturnTo(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0) return false;
  if (path[0] !== "/") return false;
  // `//host` is a protocol-relative URL; reject.
  if (path.length > 1 && path[1] === "/") return false;
  // `/\host` is a backslash trick some parsers resolve as host-relative.
  if (path.length > 1 && path[1] === "\\") return false;
  // Control characters, newlines, nulls — prevent header/response smuggling.
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  // Traversal. We reject any literal `..` segment; the `/` check above
  // already rejects a leading `..`.
  if (/(^|\/)\.\.(\/|$)/.test(path)) return false;
  return true;
}
