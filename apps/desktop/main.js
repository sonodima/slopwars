// SlopWars desktop shell — the entire Electron app in one dependency-free file.
//
// The game's Vite build (apps/game/dist) is already desktop-ready: base "./",
// no COOP/COEP, no workers. The one trap is loading it over file:// — the
// emscripten loader inside public/physx fetch()es physx.release.wasm, and
// Chromium rejects fetch() of file:// URLs, so physics would *silently*
// degrade to the JS fallback sim. Hence the privileged app:// scheme below:
// standard+secure makes relative URLs and secure-context APIs behave like
// https, supportFetchAPI makes the wasm fetch work, stream keeps large
// assets (.glb/.hdr/audio) off the heap.
//
// Deliberately NO allowServiceWorkers privilege: the game's sw.js registration
// (apps/game/src/main.ts registerServiceWorker) rejects on this scheme and is
// already .catch()ed, so the PWA update/reload machinery stays inert without
// touching game code. Offline is moot — the bundle ships on disk.
import { app, BrowserWindow, dialog, protocol, session, shell } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupBundles, initUpdater, pickBundle } from "./updater.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged: electron-builder copies the game via extraResources → resources/game.
// That copy is the read-only FALLBACK — the updater may have staged a newer bundle
// under userData, chosen once at startup (never swapped mid-session; see updater.js).
const packagedDist = app.isPackaged
  ? path.join(process.resourcesPath, "game")
  : path.resolve(here, "../game/dist");
let gameDist = packagedDist; // resolved for real in whenReady (needs app paths)
// Dev loop: SLOP_DEV_URL=http://localhost:5211 loads the game's Vite dev
// server instead of dist (HMR works; the SW never registers — not PROD).
const devUrl = process.env.SLOP_DEV_URL;

// Must be called before app ready. codeCache lets V8 persist compiled JS/wasm
// across launches (userData/Code Cache) like http(s) gets for free — without it
// every launch re-parses the whole game bundle and re-compiles the PhysX wasm.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// Explicit MIME map instead of a lookup dependency: application/wasm is
// required for WebAssembly.instantiateStreaming (wrong type = silent JS-sim
// fallback again), and the model/audio types keep DevTools/network sane.
/** @type {Record<string, string>} */
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream", ".hdr": "application/octet-stream",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".md": "text/plain",
};

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  // pick the newest complete bundle BEFORE anything streams from disk, and sweep
  // stale ones while their files are guaranteed unlocked (Windows locks open files)
  if (!devUrl) {
    gameDist = pickBundle(packagedDist);
    cleanupBundles(gameDist);
  }

  protocol.handle("app", async (req) => {
    const rel = path.normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^[/\\]+/, "");
    const file = path.join(gameDist, rel === "" ? "index.html" : rel);
    if (path.relative(gameDist, file).startsWith("..")) return new Response("forbidden", { status: 403 });
    try {
      if (!(await stat(file)).isFile()) return new Response("not found", { status: 404 });
      return new Response(/** @type {ReadableStream} */ (Readable.toWeb(createReadStream(file))), {
        headers: { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  // Voice chat (getUserMedia), canvas pointer lock, fullscreen — deny the rest.
  const ALLOWED = new Set(["media", "pointerLock", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    fullscreen: true, // parity with the PWA manifest's display:fullscreen; F11 toggles out
    // autoHideMenuBar (not removeMenu) keeps default accelerators alive: F11,
    // Ctrl+Shift+I. NOT kiosk — Esc is load-bearing in-game (pointer-lock release).
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    icon: path.join(gameDist, "icons", "icon-512.png"),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  // External links (credits etc.) open in the OS browser; no child windows ever.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // startsWith, not equality: the dev server normalizes to a trailing slash
    if (!url.startsWith("app://") && !(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });

  // Close-confirm, zero-IPC: the game's own beforeunload preventDefaults ONLY while a
  // match is running (main.ts), which surfaces here as will-prevent-unload. So the
  // dialog appears exactly when closing would cost something — X/⌘Q from the menu
  // quits instantly, and every quit path funnels through the one unload, no
  // before-quit flag dance. preventDefault() on the EVENT means "allow the unload".
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Quit", "Stay in match"],
      defaultId: 1,
      cancelId: 1,
      title: "SlopWars",
      message: "A match is in progress — quit anyway?",
    });
    if (choice === 0) e.preventDefault();
  });

  void win.loadURL(devUrl ?? "app://game/");

  // keep the game bundle current against the Pages deploy (no-op in dev)
  if (!devUrl) initUpdater(win, gameDist);
});

app.on("window-all-closed", () => app.quit());
