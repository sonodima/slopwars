// ─── Editor host: server-side file operations ────────────────────────────────
// The editor's authoritative state is the git working tree: maps in `maps/` and
// assets in `public/assets/`. These helpers read and write there directly on the
// dev machine. They back both the browser UI (via the /__editor/* HTTP API) and
// the headless MCP file tools — one implementation, no duplication. The catalog
// scanners are reused from the shared asset pipeline so the game and the editor
// agree on exactly what an asset "is".
import fs from "node:fs";
import path from "node:path";
import { scanAssets, scanMaps, texSlot } from "../../../packages/shared/src/vite-asset-catalog";
import type { MapDef } from "../../../packages/shared/src/schema";
import type { CollisionBox, ModelMeta } from "../../../packages/shared/src/catalog";
import type { MaterialDef, MaterialType } from "../../../packages/shared/src/materials";
import { defaultMaterialDef } from "../../../packages/shared/src/materials";

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
// geometry only — a model carries no textures (surfaces come from a material, not the
// import). glTF scene (.gltf/.glb) + its optional .bin buffer, nothing else.
const MODEL_EXT = new Set(["gltf", "glb", "bin"]);
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

// ── materials (created + edited in the editor; git-first JSON) ────────────────

const MAT_DIR = "public/assets/materials";
function matPath(root: string, name: string): string { return path.join(root, MAT_DIR, `${sanitize(name)}.json`); }

/** write a material def to public/assets/materials/<name>.json (pretty + newline) */
export function saveMaterial(root: string, name: string, def: MaterialDef): { ok?: boolean; error?: string; name?: string } {
  const n = sanitize(name);
  if (!n) return { error: "invalid material name" };
  fs.mkdirSync(path.join(root, MAT_DIR), { recursive: true });
  fs.writeFileSync(matPath(root, n), JSON.stringify(def, null, 2) + "\n");
  return { ok: true, name: n };
}

/** create a new material with a unique auto name; returns its name. Defaults to a
 *  plain gray `standard` material — the kind is chosen afterward in the inspector's
 *  type switcher, not up front. */
export function createMaterial(root: string, type: MaterialType = "standard"): { ok?: boolean; error?: string; name?: string } {
  fs.mkdirSync(path.join(root, MAT_DIR), { recursive: true });
  const stem = type === "standard" ? "material" : type;
  let n = stem;
  let i = 1;
  while (fs.existsSync(matPath(root, n))) n = `${stem}_${++i}`;
  fs.writeFileSync(matPath(root, n), JSON.stringify(defaultMaterialDef(type), null, 2) + "\n");
  return { ok: true, name: n };
}

/** rename a material file (and fail if the target already exists) */
export function renameMaterial(root: string, from: string, to: string): { ok?: boolean; error?: string; name?: string } {
  const a = matPath(root, from), bName = sanitize(to);
  if (!bName) return { error: "invalid name" };
  const b = matPath(root, bName);
  if (!fs.existsSync(a)) return { error: "material not found" };
  if (a !== b && fs.existsSync(b)) return { error: "a material with that name already exists" };
  fs.renameSync(a, b);
  return { ok: true, name: bName };
}

/** delete a material file */
export function deleteMaterial(root: string, name: string): { ok?: boolean; error?: string } {
  const p = matPath(root, name);
  if (fs.existsSync(p)) fs.rmSync(p);
  return { ok: true };
}

// ── models (calibration meta + delete) + textures (delete) ────────────────────

/** write a model's calibration to models/<name>/meta.json (drop the file when the
 *  meta is empty, so a reset model carries no meta). */
export function saveModelMeta(root: string, name: string, meta: ModelMeta): { ok?: boolean; error?: string; name?: string } {
  const n = sanitize(name);
  const dir = path.join(root, "public", "assets", "models", n);
  if (!n || !fs.existsSync(dir)) return { error: "model not found" };
  const p = path.join(dir, "meta.json");
  const clean: ModelMeta = {};
  if (typeof meta.base === "number") clean.base = meta.base;
  if (Array.isArray(meta.baseRot) && meta.baseRot.some((n) => n)) {
    clean.baseRot = [Number(meta.baseRot[0]) || 0, Number(meta.baseRot[1]) || 0, Number(meta.baseRot[2]) || 0];
  }
  if (typeof meta.scale === "number") clean.scale = meta.scale;
  // per-slot materials (the model's main materials) — keep only non-empty string
  // assignments; drop the map entirely when nothing is assigned.
  if (meta.materials && typeof meta.materials === "object") {
    const slots: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta.materials)) if (typeof v === "string" && v) slots[k] = v;
    if (Object.keys(slots).length) clean.materials = slots;
  }
  if (typeof meta.material === "string" && meta.material) clean.material = meta.material;
  // collision: only persist "manual" (auto is the default) + its authored boxes
  if (meta.collision === "manual") {
    clean.collision = "manual";
    if (Array.isArray(meta.collisionBoxes) && meta.collisionBoxes.length) {
      clean.collisionBoxes = meta.collisionBoxes
        .filter((b) => b && Array.isArray(b.at) && Array.isArray(b.size))
        .map((b) => {
          const solid: CollisionBox = {
            at: [b.at[0], b.at[1], b.at[2]] as [number, number, number],
            size: [b.size[0], b.size[1], b.size[2]] as [number, number, number],
          };
          // preserve the authored orientation + primitive shape (a diagonal beam via
          // `rot`, a barrel/ball via `shape`) — both are omitted when at their default
          // (axis-aligned / "box") so a plain solid carries no redundant fields.
          if (Array.isArray(b.rot) && b.rot.some((n) => n)) solid.rot = [Number(b.rot[0]) || 0, Number(b.rot[1]) || 0, Number(b.rot[2]) || 0];
          if (b.shape && b.shape !== "box") solid.shape = b.shape;
          return solid;
        });
    }
  }
  if (Object.keys(clean).length === 0) { if (fs.existsSync(p)) fs.rmSync(p); return { ok: true, name: n }; }
  fs.writeFileSync(p, JSON.stringify(clean, null, 2) + "\n");
  return { ok: true, name: n };
}

