// SlopWars bundle updater — keeps the game current WITHOUT reinstalling the app.
//
// The shell is a dumb static server (main.js) and the game is plain files, so an
// "app update" is really just a new dist tree. The web deploy already publishes
// everything we need on Pages: version.json (build identity) and dist-manifest.json
// (every file → sha256+size, emitted by the game's vite config). This module polls
// the former, syncs changed files per the latter into a per-version dir under
// userData, and atomically activates it for the NEXT launch — the packaged
// Resources/game copy (read-only on macOS) stays as the eternal fallback.
//
// Design notes, learned from the plan review:
// - Per-file sha256 verification is NOT optional: for ~10min after a deploy the
//   Pages CDN can serve a MIXED old/new tree on the stable asset URLs. Any hash
//   mismatch aborts the whole update (retry later) — a bundle is never activated
//   partially. version.json/manifest are fetched no-store; per-file requests get a
//   hash-derived ?v= buster so a stale edge entry can't satisfy them.
// - Activation IS the atomic staging→final rename; there is no separate "ready"
//   marker to get out of sync. A crash mid-download leaves only a .staging dir,
//   swept on the next launch.
// - Version order compares the NUMERIC r<count> (r99 > r100 lexicographically…);
//   anything unparseable (e.g. "dev") never wins over the packaged bundle.
// - Manifest filenames come from the network → each is path-validated before any
//   write, mirroring the app:// handler's traversal guard.
// - Unchanged files are COPIED from the active bundle instead of re-downloaded
//   (typical update = a few MB of JS out of a ~120MB tree). Plain copy, no
//   hardlinks: cross-volume links fail in edge setups and save little here.
// - Zero IPC / zero deps, same as the rest of the shell. The renderer never knows
//   an update happened — it just gets newer files next boot.
import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const INITIAL_DELAY_MS = 20_000;       // let the first load / shader warmups finish undisturbed
const CHECK_MS = 4 * 60 * 60 * 1000;   // steady-state re-check while the app stays open
const RETRY_MS = 10 * 60 * 1000;       // after a failed/aborted attempt (CDN mixing, offline)
const FETCH_TIMEOUT_MS = 30_000;
// The updater shares the MAIN process with the app:// file server: while it syncs,
// the renderer's asset fetches queue behind it. Keep it polite — low concurrency,
// and never hash a whole file in one blocking crypto call (a 40MB asset would
// stall the event loop for hundreds of ms right when the first match plays).
const CONCURRENCY = 4;

// Test hook only: point the updater at a local static server. In a packaged app the
// canonical Pages origin is hardcoded — updates must not be redirectable by env.
const PAGES_URL = app.isPackaged
  ? "https://sonodima.github.io/slopwars"
  : process.env.SLOP_UPDATE_URL ?? null;

const bundlesRoot = () => path.join(app.getPath("userData"), "bundles");

/** numeric build order from "r<count>.<sha>" — NaN for "dev"/malformed
 *  @param {string | null | undefined} version */
function buildNum(version) {
  const m = /^r(\d+)\./.exec(version ?? "");
  return m ? Number(m[1]) : NaN;
}

/** @param {string} dir @returns {string | null} */
function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")).version ?? null; }
  catch { return null; }
}

/** Sweep leftovers BEFORE the window exists (nothing is streaming from these dirs
 *  yet): all .staging dirs, plus every complete bundle except the newest —
 *  `keep` (the dir about to be served) is always preserved. */
/** @param {string} keep */
export function cleanupBundles(keep) {
  const root = bundlesRoot();
  /** @type {fs.Dirent[]} */
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  /** @type {string[]} */
  const complete = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name.endsWith(".staging")) { fs.rmSync(p, { recursive: true, force: true }); continue; }
    complete.push(p);
  }
  complete.sort((a, b) => buildNum(readVersion(b)) - buildNum(readVersion(a)));
  for (const p of complete.slice(1)) if (p !== keep) fs.rmSync(p, { recursive: true, force: true });
}

/** The dist dir to serve this session: the newest complete downloaded bundle that
 *  beats the packaged one, else the packaged dir itself. "Complete" = survived the
 *  atomic rename AND still has its index.html + version.json. */
/** @param {string} packagedDist */
export function pickBundle(packagedDist) {
  const packagedN = buildNum(readVersion(packagedDist));
  /** @type {string | null} */
  let best = null;
  let bestN = Number.isNaN(packagedN) ? -1 : packagedN;
  /** @type {fs.Dirent[]} */
  let entries = [];
  try { entries = fs.readdirSync(bundlesRoot(), { withFileTypes: true }); } catch { /* none yet */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith(".staging")) continue;
    const dir = path.join(bundlesRoot(), e.name);
    const n = buildNum(readVersion(dir));
    if (!Number.isNaN(n) && n > bestN && fs.existsSync(path.join(dir, "index.html"))) {
      best = dir;
      bestN = n;
    }
  }
  return best ?? packagedDist;
}

/** @param {string} url @param {RequestInit} [opts] */
async function fetchTimed(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...opts });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

