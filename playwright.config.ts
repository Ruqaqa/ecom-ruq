import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

const PORT = 5001;
const BASE_URL = `http://localhost:${PORT}`;

const LOCALES = ["en", "ar"] as const;

const mobileDeviceEntries = [
  { name: "iphone-14", device: devices["iPhone 14"] },
  { name: "pixel-7", device: devices["Pixel 7"] },
] as const;

const desktopDeviceEntries = [
  { name: "desktop-chromium", device: devices["Desktop Chrome"] },
] as const;

const mobileProjects = mobileDeviceEntries.flatMap(({ name, device }) =>
  LOCALES.map((locale) => ({
    name: `${name}-${locale}`,
    use: { ...device, locale: locale === "ar" ? "ar-SA" : "en-US", baseURL: BASE_URL },
    metadata: { locale, viewport: "mobile" as const },
  })),
);

const desktopProjects = desktopDeviceEntries.flatMap(({ name, device }) =>
  LOCALES.map((locale) => ({
    name: `${name}-${locale}`,
    use: { ...device, locale: locale === "ar" ? "ar-SA" : "en-US", baseURL: BASE_URL },
    metadata: { locale, viewport: "desktop" as const },
  })),
);

const config: PlaywrightTestConfig = {
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  // Auth flows poll Mailpit after a network round-trip — generous ceiling.
  timeout: 60_000,
  expect: { timeout: 5_000 },
  // Dev-mode Next.js serializes compilation per route; too many parallel
  // tests hammering the same dev server starve each other on first hit.
  // A cap of 4 workers keeps the flow tight without melting the dev pipe.
  // CI retains the same ceiling; the compile cache warms on first run.
  workers: 4,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [...mobileProjects, ...desktopProjects],
  webServer: {
    // Use the production build for e2e: Next.js dev-mode compiles routes
    // on demand and occasionally triggers HMR page-reloads that race the
    // test's own navigation (seen on WebKit/iPhone projects). A built
    // server has deterministic load behaviour.
    command: process.env.PLAYWRIGHT_USE_DEV === "1" ? "pnpm dev" : "pnpm build && pnpm start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  },
};

export default defineConfig(config);
