import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: ["scanner.spec.js", "names.spec.js", "theme.spec.js", "polish.spec.js", "id-reader.spec.js", "support.spec.js", "add-wizard.spec.js", "document-alerts.spec.js", "archive.spec.js", "audit.spec.js", "reports.spec.js", "users.spec.js", "family-vehicles.spec.js", "login-setup.spec.js"], workers: 1, timeout: 30000,
  reporter: "list", outputDir: "test-results",
  use: { baseURL: "http://127.0.0.1:1427", browserName: "chromium", channel: "msedge", viewport: { width: 1200, height: 850 } },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 1427", url: "http://127.0.0.1:1427/tests/scanner-harness.html", reuseExistingServer: false },
});
