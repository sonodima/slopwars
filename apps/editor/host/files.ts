// ─── Editor host: server-side file operations ────────────────────────────────
// The editor's authoritative state is the git working tree: maps in `maps/` and
// assets in `public/assets/`. These helpers read and write there directly on the
// dev machine. They back both the browser UI (via the /__editor/* HTTP API) and
// the headless MCP file tools — one implementation, no duplication. The catalog
// scanners are reused from the shared asset pipeline so the game and the editor
// agree on exactly what an asset "is".
import fs from "node:fs";
import path from "node:path";
import { scanAssets, scanMaps } from "../../../packages/shared/src/vite-asset-catalog";
import type { MapDef } from "../../../packages/shared/src/schema";

export { scanAssets, scanMaps };

/** one uploaded file for an import: base64 `data`, original `name`, optional
 *  PBR `slot` (texture sets). */
export interface ImportFile { name: string; data: string; slot?: "color" | "normal" | "arm" }
export interface ImportRequest { kind: "texture" | "model" | "audio" | "hdri"; name: string; files: ImportFile[] }
export interface ImportResult { ok?: boolean; error?: string; name?: string; files?: string[] }

// ── path / name sanitizers ───────────────────────────────────────────────────

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

const IMG_EXT = new Set(["jpg", "jpeg", "png", "webp", "ktx", "ktx2", "hdr"]);
const MODEL_EXT = new Set(["gltf", "glb", "bin", "jpg", "jpeg", "png", "webp", "ktx", "ktx2"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a"]);

// ── map read / write ─────────────────────────────────────────────────────────

/** load `maps/<file basename>` and parse it as a MapDef */
export function loadMap(root: string, file: string): MapDef {
  const abs = path.join(root, "maps", path.basename(file));
  return JSON.parse(fs.readFileSync(abs, "utf8")) as MapDef;
}

/** write a map to `maps/<id>.json` (git-first: pretty JSON + trailing newline) */
export function saveMap(root: string, id: string, def: MapDef): { ok?: boolean; error?: string; file?: string } {
  const name = sanitize(id);
  if (!name) return { error: "invalid map id" };
  const dir = path.join(root, "maps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def, null, 2) + "\n");
  return { ok: true, file: `maps/${name}.json` };
}

// ── asset import ──────────────────────────────────────────────────────────────

/** write an imported asset into public/assets/ and return the created paths.
 *  Shared by the editor UI (POST /__editor/import) and the MCP import tools. */
export function importAsset(root: string, req: ImportRequest): ImportResult {
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

  return { error: `unknown import kind: ${(req as { kind: string }).kind}` };
}
