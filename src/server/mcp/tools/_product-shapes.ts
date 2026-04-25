// MCP boundary speaks in SAR (decimal riyals), not halalas. The service
// layer stays in halalas (the storage unit, exact integer math). The
// AI surface is operator-friendly: "850.50" goes in, "850.50" comes out.

import { z } from "zod";
import {
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "@/server/services/products/create-product";

export const ProductOwnerMcpSchema = ProductPublicSchema.extend({
  costPriceSar: z.number().nullable(),
});
export type ProductOwnerMcp = z.infer<typeof ProductOwnerMcpSchema>;

export const ProductPublicMcpSchema = ProductPublicSchema;
export type ProductPublicMcp = ProductPublic;

export function productToMcpShape(
  p: ProductOwner | ProductPublic,
): ProductOwnerMcp | ProductPublicMcp {
  if ("costPriceMinor" in p) {
    const { costPriceMinor, ...rest } = p;
    return {
      ...rest,
      costPriceSar:
        costPriceMinor === null ? null : costPriceMinor / 100,
    };
  }
  return p;
}

export function sarToHalalas(sar: number): number {
  return Math.round(sar * 100);
}
