// ─── Vite plugin: file-driven asset scanner ───────────────────────────────────
// This is the heart of the asset pipeline. At dev/build time it reads the
// project's `public/assets/` directory (which now also holds `maps/`) from disk
// and exposes it to both apps through virtual modules, so no asset file names are
// ever written into game or editor source:
//
//   import catalog from "virtual:asset-catalog"   // AssetCatalog
//   import maps    from "virtual:map-catalog"      // MapCatalogEntry[]
//
// Maps live under `public/assets/maps/` alongside every other asset, so they're part
// of the game's publicDir: Vite serves them in dev and copies them into the build
// itself. The client fetches `./assets/maps/<id>/map.json` at runtime.
//
// The editor's write path (save maps, import assets) and MCP bridge used to live
// here as dev-server middleware. They now run in the editor's Tauri backend
// (apps/editor/src-tauri/), so this plugin is read-only — it only provides the
// catalog to both apps.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Plugin } from "vite";
import type {
  AssetCatalog, AudioAsset, HdriAsset, MapCatalogEntry,
  ModelAsset, TextureAsset, TextureMaps,
} from "./catalog";
import type { MaterialAsset, MaterialDef } from "./materials";

interface Options {
  /** repo root that contains `public/` and `maps/` (defaults to cwd) */
  root?: string;
}

// Exported so the editor host can invalidate the virtual modules after ITS OWN
// writes: the editor dev server ignores the public/assets watcher (a full-reload
// there would drop the open documents), so the watcher-driven invalidation below
// never fires for it — without this, a manual page reload after an editor-side
// import/save would still see the stale dev-server-start catalog.
export const V_ASSETS = "virtual:asset-catalog";
export const V_MAPS = "virtual:map-catalog";
const IMG = /\.(jpe?g|png|webp|ktx2?|hdr)$/i;
const AUDIO = /\.(mp3|wav|ogg|m4a)$/i;

function readDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
function readFilesFlat(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
}

