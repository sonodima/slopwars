import { defineConfig, Plugin } from "vite";

/** Emit precache.json listing the app shell (JS/CSS + html + icons) so the
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
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify([...urls]) });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [precacheManifest()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    allowedHosts: true,
  },
});
