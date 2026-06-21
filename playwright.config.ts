import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const useSystemChrome = !process.env.CI && process.platform === "win32";
const skipManagedWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: useSystemChrome ? "chrome" : "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(useSystemChrome
          ? {
              channel: "chrome",
              launchOptions: {
                args: [
                  "--disable-background-mode",
                  "--disable-background-networking",
                  "--disable-extensions",
                ],
              },
            }
          : {}),
      },
    },
  ],
  webServer: skipManagedWebServer
    ? undefined
    : {
        command: "node ./scripts/playwright-next-server.cjs",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
