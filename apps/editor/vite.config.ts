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
  // Insurance: the game's build-identity tokens (defined for real in the game's vite
  // config) so a future refactor that leaks them into an editor-imported @game module
  // fails soft here instead of breaking the editor build.
  define: {
    __GAME_VERSION__: JSON.stringify("dev"),
    __GIT_SHA__: JSON.stringify("dev"),
    __PKG_VERSION__: JSON.stringify("dev"),
  },
  plugins: [
    assetCatalogPlugin({ root: repoRoot }),
    editorHostPlugin({ root: repoRoot }),
  ],
  build: { target: "es2020", chunkSizeWarningLimit: 4096 },
  // Fixed port so the built-in MCP server always lives at http://localhost:5210/mcp
  // (the editor host + MCP client reference it); strictPort fails loudly rather than
  // silently hopping to another port and breaking those references.
  //
  // watch.ignored: Vite full-reloads the page on any publicDir change — but the
  // editor itself WRITES there constantly (map saves, imports, the Poly Haven
  // browser), and a reload silently drops the open documents. The editor refreshes
  // its catalog through /__editor/catalog after every write, so the watcher adds
  // nothing here; publicDir files are still served straight from disk on request.
  server: {
    port: 5210, strictPort: true, allowedHosts: true,
    watch: { ignored: [path.resolve(repoRoot, "public/assets") + "/**"] },
  },
});
