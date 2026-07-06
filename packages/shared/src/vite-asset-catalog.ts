// ─── Vite plugin: file-driven asset scanner + map serving/saving ──────────────
// This is the heart of the asset pipeline. At dev/build time it reads the
// project's `public/assets/` and `maps/` directories from disk and exposes them
// to both apps through virtual modules, so no asset file names are ever written
// into game or editor source:
//
//   import catalog from "virtual:asset-catalog"   // AssetCatalog
//   import maps    from "virtual:map-catalog"      // MapCatalogEntry[]
//
// In dev it also serves `maps/*.json` (which live outside publicDir) and exposes
// a small editor API to list/save maps and create/delete materials — the
// git-first workflow: the editor writes JSON into the repo, you commit it, and
// the client picks it up on the next scan. On build, every map is emitted into
// the bundle so the deployed client can fetch it.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import type {
  AssetCatalog, AudioAsset, HdriAsset, MapCatalogEntry, MaterialAsset,
  ModelAsset, TextureAsset, TextureMaps,
} from "./catalog";

interface Options {
  /** repo root that contains `public/` and `maps/` (defaults to cwd) */
  root?: string;
  /** enable the editor save/import API + verbose logging (editor app only) */
  editor?: boolean;
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

function scanMaterials(assets: string): MaterialAsset[] {
  const base = path.join(assets, "materials");
  const out: MaterialAsset[] = [];
  for (const f of readFilesFlat(base)) {
    if (!f.endsWith(".json")) continue;
    const name = f.replace(/\.json$/, "");
    let def; try { def = JSON.parse(fs.readFileSync(path.join(base, f), "utf8")); } catch { def = undefined; }
    out.push({ name, file: `materials/${f}`, def });
  }
  for (const name of readDirs(base)) {
    const metaPath = path.join(base, name, "meta.json");
    let def; if (fs.existsSync(metaPath)) { try { def = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* ignore */ } }
    out.push({ name, file: `materials/${name}/meta.json`, def });
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

// ── helpers for the editor write API ────────────────────────────────────────

function sanitize(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function json(res: import("node:http").ServerResponse, code: number, data: unknown): void {
  res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
}

export function assetCatalogPlugin(opts: Options = {}): Plugin {
  const root = path.resolve(opts.root ?? process.cwd());
  const editor = opts.editor ?? false;

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
      const materialsDir = path.join(root, "public", "assets", "materials");

      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];

        // serve maps/*.json in dev (they are not under publicDir)
        if (req.method === "GET" && url.startsWith("/maps/") && url.endsWith(".json")) {
          const file = path.join(mapsDir, path.basename(url));
          if (fs.existsSync(file)) { res.setHeader("Content-Type", "application/json"); res.end(fs.readFileSync(file)); return; }
          res.statusCode = 404; res.end("map not found"); return;
        }

        if (!editor || !url.startsWith("/__editor/")) return next();

        // ── editor API (dev only) ──
        if (req.method === "GET" && url === "/__editor/catalog") return json(res, 200, scanAssets(root));
        if (req.method === "GET" && url === "/__editor/maps") return json(res, 200, scanMaps(root));

        if (req.method === "POST" && url === "/__editor/save") {
          readBody(req).then((body) => {
            const { id, def } = JSON.parse(body);
            const name = sanitize(id);
            if (!name) return json(res, 400, { error: "invalid map id" });
            fs.mkdirSync(mapsDir, { recursive: true });
            fs.writeFileSync(path.join(mapsDir, `${name}.json`), JSON.stringify(def, null, 2) + "\n");
            json(res, 200, { ok: true, file: `maps/${name}.json` });
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        if (req.method === "POST" && url === "/__editor/material") {
          readBody(req).then((body) => {
            const { name, def } = JSON.parse(body);
            const n = sanitize(name);
            if (!n) return json(res, 400, { error: "invalid material name" });
            fs.mkdirSync(materialsDir, { recursive: true });
            fs.writeFileSync(path.join(materialsDir, `${n}.json`), JSON.stringify(def, null, 2) + "\n");
            json(res, 200, { ok: true });
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        if (req.method === "POST" && url === "/__editor/material/delete") {
          readBody(req).then((body) => {
            const { name } = JSON.parse(body);
            const file = path.join(materialsDir, `${sanitize(name)}.json`);
            if (fs.existsSync(file)) fs.unlinkSync(file);
            json(res, 200, { ok: true });
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        return next();
      });
    },
  };
}
