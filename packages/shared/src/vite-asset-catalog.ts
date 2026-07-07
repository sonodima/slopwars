// ─── Vite plugin: file-driven asset scanner + map serving ─────────────────────
// This is the heart of the asset pipeline. At dev/build time it reads the
// project's `public/assets/` and `maps/` directories from disk and exposes them
// to both apps through virtual modules, so no asset file names are ever written
// into game or editor source:
//
//   import catalog from "virtual:asset-catalog"   // AssetCatalog
//   import maps    from "virtual:map-catalog"      // MapCatalogEntry[]
//
// In dev it also serves `maps/*.json` (which live outside publicDir). On build,
// every map is emitted into the bundle so the deployed client can fetch it.
//
// The editor's write path (save maps, import assets) and MCP bridge used to live
// here as dev-server middleware. They now run in the editor's Tauri backend
// (apps/editor/src-tauri/), so this plugin is read-only again — it only provides
// the catalog to both apps and serves maps to the game in dev.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import type {
  AssetCatalog, AudioAsset, HdriAsset, MapCatalogEntry,
  ModelAsset, TextureAsset, TextureMaps,
} from "./catalog";

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

/** classify a texture map file by its role (color / normal / arm / …) */
function texSlot(file: string): string {
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
    return { name, gltf: `models/${name}/${any}`, meta };
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
    audio: scanAudio(assets),
    hdri: scanHdri(assets),
  };
}

export function scanMaps(root: string): MapCatalogEntry[] {
  const dir = path.join(root, "maps");
  if (!fs.existsSync(dir)) return [];
  const out: MapCatalogEntry[] = [];
  for (const f of readFilesFlat(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const meta = def?.meta ?? {};
      out.push({ id: meta.id ?? f.replace(/\.json$/, ""), name: meta.name ?? f, theme: meta.theme ?? "", file: `maps/${f}` });
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

    // maps live outside publicDir → emit them into the build so the deployed
    // client can fetch `./maps/<id>.json`.
    generateBundle() {
      const dir = path.join(root, "maps");
      if (!fs.existsSync(dir)) return;
      for (const f of readFilesFlat(dir)) {
        if (!f.endsWith(".json")) continue;
        this.emitFile({ type: "asset", fileName: `maps/${f}`, source: fs.readFileSync(path.join(dir, f), "utf8") });
      }
    },

    configureServer(server) {
      const mapsDir = path.join(root, "maps");

      // serve maps/*.json in dev (they are not under publicDir)
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && url.startsWith("/maps/") && url.endsWith(".json")) {
          const file = path.join(mapsDir, path.basename(url));
          if (fs.existsSync(file)) { res.setHeader("Content-Type", "application/json"); res.end(fs.readFileSync(file)); return; }
          res.statusCode = 404; res.end("map not found"); return;
        }
        return next();
      });
    },
  };
}
