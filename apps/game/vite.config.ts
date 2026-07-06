import { defineConfig, Plugin } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetCatalogPlugin, scanMaps } from "../../packages/shared/src/vite-asset-catalog";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const shared = path.resolve(repoRoot, "packages/shared/src/index.ts");

/** Emit precache.json listing the app shell (JS/CSS + html + icons + maps) so the
 *  service worker can cache it on install and boot fully offline. The large
 *  game assets (models/HDRI/audio) are left to the SW's runtime cache — they
 *  are stored the first time a map that uses them is played. */
function precacheManifest(): Plugin {
  return {
    name: "precache-manifest",
    generateBundle(_options, bundle) {
      const urls = new Set<string>(["./", "./index.html", "./manifest.webmanifest", "./logo.png"]);
      for (const ic of ["icon-192", "icon-512", "apple-touch-icon", "maskable-192", "maskable-512"]) {
        urls.add(`./icons/${ic}.png`);
      }
      for (const file of Object.keys(bundle)) {
        if (/\.(js|css)$/.test(file)) urls.add(`./${file}`);
      }
      for (const m of scanMaps(repoRoot)) urls.add(`./${m.file}`);
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify([...urls]) });
    },
  };
}

export default defineConfig({
  base: "./",
  // assets (models/textures/audio/hdri) live once at the repo root and are shared
  // with the editor; Vite copies this into the game's dist on build.
  publicDir: path.resolve(repoRoot, "public"),
  resolve: {
    alias: { "@slopwars/shared": shared },
  },
  plugins: [assetCatalogPlugin({ root: repoRoot }), precacheManifest()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    allowedHosts: true,
  },
});
