/**
 * `validate-variants.ts` — pure helpers for variant + option validation
 * (chunk 1a.5.1, spec §1 "Helpers").
 *
 * Tests the cap constants, the duplicate-combination assertion, and the
 * tuple-shape assertion. Pure functions, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  assertNoDuplicateVariantCombinations,
  assertVariantOptionTupleShape,
} from "@/server/services/variants/validate-variants";

describe("validate-variants — assertNoDuplicateVariantCombinations", () => {
  it("passes when every variant has a unique optionValueIds tuple", () => {
    expect(() =>
      assertNoDuplicateVariantCombinations([
        { optionValueIds: ["a", "b"] },
        { optionValueIds: ["a", "c"] },
        { optionValueIds: ["d", "b"] },
      ]),
    ).not.toThrow();
  });

  it("passes for an empty array (single-default-variant precedes the cartesian check)", () => {
    expect(() => assertNoDuplicateVariantCombinations([])).not.toThrow();
  });

  it("passes when only one variant has an empty tuple (single-default mode)", () => {
    expect(() =>
      assertNoDuplicateVariantCombinations([{ optionValueIds: [] }]),
    ).not.toThrow();
  });

  it("throws duplicate_variant_combination when two variants share the same tuple", () => {
    expect(() =>
      assertNoDuplicateVariantCombinations([
        { optionValueIds: ["a", "b"] },
        { optionValueIds: ["c", "d"] },
        { optionValueIds: ["a", "b"] },
      ]),
    ).toThrow(/duplicate_variant_combination/);
  });

  it("treats tuple ORDER as significant (option position matters)", () => {
    // [a,b] != [b,a] because each option's contribution lives at a fixed index.
    expect(() =>
      assertNoDuplicateVariantCombinations([
        { optionValueIds: ["a", "b"] },
        { optionValueIds: ["b", "a"] },
      ]),
    ).not.toThrow();
  });

  it("throws when two variants both carry an empty tuple", () => {
    // Single-default mode allows ONE empty-tuple variant; a second is a dup.
    expect(() =>
      assertNoDuplicateVariantCombinations([
        { optionValueIds: [] },
        { optionValueIds: [] },
      ]),
    ).toThrow(/duplicate_variant_combination/);
  });
});

describe("validate-variants — assertVariantOptionTupleShape", () => {
  it("passes when every variant's tuple length equals currentOptionCount", () => {
    expect(() =>
      assertVariantOptionTupleShape(
        [
          { optionValueIds: ["a", "b"] },
          { optionValueIds: ["c", "d"] },
        ],
        2,
      ),
    ).not.toThrow();
  });

  it("passes for single-default mode (zero options, exactly one empty-tuple variant)", () => {
    expect(() =>
      assertVariantOptionTupleShape([{ optionValueIds: [] }], 0),
    ).not.toThrow();
  });

  it("throws default_variant_required when zero options but >1 variant", () => {
    expect(() =>
      assertVariantOptionTupleShape(
        [{ optionValueIds: [] }, { optionValueIds: [] }],
        0,
      ),
    ).toThrow(/default_variant_required/);
  });

  it("throws option_value_not_found when a variant tuple length differs from currentOptionCount", () => {
    // The product has 2 option types. A variant carrying only 1 value-id is a malformed tuple.
    expect(() =>
      assertVariantOptionTupleShape(
        [
          { optionValueIds: ["a", "b"] },
          { optionValueIds: ["c"] },
        ],
        2,
      ),
    ).toThrow(/option_value_not_found/);
  });

  it("throws option_value_not_found when a variant tuple is longer than currentOptionCount", () => {
    expect(() =>
      assertVariantOptionTupleShape(
        [{ optionValueIds: ["a", "b", "c"] }],
        2,
      ),
    ).toThrow(/option_value_not_found/);
  });
});
