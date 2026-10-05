import js from "@eslint/js";
import tseslint from "typescript-eslint";

const node = { process: "readonly", console: "readonly", setTimeout: "readonly", URL: "readonly" };
const commonjs = { require: "readonly", module: "writable" };
// Code inside page.evaluate() runs in the browser.
const browser = {
  document: "readonly",
  window: "readonly",
  Event: "readonly",
  ClipboardEvent: "readonly",
  DataTransfer: "readonly",
};

export default tseslint.config(
  { ignores: ["dist/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ["scripts/**", "e2e/**", "*.js", "*.cjs", "*.mjs", "*.ts"], languageOptions: { globals: node } },
  { files: ["e2e/**/*.spec.cjs"], languageOptions: { globals: browser } },
  // Playwright from the nix profile is found through NODE_PATH, which only require() honours.
  {
    files: ["**/*.cjs"],
    languageOptions: { globals: commonjs },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
