// MCP boundary speaks in SAR (decimal riyals), not halalas. The service
// layer stays in halalas (the storage unit, exact integer math). The
// AI surface is operator-friendly: "850.50" goes in, "850.50" comes out.
//
// `deletedAt` (Date | null) on the service shapes becomes `deletedAtIso`
// (string | null) on the MCP wire — JSON-friendly and unambiguous. The
// service Date is omitted from the MCP shape so MCP clients never see
// two representations of the same moment.

import { z } from "zod";
import {
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "@/server/services/products/create-product";

const ProductMcpBase = ProductPublicSchema.omit({ deletedAt: true }).extend({
  deletedAtIso: z.string().datetime().nullable(),
});

export const ProductPublicMcpSchema = ProductMcpBase;
export type ProductPublicMcp = z.infer<typeof ProductPublicMcpSchema>;

export const ProductOwnerMcpSchema = ProductMcpBase.extend({
  costPriceSar: z.number().nullable(),
});
export type ProductOwnerMcp = z.infer<typeof ProductOwnerMcpSchema>;

export function productToMcpShape(
  p: ProductOwner | ProductPublic,
): ProductOwnerMcp | ProductPublicMcp {
  const deletedAtIso =
    p.deletedAt === null ? null : p.deletedAt.toISOString();
  if ("costPriceMinor" in p) {
    const { costPriceMinor, deletedAt: _omit, ...rest } = p;
    return {
      ...rest,
      deletedAtIso,
      costPriceSar:
        costPriceMinor === null ? null : costPriceMinor / 100,
    };
  }
  const { deletedAt: _omit2, ...rest } = p;
  return { ...rest, deletedAtIso };
}

export function sarToHalalas(sar: number): number {
  return Math.round(sar * 100);
}
