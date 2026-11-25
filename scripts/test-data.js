#!/usr/bin/env node
/**
 * Starts the development build on invented test data («بيانات تجريبية»).
 *
 *   npm run test-data            first run creates the test data, later runs reuse it
 *   npm run test-data -- --reset deletes the test data and creates it again
 *
 * The program then keeps everything in %APPDATA%\CNSArch-TestData (its own settings, data and
 * backups). The installed program's data and the usual development data are not opened.
 * Sign in with sysadmin / password. See src-tauri/src/devseed.rs.
 */
import { spawn } from "child_process";
import { existsSync, rmSync } from "fs";
import { basename, join } from "path";

const appData = process.env.APPDATA;
if (!appData) {
  console.error("APPDATA is not set: run this on Windows.");
  process.exit(1);
}
const folder = join(appData, "CNSArch-TestData");

if (process.argv.includes("--reset") && existsSync(folder)) {
  if (basename(folder) !== "CNSArch-TestData") process.exit(1);
  rmSync(folder, { recursive: true, force: true });
  console.log(`Deleted the old test data: ${folder}`);
}
console.log(`Test data folder: ${folder}`);
console.log("Sign in with: sysadmin / password");

const child = spawn("npx", ["tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, CNSARCH_TEST_DATA: "1" },
});
child.on("exit", code => process.exit(code ?? 0));
