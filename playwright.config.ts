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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [...mobileProjects, ...desktopProjects],
  webServer: {
    command: "pnpm dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
};

if (process.env.CI) config.workers = 2;

export default defineConfig(config);
