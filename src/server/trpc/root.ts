/**
 * Root tRPC router.
 *
 * Sub-routers are registered here. Every mutation inside a sub-router must
 * use `mutationProcedure` (enforced by `pnpm check:e2e-coverage`).
 */
import { router } from "./init";
import { productsRouter } from "./routers/products";
import { categoriesRouter } from "./routers/categories";
import { imagesRouter } from "./routers/images";
import { tokensRouter } from "./routers/tokens";

export const appRouter = router({
  products: productsRouter,
  categories: categoriesRouter,
  images: imagesRouter,
  tokens: tokensRouter,
});

export type AppRouter = typeof appRouter;
