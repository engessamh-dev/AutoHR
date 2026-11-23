import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: ["scanner.spec.js", "names.spec.js"], workers: 1, timeout: 30000,
  reporter: "list", outputDir: "test-results",
  use: { baseURL: "http://127.0.0.1:1427", browserName: "chromium", channel: "msedge", viewport: { width: 1200, height: 850 } },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 1427", url: "http://127.0.0.1:1427/tests/scanner-harness.html", reuseExistingServer: false },
});
