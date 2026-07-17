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

const V_ASSETS = "virtual:asset-catalog";
const V_MAPS = "virtual:map-catalog";
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
  return readDirs(base).map((name): ModelAsset | null => {
    const dir = path.join(base, name);
    const files = readFilesFlat(dir);
    // prefer <name>.gltf/.glb, else the first gltf/glb in the folder
    const exact = files.find((f) => f === `${name}.gltf` || f === `${name}.glb`);
    const any = exact ?? files.find((f) => /\.(gltf|glb)$/i.test(f));
    if (!any) return null;
    const metaFile = files.find((f) => f === `${name}.meta.json` || f === "meta.json");
    let meta: Record<string, unknown> | undefined;
    if (metaFile) { try { meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), "utf8")); } catch { /* ignore */ } }
    // parse the glTF's named material slots (JSON only — a .glb is binary, skipped) so
    // the editor can offer a per-slot material assignment without loading the mesh.
    let slots: string[] | undefined;
    if (/\.gltf$/i.test(any)) {
      try {
        const gltf = JSON.parse(fs.readFileSync(path.join(dir, any), "utf8")) as { materials?: { name?: string }[] };
        const names = (gltf.materials ?? []).map((m, i) => m.name ?? `material_${i}`);
        if (names.length) slots = names;
      } catch { /* ignore malformed gltf */ }
    }
    return { name, gltf: `models/${name}/${any}`, meta, slots };
  }).filter((m): m is ModelAsset => m !== null).sort((a, b) => a.name.localeCompare(b.name));
}

function scanTextures(assets: string): TextureAsset[] {
  const base = path.join(assets, "textures");
  return readDirs(base).map((name): TextureAsset => {
    const dir = path.join(base, name);
    const maps: TextureMaps = {};
    for (const f of readFilesFlat(dir)) {
      if (!IMG.test(f)) continue;
      const slot = texSlot(f);
      if (slot && !maps[slot]) maps[slot] = `textures/${name}/${f}`;
    }
    return { name, maps };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** materials are JSON files under public/assets/materials/ — the parsed def is
 *  inlined into the catalog (they're tiny) so no runtime fetch is needed. */
function scanMaterials(assets: string): MaterialAsset[] {
  const base = path.join(assets, "materials");
  const out: MaterialAsset[] = [];
  for (const f of readFilesFlat(base)) {
    if (!f.endsWith(".json")) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(base, f), "utf8")) as MaterialDef;
      out.push({ name: f.replace(/\.json$/, ""), def });
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanAudio(assets: string): AudioAsset[] {
  const base = path.join(assets, "audio");
  const out: AudioAsset[] = [];
  for (const f of readFilesFlat(base)) {
    if (AUDIO.test(f)) out.push({ name: f.replace(AUDIO, ""), file: `audio/${f}` });
  }
  for (const name of readDirs(base)) {
    const inner = readFilesFlat(path.join(base, name)).find((f) => AUDIO.test(f));
    if (inner) out.push({ name, file: `audio/${name}/${inner}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function scanHdri(assets: string): HdriAsset[] {
  const base = path.join(assets, "hdri");
  return readFilesFlat(base).filter((f) => /\.(hdr|exr)$/i.test(f))
    .map((f): HdriAsset => ({ name: f.replace(/\.(hdr|exr)$/i, ""), file: `hdri/${f}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
