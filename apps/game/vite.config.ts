import { defineConfig, Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
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

/** Git-derived build identity: `r<commit count>.<short sha>` — monotonic (a version
 *  mismatch can say who's behind) and bump-free (agents forget manual bumps). Used for
 *  the in-game version line AND the P2P join gate, so web and desktop clients built
 *  from the same commit always agree. Fails the build in CI rather than shipping a
 *  wrong id: a shallow clone makes `rev-list --count` silently report 1. */
function gameVersion(): { version: string; sha: string } {
  try {
    const run = (cmd: string): string =>
      execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (process.env.GITHUB_ACTIONS && run("git rev-parse --is-shallow-repository") === "true") {
      throw new Error("shallow clone in CI — set `fetch-depth: 0` on actions/checkout");
    }
    return { version: `r${run("git rev-list --count HEAD")}.${run("git rev-parse --short HEAD")}`,
             sha: run("git rev-parse --short HEAD") };
  } catch (e) {
    if (process.env.GITHUB_ACTIONS) throw e; // never deploy a mis-versioned build
    return { version: "dev", sha: "dev" };   // git unavailable (tarball checkout) — local runs only
  }
}
const ver = gameVersion();
const pkgVersion: string = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;

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

/** Emit version.json (the deployed build's identity) — polled by the desktop shell's
 *  bundle updater to learn a new deploy landed on Pages. Nothing on web reads it. */
function versionJson(): Plugin {
  return {
    name: "version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset", fileName: "version.json",
        source: JSON.stringify({ version: ver.version, sha: ver.sha, builtAt: new Date().toISOString() }),
      });
    },
  };
}

/** Emit dist-manifest.json — every file in the out dir with sha256 + size — the
 *  desktop updater's download list AND integrity check (Pages' CDN can serve a
 *  mixed old/new tree for ~10min after a deploy; per-file hashes catch that).
 *  Built by WALKING THE OUT DIR in closeBundle, not from the bundle graph: the
 *  ~100MB of publicDir assets never enter the graph, and sw.js only gets its
 *  __BUILD__ stamp in writeBundle. Must be registered after swVersion(). */
function distManifest(): Plugin {
  let outDir = "dist";
  return {
    name: "dist-manifest",
    apply: "build",
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const root = path.resolve(appDir, outDir);
      if (!fs.existsSync(root)) return;
      const files: Record<string, { h: string; s: number }> = {};
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue; // .DS_Store & co. — publicDir junk, not game files
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          const rel = path.relative(root, p).split(path.sep).join("/");
          if (rel === "dist-manifest.json") continue;
          const buf = fs.readFileSync(p);
          files[rel] = { h: createHash("sha256").update(buf).digest("hex"), s: buf.length };
        }
      };
      walk(root);
      fs.writeFileSync(path.join(root, "dist-manifest.json"), JSON.stringify(files));
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
  // Referenced ONLY from modules the editor never imports (net/hud/main/settings);
  // the editor config defines the same tokens as insurance against refactors.
  define: {
    __GAME_VERSION__: JSON.stringify(ver.version),
    __GIT_SHA__: JSON.stringify(ver.sha),
    __PKG_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [assetCatalogPlugin({ root: repoRoot }), precacheManifest(), swVersion(), versionJson(), distManifest()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
    // Terser over the default esbuild minify: smaller output and a harder read for
    // cheat userscripts — top-level names mangled, console/debugger stripped, no
    // sourcemaps shipped. Deliberately NO property mangling and NO obfuscator pass:
    // property mangling corrupts everything keyed by literal names (map/meta JSON,
    // the net protocol), and control-flow obfuscators cost real frame time in a
    // 60 fps loop while adding nothing against the actual cheat surface (the P2P
    // messages themselves). Obfuscation only raises the bar — it is not anti-cheat.
    minify: "terser",
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true, pure_getters: true },
      mangle: { toplevel: true },
      format: { comments: false },
    },
  },
  // Fixed port so the game dev server is always at http://localhost:5211 and never
  // collides with the editor (5210); strictPort fails loudly instead of hopping.
  server: {
    port: 5211,
    strictPort: true,
    allowedHosts: true,
  },
});
