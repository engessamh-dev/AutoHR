import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;

function updateJson(path, updater) {
  const url = new URL(path, import.meta.url);
  const json = JSON.parse(readFileSync(url, "utf8"));
  updater(json);
  writeFileSync(url, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

updateJson("../src-tauri/tauri.conf.json", config => {
  config.version = version;
});

const cargoUrl = new URL("../src-tauri/Cargo.toml", import.meta.url);
const cargoToml = readFileSync(cargoUrl, "utf8");
writeFileSync(
  cargoUrl,
  cargoToml.replace(/(^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
  "utf8",
);

console.log(`Synced CNSArch version ${version}`);
