import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Ignore ALL build output folders so Vite never tries to watch
      // locked .exe files produced by Cargo on Windows
      ignored: [
        "**/src-tauri/target/**",
        "**/target/**",
        "**/node_modules/**",
      ],
    },
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    outDir: "dist",
  },
});
