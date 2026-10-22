const { defineConfig, devices } = require("@playwright/test");
const { ADMIN_HASSWORD } = require("./e2e/admin-hassword.cjs");

const fakePort = 8787;
const appPort = 8788;
const fake = `http://127.0.0.1:${fakePort}`;
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } };
const phone = devices["iPhone 13"];

module.exports = defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.cjs",
  fullyParallel: true,
  // The app runs at most 2 rewrites at once; more workers would only queue behind them.
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${appPort}` },
  // The admin tests change the styles every page sees, so they run alone, after the others, one at a time.
  projects: [
    { name: "desktop", testIgnore: "**/admin.spec.cjs", use: { ...desktop } },
    { name: "phone", testIgnore: "**/admin.spec.cjs", use: { ...phone } },
    {
      name: "admin-desktop",
      testMatch: "**/admin.spec.cjs",
      workers: 1,
      dependencies: ["desktop", "phone"],
      use: { ...desktop },
    },
    {
      name: "admin-phone",
      testMatch: "**/admin.spec.cjs",
      workers: 1,
      dependencies: ["admin-desktop"],
      use: { ...phone },
    },
  ],
  webServer: [
    {
      command: "node e2e/fake-upstream.mjs",
      url: `${fake}/health`,
      env: { FAKE_UPSTREAM_PORT: String(fakePort) },
      reuseExistingServer: !process.env.CI,
    },
    // In CI the app runs as the built container instead, and BASE_URL points at it.
    ...(process.env.BASE_URL
      ? []
      : [
          {
            command: "node src/server/main.ts",
            url: `http://127.0.0.1:${appPort}/health`,
            env: {
              PORT: String(appPort),
              JEV_API_KEY: "fake",
              JEV_BASE_URL: fake,
              CLAUDE_CODE_OAUTH_TOKEN: "fake",
              ANTHROPIC_BASE_URL: fake,
              ADMIN_HASSWORD,
              DATA_DIR: `${process.env.TMPDIR ?? "/tmp"}/easywords-e2e-data`,
              HOME: `${process.env.TMPDIR ?? "/tmp"}/easywords-e2e-home`,
            },
            reuseExistingServer: !process.env.CI,
          },
        ]),
  ],
});