// ── asset identity: uuid + folder grouping (see catalog.ts AssetId) ───────────
// EVERY asset is a folder holding its resource file(s) plus a `meta.json` — the one
// uniform shape across every kind (models/textures already worked this way; audio,
// HDRIs and materials now do too, so there are no `<file>.meta.json` sidecars). The
// scanner reads the minted `id`/`name` from that meta.json; a folder that carries
// none yet (a hand-dropped asset) gets a deterministic id derived from its path, so
// it still resolves — it just isn't rename-safe until an id is minted for it (which
// the import + rename flows do). A material's folder holds only its meta.json, since
// its "resource" is the def stored inside it. The forward-slash `folder` group path
// comes purely from the directory structure, so an importer that drops assets into
// nested folders gets them grouped for free.

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** parse a JSON file, or undefined if missing/malformed */
function readJson(p: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

/** a stable, UUIDv5-formatted id derived from a kind + repo-relative asset path — the
 *  fallback identity for an asset with no minted id. Deterministic across scans. */
function derivedId(kind: string, rel: string): string {
  const h = crypto.createHash("sha1").update(`slopwars-asset:${kind}:${rel}`).digest("hex");
  const s = (i: number, n: number): string => h.slice(i, i + n);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${s(0, 8)}-${s(8, 4)}-5${s(13, 3)}-${variant}${s(17, 3)}-${s(20, 12)}`;
}

/** resolve an asset's identity: a minted `id`/`name` from its companion metadata, or a
 *  derived id + the slug as the name. `folder`/`slug`/`rel` come from the file layout. */
function identity(
  kind: string, folder: string, slug: string, rel: string, meta: Record<string, unknown> | undefined,
): { id: string; slug: string; name: string; folder: string } {
  const id = typeof meta?.id === "string" && meta.id ? meta.id : derivedId(kind, rel);
  const name = typeof meta?.name === "string" && meta.name ? meta.name : slug;
  return { id, slug, name, folder };
}

/** drop the identity keys from a raw metadata object, returning the remainder (a model's
 *  calibration meta) or undefined when nothing else is left. */
function stripIdentity(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const rest = { ...raw };
  delete rest.id; delete rest.name;
  return Object.keys(rest).length ? rest : undefined;
}

/** every asset-leaf DIRECTORY under `base`: a directory that directly holds a file
 *  matched by `isAsset` (models, texture sets). Directories that hold only other
 *  directories are groups — recursed into so their `folder` path accumulates. */
function walkAssetDirs(base: string, isAsset: (files: string[]) => boolean): { dir: string; folder: string; slug: string; rel: string }[] {
  const out: { dir: string; folder: string; slug: string; rel: string }[] = [];
  const walk = (dir: string): void => {
    if (isAsset(readFilesFlat(dir))) {
      const folder = toPosix(path.relative(base, path.dirname(dir)));
      const slug = path.basename(dir);
      out.push({ dir, folder, slug, rel: folder ? `${folder}/${slug}` : slug });
      return;                                     // an asset dir is a leaf — never descend
    }
    for (const sub of readDirs(dir)) walk(path.join(dir, sub));
  };
  if (fs.existsSync(base)) for (const sub of readDirs(base)) walk(path.join(base, sub));
  return out;
}

/** stable ordering: by group folder, then display name */
function byFolderName(a: { folder: string; name: string }, b: { folder: string; name: string }): number {
  return a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name);
}

/** classify a texture map file by its role (color / normal / arm / …). Exported so
 *  the editor host can find (and replace/clear) the file backing a given PBR slot. */
export function texSlot(file: string): string {
  const f = file.toLowerCase();
  if (/(^|[_-])(color|albedo|diff|basecolor|base_color)([_.-]|$)/.test(f) || /^color\./.test(f)) return "color";
  if (/(^|[_-])(normal|nor|nor_gl)([_.-]|$)/.test(f) || /^normal\./.test(f)) return "normal";
  if (/(^|[_-])(arm|orm|occ|rough|metal|ao)([_.-]|$)/.test(f) || /^arm\./.test(f)) return "arm";
  return "";
}

// ── scanners ────────────────────────────────────────────────────────────────

function scanModels(assets: string): ModelAsset[] {
  const base = path.join(assets, "models");
  const isModel = (files: string[]): boolean => files.some((f) => /\.(gltf|glb)$/i.test(f));
  return walkAssetDirs(base, isModel).map(({ dir, folder, slug, rel }): ModelAsset | null => {
    const files = readFilesFlat(dir);
    // prefer <slug>.gltf/.glb, else the first gltf/glb in the folder
    const exact = files.find((f) => f === `${slug}.gltf` || f === `${slug}.glb`);
    const any = exact ?? files.find((f) => /\.(gltf|glb)$/i.test(f));
    if (!any) return null;
    const metaFile = files.find((f) => f === `${slug}.meta.json` || f === "meta.json");
    const raw = metaFile ? readJson(path.join(dir, metaFile)) : undefined;
    const { id, name } = identity("model", folder, slug, rel, raw);
    const meta = raw ? stripIdentity(raw) : undefined;
    // parse the glTF's named material slots (JSON only — a .glb is binary, skipped) so
    // the editor can offer a per-slot material assignment without loading the mesh.
    let slots: string[] | undefined;
    if (/\.gltf$/i.test(any)) {
      const gltf = readJson(path.join(dir, any)) as { materials?: { name?: string }[] } | undefined;
      const names = (gltf?.materials ?? []).map((m, i) => m.name ?? `material_${i}`);
      if (names.length) slots = names;
    }
    return { id, slug, name, folder, gltf: toPosix(path.relative(assets, path.join(dir, any))), meta, slots };
  }).filter((m): m is ModelAsset => m !== null).sort(byFolderName);
}

function scanTextures(assets: string): TextureAsset[] {
  const base = path.join(assets, "textures");
  const isTexture = (files: string[]): boolean => files.some((f) => IMG.test(f));
  return walkAssetDirs(base, isTexture).map(({ dir, folder, slug, rel }): TextureAsset => {
    const maps: TextureMaps = {};
    for (const f of readFilesFlat(dir)) {
      if (!IMG.test(f)) continue;
      const s = texSlot(f);
      if (s && !maps[s]) maps[s] = toPosix(path.relative(assets, path.join(dir, f)));
    }
    const raw = readJson(path.join(dir, "meta.json"));
    const { id, name } = identity("texture", folder, slug, rel, raw);
    return { id, slug, name, folder, maps };
  }).sort(byFolderName);
}

/** materials are folders under public/assets/materials/**\/{slug}/ whose meta.json is a
 *  { id, name, def }. The def is inlined into the catalog (they're tiny) so no runtime
 *  fetch is needed. A material folder holds only its meta.json — its "resource" is the def. */
function scanMaterials(assets: string): MaterialAsset[] {
  const base = path.join(assets, "materials");
  const isMaterial = (files: string[]): boolean => files.includes("meta.json");
  return walkAssetDirs(base, isMaterial).map(({ dir, folder, slug, rel }): MaterialAsset | null => {
    const raw = readJson(path.join(dir, "meta.json"));
    if (!raw) return null;
    const def = (raw.def && typeof raw.def === "object" ? raw.def : raw) as MaterialDef;
    const { id, name } = identity("material", folder, slug, rel, raw);
    return { id, slug, name, folder, def };
  }).filter((m): m is MaterialAsset => m !== null).sort(byFolderName);
}

/** the resource file inside an asset folder — the first file matching `match` (a model
 *  folder can also hold a .bin, an audio/hdri folder holds just its clip; meta.json + any
 *  NOTICE.txt are ignored by the match). */
function resourceFile(dir: string, match: RegExp): string | undefined {
  return readFilesFlat(dir).find((f) => match.test(f));
}

function scanAudio(assets: string): AudioAsset[] {
  const base = path.join(assets, "audio");
  const isAudio = (files: string[]): boolean => files.some((f) => AUDIO.test(f));
  return walkAssetDirs(base, isAudio).map(({ dir, folder, slug, rel }): AudioAsset | null => {
    const file = resourceFile(dir, AUDIO);
    if (!file) return null;
    const { id, name } = identity("audio", folder, slug, rel, readJson(path.join(dir, "meta.json")));
    return { id, slug, name, folder, file: toPosix(path.relative(assets, path.join(dir, file))) };
  }).filter((a): a is AudioAsset => a !== null).sort(byFolderName);
}

function scanHdri(assets: string): HdriAsset[] {
  const base = path.join(assets, "hdri");
  const HDR = /\.(hdr|exr)$/i;
  const isHdri = (files: string[]): boolean => files.some((f) => HDR.test(f));
  return walkAssetDirs(base, isHdri).map(({ dir, folder, slug, rel }): HdriAsset | null => {
    const file = resourceFile(dir, HDR);
    if (!file) return null;
    const { id, name } = identity("hdri", folder, slug, rel, readJson(path.join(dir, "meta.json")));
    return { id, slug, name, folder, file: toPosix(path.relative(assets, path.join(dir, file))) };
  }).filter((h): h is HdriAsset => h !== null).sort(byFolderName);
}

export function scanAssets(root: string): AssetCatalog {
  const assets = path.join(root, "public", "assets");
  return {
    models: scanModels(assets),
    textures: scanTextures(assets),
    materials: scanMaterials(assets),
    audio: scanAudio(assets),
    hdri: scanHdri(assets),
  };
}

// Maps live alongside every other asset, under public/assets/maps/. Because that's inside
// the game's publicDir, Vite serves them in dev and copies them into the build with no
// custom plumbing — exactly like models/textures/audio. A map is a `maps/<id>/` folder
// holding the map JSON + screenshot images.
const MAPS_SUBDIR = path.join("public", "assets", "maps");
/** served-root-relative prefix a map (or its previews) is fetched under */
const MAPS_URL = "assets/maps";
const PREVIEW_IMG = /\.(jpe?g|png|webp|avif)$/i;

/** the map JSON inside a `maps/<id>/` folder — prefer map.json, then <id>.json, else the
 *  first *.json that parses as a MapDef (has a `meta`). */
function folderMapFile(dir: string, id: string): string | null {
  const files = readFilesFlat(dir).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === "map.json") ?? files.find((f) => f === `${id}.json`);
  if (exact) return exact;
  for (const f of files) {
    try { if (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))?.meta) return f; } catch { /* skip */ }
  }
  return null;
}

/** screenshot paths (served-root-relative) for a folder map — every image file dropped in
 *  the folder, with any file named `preview.*` first, then the rest alphabetically. No
 *  manifest: an author just adds `preview.jpg` (or several images) and they show up. */
function folderPreviews(dir: string, id: string): string[] {
  const imgs = readFilesFlat(dir).filter((f) => PREVIEW_IMG.test(f)).sort((a, b) => {
    const pa = /^preview\./i.test(a) ? 0 : 1, pb = /^preview\./i.test(b) ? 0 : 1;
    return pa - pb || a.localeCompare(b);
  });
  return imgs.map((f) => `${MAPS_URL}/${id}/${f}`);
}

export function scanMaps(root: string): MapCatalogEntry[] {
  const dir = path.join(root, MAPS_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  const out: MapCatalogEntry[] = [];
  // assets/maps/<id>/(map.json | <id>.json) + screenshot images
  for (const d of readDirs(dir)) {
    const sub = path.join(dir, d);
    const mapFile = folderMapFile(sub, d);
    if (!mapFile) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(sub, mapFile), "utf8"));
      const meta = def?.meta ?? {};
      const previews = folderPreviews(sub, d);
      out.push({
        id: meta.id ?? d, name: meta.name ?? d, theme: meta.theme ?? "",
        file: `${MAPS_URL}/${d}/${mapFile}`, ...(previews.length ? { previews } : {}),
      });
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function assetCatalogPlugin(opts: Options = {}): Plugin {
  const root = path.resolve(opts.root ?? process.cwd());

  return {
    name: "slopwars-asset-catalog",

    resolveId(id) {
      if (id === V_ASSETS || id === V_MAPS) return "\0" + id;
    },
    load(id) {
      if (id === "\0" + V_ASSETS) return `export default ${JSON.stringify(scanAssets(root))};`;
      if (id === "\0" + V_MAPS) return `export default ${JSON.stringify(scanMaps(root))};`;
    },

    // Maps now live under public/assets/maps/, i.e. inside the game's publicDir, so Vite
    // serves them in dev and copies them into the build itself — no custom emit/middleware.

    configureServer(server) {
      const assetsDir = path.join(root, "public", "assets");
      const mapsDir = path.join(root, MAPS_SUBDIR);

      // Live catalog refresh: publicDir isn't part of Vite's module graph, so editing an
      // asset — most importantly a model's meta.json (its scale, materials, or `muzzle`
      // anchor), or a map's JSON — used to leave the virtual catalog stale until the dev
      // server was restarted. The game/editor then rendered with the OLD data, so
      // freshly-authored edits looked like they hadn't applied. Watch the asset tree and,
      // on any change, invalidate the virtual module(s) (their `load` re-scans from disk)
      // and full-reload so edits show up immediately.
      server.watcher.add(assetsDir);
      const refreshCatalog = (file: string): void => {
        if (!file.startsWith(assetsDir)) return;
        const invalidate = (v: string): void => {
          const mod = server.moduleGraph.getModuleById("\0" + v);
          if (mod) server.moduleGraph.invalidateModule(mod);
        };
        invalidate(V_ASSETS);
        // a change under the maps/ subtree also invalidates the map catalog
        if (file.startsWith(mapsDir)) invalidate(V_MAPS);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", refreshCatalog);
      server.watcher.on("change", refreshCatalog);
      server.watcher.on("unlink", refreshCatalog);
    },
  };
}