/** delete a whole model folder (public/assets/models/<name>/) */
export function deleteModel(root: string, name: string): { ok?: boolean; error?: string } {
  const dir = path.join(root, "public", "assets", "models", sanitize(name));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** create a new, EMPTY texture set with a unique auto name and return it. The set's
 *  PBR maps are then loaded from the texture editor's right-hand slots (color / normal
 *  / arm), so importing a texture is just "make a group, then fill its maps" — no
 *  up-front multi-file dialog. */
export function createTexture(root: string): { ok?: boolean; error?: string; name?: string } {
  const base = path.join(root, "public", "assets", "textures");
  fs.mkdirSync(base, { recursive: true });
  let n = "texture";
  let i = 1;
  while (fs.existsSync(path.join(base, n))) n = `texture_${++i}`;
  fs.mkdirSync(path.join(base, n), { recursive: true });
  return { ok: true, name: n };
}

/** delete a whole texture folder (public/assets/textures/<name>/) */
export function deleteTexture(root: string, name: string): { ok?: boolean; error?: string } {
  const dir = path.join(root, "public", "assets", "textures", sanitize(name));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** remove every image file backing one PBR slot (color / normal / arm) of a texture
 *  folder. Shared by the "clear a map" editor action and by a re-import that replaces
 *  a slot (so a color.png swapped for a color.jpg never leaves two color maps behind).
 *  Returns how many files were removed. */
function clearTextureSlot(dir: string, slot: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (texSlot(f) === slot) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
  }
  return n;
}

/** clear a single PBR map of a texture set (public/assets/textures/<name>/), leaving
 *  the folder + its other maps intact. Used by the texture editor's per-map "clear". */
export function deleteTextureMap(root: string, name: string, slot: string): { ok?: boolean; error?: string } {
  const n = sanitize(name);
  if (!n) return { error: "invalid texture name" };
  if (!["color", "normal", "arm"].includes(slot)) return { error: `bad texture slot: ${slot}` };
  const dir = path.join(root, "public", "assets", "textures", n);
  if (!fs.existsSync(dir)) return { error: "texture not found" };
  clearTextureSlot(dir, slot);
  return { ok: true };
}

/** delete an asset file by its catalog-relative path (e.g. "hdri/sky.hdr",
 *  "audio/clip.mp3"). Guarded so it can only remove files inside public/assets/. */
export function deleteAssetFile(root: string, file: string): { ok?: boolean; error?: string } {
  const base = path.resolve(root, "public", "assets");
  const abs = path.resolve(base, String(file));
  if (!abs.startsWith(base + path.sep)) return { error: "path outside assets" };
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  return { ok: true };
}

/** delete a map file (maps/<basename>.json). */
export function deleteMap(root: string, file: string): { ok?: boolean; error?: string } {
  const abs = path.join(root, "maps", path.basename(String(file)));
  if (!abs.endsWith(".json")) return { error: "not a map file" };
  if (fs.existsSync(abs)) fs.rmSync(abs);
  return { ok: true };
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
    const dir = path.join(root, "public", "assets", "textures", name);
    const written: string[] = [];
    for (const f of files) {
      const slot = f.slot;
      const ext = extOf(f.name);
      if (!slot || !["color", "normal", "arm"].includes(slot)) return { error: `bad texture slot: ${slot}` };
      if (!IMG_EXT.has(ext)) return { error: `unsupported image type: .${ext}` };
      // replacing a slot: drop any existing file for it first (differently-named or a
      // different extension) so the set never ends up with two of the same map.
      clearTextureSlot(dir, slot);
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
    // validate every file up front so a rejected one never leaves a half-written
    // folder behind (a model is geometry only — .gltf/.glb + its .bin, no textures).
    for (const f of files) {
      const ext = extOf(f.name);
      if (!MODEL_EXT.has(ext)) return { error: `unsupported model file: .${ext} (a model is geometry only — import textures separately)` };
    }
    const written: string[] = [];
    for (const f of files) {
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
