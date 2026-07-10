import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetCatalogPlugin } from "../../packages/shared/src/vite-asset-catalog";
import { editorHostPlugin } from "./host/plugin";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  // The editor is a browser app served by its own Vite dev server, which doubles
  // as the "editor host": it reuses the game's rendering modules and the shared
  // asset pipeline (virtual:asset-catalog), serves the same public/ assets, and —
  // via editorHostPlugin — provides the file API, the browser bridge, and the MCP
  // server, all in one process. Nothing writes files but the host (git-first).
  publicDir: path.resolve(repoRoot, "public"),
  resolve: {
    alias: {
      "@slopwars/shared": path.resolve(repoRoot, "packages/shared/src/index.ts"),
      "@game": path.resolve(repoRoot, "apps/game/src"),
    },
  },
  plugins: [
    assetCatalogPlugin({ root: repoRoot }),
    editorHostPlugin({ root: repoRoot }),
  ],
  build: { target: "es2020", chunkSizeWarningLimit: 4096 },
  server: { allowedHosts: true },
});