/** sha256 of a file, streamed — each chunk read yields the event loop, so serving
 *  app:// requests interleaves instead of stalling behind a monolithic hash
 *  @param {string} p */
async function sha256File(p) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(p, { highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest("hex");
}

/** sha256 of an in-memory buffer, chunked with explicit yields for the same reason
 *  @param {Uint8Array} buf */
async function sha256Buf(buf) {
  const hash = createHash("sha256");
  const STEP = 4 << 20;
  for (let off = 0; off < buf.length; off += STEP) {
    hash.update(buf.subarray(off, off + STEP));
    if (off + STEP < buf.length) await new Promise((r) => setImmediate(r));
  }
  return hash.digest("hex");
}

/** download/copy one manifest entry into the staging dir, verifying its hash
 *  @param {string} rel @param {{h: string, s: number}} want
 *  @param {string} stagingDir @param {string} activeDist */
async function syncFile(rel, want, stagingDir, activeDist) {
  const dest = path.join(stagingDir, rel);
  // the manifest came from the network — never let a crafted name escape staging
  if (path.isAbsolute(rel) || path.relative(stagingDir, dest).startsWith("..")) {
    throw new Error(`manifest path escapes bundle: ${rel}`);
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // reuse the local copy when the active bundle already has these exact bytes
  try {
    const src = path.join(activeDist, rel);
    const st = await fsp.stat(src);
    if (st.size === want.s && await sha256File(src) === want.h) { await fsp.copyFile(src, dest); return 0; }
  } catch { /* not local — download */ }
  const res = await fetchTimed(`${PAGES_URL}/${rel.split("/").map(encodeURIComponent).join("/")}?v=${want.h.slice(0, 8)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== want.s || await sha256Buf(buf) !== want.h) {
    throw new Error(`hash mismatch for ${rel} (stale CDN?)`); // abort the whole update; retry later
  }
  await fsp.writeFile(dest, buf);
  return buf.length;
}

/** one full check+sync attempt; returns the activated bundle dir or null
 *  @param {string} activeDist */
async function checkOnce(activeDist) {
  const remote = await (await fetchTimed(`${PAGES_URL}/version.json`)).json();
  const remoteN = buildNum(remote.version);
  const activeN = buildNum(readVersion(activeDist));
  if (Number.isNaN(remoteN) || remoteN <= (Number.isNaN(activeN) ? -1 : activeN)) return null;
  const finalDir = path.join(bundlesRoot(), `game-${remote.version}`);
  if (fs.existsSync(path.join(finalDir, "index.html"))) return finalDir; // already downloaded, not yet running
  /** @type {Record<string, {h: string, s: number}>} */
  const manifest = await (await fetchTimed(`${PAGES_URL}/dist-manifest.json`)).json();
  const stagingDir = `${finalDir}.staging`;
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    const queue = Object.entries(manifest);
    let downloaded = 0;
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const n = await syncFile(next[0], next[1], stagingDir, activeDist);
        downloaded += n; // NOT `+= await …`: that reads the accumulator before the await and clobbers concurrent workers
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await fsp.rename(stagingDir, finalDir); // the atomic "ready" switch
    console.log(`[updater] ${remote.version} ready (${(downloaded / 1e6).toFixed(1)}MB fetched)`);
    return finalDir;
  } catch (e) {
    await fsp.rm(stagingDir, { recursive: true, force: true }); // incl. ENOSPC cleanup
    throw e;
  }
}

/** Start the background update loop: first check after a short grace period,
 *  then periodically; on a completed download offer ONE restart prompt
 *  (declining defers to next launch). The prompt is withheld while
 *  `inMatchHint()` is true — a native modal steals pointer lock, and on a fresh
 *  install the download finishes right when the first match is being played.
 *  @param {import("electron").BrowserWindow} win @param {string} activeDist
 *  @param {() => boolean} [inMatchHint] */
export function initUpdater(win, activeDist, inMatchHint) {
  if (!PAGES_URL) return; // dev without SLOP_UPDATE_URL — inert
  let prompted = false;
  /** @param {string} ready */
  const promptWhenClear = async (ready) => {
    // re-check the hint every minute; worst case the update just applies next launch
    while (inMatchHint?.()) await new Promise((r) => { setTimeout(r, 60_000).unref?.(); });
    if (prompted || win.isDestroyed()) return;
    prompted = true;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "SlopWars",
      message: `Update ${readVersion(ready) ?? ""} downloaded`,
      detail: "Restart to play on the new version — old clients can't join updated lobbies. \"Later\" applies it on the next launch.",
    });
    if (response === 0) {
      app.relaunch();
      win.destroy(); // skip the in-match close-confirm: this prompt WAS the confirmation
      app.quit();
    }
  };
  const tick = async () => {
    let delay = CHECK_MS;
    try {
      const ready = await checkOnce(activeDist);
      if (ready && !prompted && !win.isDestroyed()) void promptWhenClear(ready);
    } catch (e) {
      console.warn("[updater] check failed:", String(e instanceof Error ? e.message : e));
      delay = RETRY_MS;
    }
    setTimeout(tick, delay).unref?.();
  };
  setTimeout(tick, INITIAL_DELAY_MS).unref?.();
}
