/**
 * Next.js 15 instrumentation hook. Fires ONCE at server start, before the
 * first request is handled. Chunk 10 wires the boot-time production
 * guards here — the env-flag denylist and the Better Auth DB role check.
 *
 * Guarded on `NEXT_RUNTIME === "nodejs"` so the Edge runtime (which some
 * middleware surfaces can use) does not re-run boot guards that depend
 * on Node-only APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runBootGuards } = await import("./server/boot/production-guards");
  runBootGuards();
}
