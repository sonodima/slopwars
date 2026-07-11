import { defineConfig, Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetCatalogPlugin, scanMaps } from "../../packages/shared/src/vite-asset-catalog";
// @ts-expect-error — plain .mjs helper, no type declarations
import { vendorPhysx } from "../../scripts/vendor-physx.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const shared = path.resolve(repoRoot, "packages/shared/src/index.ts");

// Vendor the PhysX runtime out of node_modules into public/physx up-front (synchronous,
// at config load — before the dev server starts serving or a build copies publicDir),
// so the game self-hosts it (no runtime CDN) without committing the wasm to the repo.
try { vendorPhysx(repoRoot); } catch (e) { console.warn("[vite] PhysX vendor skipped:", String(e)); }

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

/** Stamp a per-build id into the service worker's cache name (the `__BUILD__` token in
 *  public/sw.js). The id is a hash of the build's emitted JS/CSS filenames — which are
 *  content-hashed by Vite, so it changes iff the app code changed. This does two things:
 *  (1) the sw.js *bytes* change each deploy, so browsers re-run install/activate (a
 *  byte-identical SW is never re-evaluated); (2) the cache name changes, so activate
 *  purges the old cache and the new SW refetches the stable-URL game assets fresh —
 *  killing the "changed asset needs a force refresh" bug (incl. iOS PWA). */
function swVersion(): Plugin {
  let build = "dev";
  return {
    name: "sw-version",
    apply: "build",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f)).sort().join("|");
      build = createHash("sha256").update(names).digest("hex").slice(0, 12);
    },
    // rewrite AFTER publicDir (which holds sw.js) has been copied to the out dir
    writeBundle(options) {
      const swPath = path.join(options.dir ?? "dist", "sw.js");
      if (!fs.existsSync(swPath)) return;
      const src = fs.readFileSync(swPath, "utf8").replace(/__BUILD__/g, build);
      fs.writeFileSync(swPath, src);
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
  plugins: [assetCatalogPlugin({ root: repoRoot }), precacheManifest(), swVersion()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
  // Fixed port so the game dev server is always at http://localhost:5211 and never
  // collides with the editor (5210); strictPort fails loudly instead of hopping.
  server: {
    port: 5211,
    strictPort: true,
    allowedHosts: true,
  },
});
