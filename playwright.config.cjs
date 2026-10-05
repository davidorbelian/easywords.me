const { defineConfig, devices } = require("@playwright/test");

const fakePort = 8787;
const appPort = 8788;
const fake = `http://127.0.0.1:${fakePort}`;

module.exports = defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.cjs",
  fullyParallel: true,
  // The app runs at most 2 rewrites at once; more workers would only queue behind them.
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${appPort}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { ...devices["iPhone 13"] } },
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
              HOME: `${process.env.TMPDIR ?? "/tmp"}/easywords-e2e-home`,
            },
            reuseExistingServer: !process.env.CI,
          },
        ]),
  ],
});
