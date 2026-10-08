import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  clearScreen: false,
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Ignore ALL build output folders so Vite never tries to watch
      // locked .exe files produced by Cargo on Windows
      ignored: [
        "**/src-tauri/**",
        "**/src-tauri/target/**",
        "**/target/**",
        "**/node_modules/**",
        "**/verification/**",
        "**/.scanner-local/**",
      ],
    },
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    outDir: "dist",
  },
});
