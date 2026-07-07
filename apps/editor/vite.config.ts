import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetCatalogPlugin } from "../../packages/shared/src/vite-asset-catalog";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

// The editor is a Tauri desktop app: Vite only builds the webview frontend, while
// file operations and the MCP bridge live in the Rust backend (src-tauri/). We
// still reuse the game's rendering modules and the shared asset pipeline — the
// asset-catalog plugin provides the `virtual:asset-catalog` / `virtual:map-catalog`
// modules the game code imports. Writes (save/import) no longer go through Vite
// middleware, so the plugin runs without the editor API (`editor:false`).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  publicDir: path.resolve(repoRoot, "public"),
  resolve: {
    alias: {
      "@slopwars/shared": path.resolve(repoRoot, "packages/shared/src/index.ts"),
      "@game": path.resolve(repoRoot, "apps/game/src"),
    },
  },
  plugins: [assetCatalogPlugin({ root: repoRoot })],

  // Tauri expects a fixed dev port and quieter output; it also injects TAURI_* env
  // vars that we expose to the client alongside the usual VITE_ prefix.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Tauri targets a modern webview (Chromium on Win/Linux, WebKit on macOS).
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    chunkSizeWarningLimit: 4096,
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
