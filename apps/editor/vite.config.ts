import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetCatalogPlugin } from "../../packages/shared/src/vite-asset-catalog";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  // the editor reuses the game's rendering modules and the shared asset pipeline;
  // it serves the same public/ assets and reads/writes maps in the repo root.
  publicDir: path.resolve(repoRoot, "public"),
  resolve: {
    alias: {
      "@slopwars/shared": path.resolve(repoRoot, "packages/shared/src/index.ts"),
      "@game": path.resolve(repoRoot, "apps/game/src"),
    },
  },
  plugins: [assetCatalogPlugin({ root: repoRoot, editor: true })],
  build: { target: "es2020", chunkSizeWarningLimit: 4096 },
  server: { allowedHosts: true },
});
