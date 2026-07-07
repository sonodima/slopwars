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
// a small editor API to list and save maps — the
// git-first workflow: the editor writes JSON into the repo, you commit it, and
// the client picks it up on the next scan. On build, every map is emitted into
// the bundle so the deployed client can fetch it.
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

// ── helpers for the editor write API ────────────────────────────────────────

function sanitize(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
/** keep a submitted filename safe (basename only, sane charset) */
function sanitizeFile(name: string): string {
  return path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}
function extOf(file: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(file));
  return m ? m[1].toLowerCase() : "";
}
/** write a base64 data blob to `public/assets/<rel>`, creating dirs as needed */
function writeAssetB64(root: string, rel: string, b64: string): void {
  const abs = path.join(root, "public", "assets", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(b64, "base64"));
}
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function json(res: import("node:http").ServerResponse, code: number, data: unknown): void {
  res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
}

/** one uploaded file: base64 `data` + original `name` (for the extension) and,
 *  for texture sets, which PBR `slot` it fills. */
export interface ImportFile { name: string; data: string; slot?: "color" | "normal" | "arm" }
/** an editor / MCP asset-import request */
export interface ImportRequest {
  kind: "texture" | "model" | "audio" | "hdri";
  name: string;
  files: ImportFile[];
}

const IMG_EXT = new Set(["jpg", "jpeg", "png", "webp", "ktx", "ktx2", "hdr"]);
const MODEL_EXT = new Set(["gltf", "glb", "bin", "jpg", "jpeg", "png", "webp", "ktx", "ktx2"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a"]);

/** write an imported asset into public/assets/ and return the created paths.
 *  Shared by the editor UI and (later) the MCP server. */
export function importAsset(root: string, req: ImportRequest): { ok?: boolean; error?: string; name?: string; files?: string[] } {
  const name = sanitize(req.name);
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { error: "no files provided" };

  if (req.kind === "texture") {
    if (!name) return { error: "texture needs a name" };
    const written: string[] = [];
    for (const f of files) {
      const slot = f.slot;
      const ext = extOf(f.name);
      if (!slot || !["color", "normal", "arm"].includes(slot)) return { error: `bad texture slot: ${slot}` };
      if (!IMG_EXT.has(ext)) return { error: `unsupported image type: .${ext}` };
      const rel = `textures/${name}/${slot}.${ext}`;
      writeAssetB64(root, rel, f.data);
      written.push(rel);
    }
    return { ok: true, name, files: written };
  }

  if (req.kind === "model") {
    if (!name) return { error: "model needs a name" };
    const hasGltf = files.some((f) => ["gltf", "glb"].includes(extOf(f.name)));
    if (!hasGltf) return { error: "model needs a .gltf or .glb file" };
    const written: string[] = [];
    for (const f of files) {
      const ext = extOf(f.name);
      if (!MODEL_EXT.has(ext)) return { error: `unsupported model file: .${ext}` };
      const rel = `models/${name}/${sanitizeFile(f.name)}`;
      writeAssetB64(root, rel, f.data);
      written.push(rel);
    }
    return { ok: true, name, files: written };
  }

  if (req.kind === "audio") {
    const f = files[0];
    const ext = extOf(f.name);
    if (!AUDIO_EXT.has(ext)) return { error: `unsupported audio type: .${ext}` };
    const base = name || sanitize(f.name.replace(/\.[^.]+$/, ""));
    if (!base) return { error: "audio needs a name" };
    const rel = `audio/${base}.${ext}`;
    writeAssetB64(root, rel, f.data);
    return { ok: true, name: base, files: [rel] };
  }

  if (req.kind === "hdri") {
    const f = files[0];
    const ext = extOf(f.name) || "hdr";
    if (!["hdr", "exr"].includes(ext)) return { error: `unsupported hdri type: .${ext}` };
    const base = name || sanitize(f.name.replace(/\.[^.]+$/, ""));
    if (!base) return { error: "hdri needs a name" };
    const rel = `hdri/${base}.${ext}`;
    writeAssetB64(root, rel, f.data);
    return { ok: true, name: base, files: [rel] };
  }

  return { error: `unknown import kind: ${req.kind}` };
}

// ── MCP bridge queue (module state; dev server only) ─────────────────────────
interface McpCommand { id: string; cmd: unknown }
let mcpPending: McpCommand[] = [];
const mcpResults = new Map<string, unknown>();
let mcpSeq = 0;

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

        // ── asset import: write files into public/assets/ so the scanner finds
        //    them on the next catalog load (the same git-first flow as maps). ──
        if (req.method === "POST" && url === "/__editor/import") {
          readBody(req).then((body) => {
            const result = importAsset(root, JSON.parse(body));
            json(res, result.error ? 400 : 200, result);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        // ── MCP bridge: a command queue between an external MCP server and the
        //    running editor page. The MCP server POSTs a command to /cmd and the
        //    request is held open until the editor (which long-polls /poll)
        //    executes it and POSTs the result back to /result. ──
        if (req.method === "POST" && url === "/__editor/mcp/cmd") {
          readBody(req).then((body) => {
            const id = `c${(++mcpSeq)}_${Date.now().toString(36)}`;
            mcpPending.push({ id, cmd: JSON.parse(body || "{}") });
            const started = Date.now();
            const timer = setInterval(() => {
              if (mcpResults.has(id)) {
                clearInterval(timer);
                const r = mcpResults.get(id); mcpResults.delete(id);
                json(res, 200, { ok: true, result: r });
              } else if (Date.now() - started > 15000) {
                clearInterval(timer);
                mcpPending = mcpPending.filter((p) => p.id !== id);
                json(res, 504, { error: "editor did not respond — is the editor page open in a browser?" });
              }
            }, 50);
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }
        if (req.method === "GET" && url === "/__editor/mcp/poll") {
          const out = mcpPending; mcpPending = [];
          return json(res, 200, out);
        }
        if (req.method === "POST" && url === "/__editor/mcp/result") {
          readBody(req).then((body) => {
            const { id, result } = JSON.parse(body);
            if (id) mcpResults.set(id, result);
            json(res, 200, { ok: true });
          }).catch((e) => json(res, 500, { error: String(e) }));
          return;
        }

        return next();
      });
    },
  };
}
