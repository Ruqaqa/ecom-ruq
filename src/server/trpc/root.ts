/**
 * Root tRPC router.
 *
 * Sub-routers are registered here. Every mutation inside a sub-router must
 * use `mutationProcedure` (enforced by `pnpm check:e2e-coverage`).
 */
import { router } from "./init";
import { productsRouter } from "./routers/products";

export const appRouter = router({
  products: productsRouter,
});

export type AppRouter = typeof appRouter;
