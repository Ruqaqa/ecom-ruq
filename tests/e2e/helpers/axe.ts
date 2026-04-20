import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function expectAxeClean(page: Page, options?: { include?: string[]; disableRules?: string[] }) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (options?.include?.length) builder = builder.include(options.include);
  if (options?.disableRules?.length) builder = builder.disableRules(options.disableRules);
  const results = await builder.analyze();
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
}

function formatViolations(violations: Array<{ id: string; description: string; nodes: unknown[] }>) {
  if (!violations.length) return "no axe violations";
  return violations.map((v) => `${v.id} (${v.nodes.length} nodes): ${v.description}`).join("\n");
}
