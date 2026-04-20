/**
 * Lighthouse CI budgets for mobile. Mirrors CLAUDE.md §3:
 * p75 LCP < 2.5s, CLS < 0.1, JS initial bundle < 200 KB gz. INP is a field
 * metric and cannot be measured in a lab run, so total-blocking-time is used
 * as the lab proxy (Google's recommendation).
 *
 * Run `pnpm lhci` locally; in CI the workflow runs it against a production
 * build started on port 5001.
 */
module.exports = {
  ci: {
    collect: {
      url: ["http://localhost:5001/en", "http://localhost:5001/ar"],
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        emulatedFormFactor: "mobile",
        throttlingMethod: "simulate",
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["warn", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.95 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "total-blocking-time": ["warn", { maxNumericValue: 200 }],
        "resource-summary:script:size": ["error", { maxNumericValue: 204800 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: "./.lighthouseci",
    },
  },
};
