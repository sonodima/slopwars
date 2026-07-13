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
import type { CollisionBox, ModelAnchor, ModelMeta } from "../../../packages/shared/src/catalog";
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
// Maps live under public/assets/maps/, alongside every other asset. A map is either a flat
// `<id>.json` file or a `<id>/` folder holding the map JSON (map.json / <id>.json) alongside
// its screenshot images. These helpers handle both layouts and preserve whichever a given
// map already uses on save.

/** absolute path of the maps directory (under public/assets/) */
function mapsRoot(root: string): string { return path.join(root, "public", "assets", "maps"); }

/** the map JSON inside a `maps/<id>/` folder (prefer map.json, then <id>.json), or null */
function folderMapJson(root: string, id: string): string | null {
  const dir = path.join(mapsRoot(root), id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const pick = files.find((f) => f === "map.json") ?? files.find((f) => f === `${id}.json`) ?? files[0];
  return pick ? path.join(dir, pick) : null;
}

/** load a map by its catalog-relative `file` (e.g. "assets/maps/koi/map.json") or by a bare
 *  id, and parse it as a MapDef. */
export function loadMap(root: string, file: string): MapDef {
  const dir = mapsRoot(root);
  const raw = String(file).replace(/^\.?\//, "");
  let abs: string;
  if (/^assets[/\\]maps[/\\]/.test(raw)) {
    abs = path.resolve(root, "public", raw);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("path outside maps");
  } else {
    // a bare id: prefer a folder map, fall back to the flat file
    abs = folderMapJson(root, sanitize(raw)) ?? path.join(dir, `${sanitize(raw)}.json`);
  }
  return JSON.parse(fs.readFileSync(abs, "utf8")) as MapDef;
}

/** write a map (git-first: pretty JSON + trailing newline). A map that already lives in a
 *  `maps/<id>/` folder is written back into that folder (keeping its previews); otherwise a
 *  flat `maps/<id>.json` is written. Returns the served-root-relative file path. */
export function saveMap(root: string, id: string, def: MapDef): { ok?: boolean; error?: string; file?: string } {
  const name = sanitize(id);
  if (!name) return { error: "invalid map id" };
  const dir = mapsRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const folder = folderMapJson(root, name);
  const target = folder ?? path.join(dir, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(def, null, 2) + "\n");
  return { ok: true, file: path.relative(path.join(root, "public"), target).split(path.sep).join("/") };
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
  // named attachment points (grip, muzzle, …) — model-local `at` + optional euler `rot`.
  // These were previously dropped here, so authoring a grip in the editor never
  // persisted; keep every anchor that carries a valid position.
  if (meta.anchors && typeof meta.anchors === "object") {
    const anchors: Record<string, ModelAnchor> = {};
    for (const [k, v] of Object.entries(meta.anchors)) {
      if (!k || !v || !Array.isArray(v.at)) continue;
      const a: ModelAnchor = { at: [Number(v.at[0]) || 0, Number(v.at[1]) || 0, Number(v.at[2]) || 0] };
      if (Array.isArray(v.rot) && v.rot.some((x) => x)) a.rot = [Number(v.rot[0]) || 0, Number(v.rot[1]) || 0, Number(v.rot[2]) || 0];
      anchors[k] = a;
    }
    if (Object.keys(anchors).length) clean.anchors = anchors;
  }
  // Prop-Hunt opt-in flag (also previously dropped on save).
  if (meta.propHunt) clean.propHunt = true;
  if (Object.keys(clean).length === 0) { if (fs.existsSync(p)) fs.rmSync(p); return { ok: true, name: n }; }
  fs.writeFileSync(p, JSON.stringify(clean, null, 2) + "\n");
  return { ok: true, name: n };
}

// ── geometry-only models (strip textures out of an imported glTF) ─────────────
// A model in this project is *geometry only*: every surface is a first-class library
// material, resolved by the glTF material (slot) name through meta.materials. A fresh
// import still carries the exporter's images/textures/material-bindings, which (a) makes
// the glTF 404 on texture files that were never imported → Galacean aborts the load and
// the model renders as nothing, and (b) bypasses the material library. `geometryOnlyModel`
// strips all of that and writes meta.materials, so an imported model loads immediately.
// Mirrors scripts/geometry-only-models.mjs (kept for batch repair). Idempotent.

const nearly = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

/** a standard material def from a glTF slot's texture group + baked pbr factors */
function standardDefFromPbr(group: string, pbr: any, emissive?: number[]): MaterialDef {
  const def: any = { type: "standard", texture: group };
  const bc = pbr?.baseColorFactor;
  if (Array.isArray(bc) && !(nearly(bc[0], 1) && nearly(bc[1], 1) && nearly(bc[2], 1))) def.color = [bc[0], bc[1], bc[2]];
  if (typeof pbr?.roughnessFactor === "number" && !nearly(pbr.roughnessFactor, 1)) def.roughness = pbr.roughnessFactor;
  if (typeof pbr?.metallicFactor === "number" && !nearly(pbr.metallicFactor, 1)) def.metallic = pbr.metallicFactor;
  if (Array.isArray(emissive) && (emissive[0] || emissive[1] || emissive[2])) def.emissive = [emissive[0], emissive[1], emissive[2]];
  return def;
}

/** a glass material def carrying the glTF slot's tint/opacity */
function glassDefFromPbr(pbr: any): MaterialDef {
  const base = defaultMaterialDef("glass") as any;
  const bc = pbr?.baseColorFactor;
  if (Array.isArray(bc)) { base.color = [bc[0], bc[1], bc[2]]; if (typeof bc[3] === "number") base.opacity = bc[3]; }
  return base;
}

/** strip an imported model's glTF to geometry, ensure a library material per slot, and
 *  write meta.materials. No-op for a .glb (binary — its materials stay embedded). */
export function geometryOnlyModel(root: string, name: string): void {
  const dir = path.join(root, "public", "assets", "models", sanitize(name));
  if (!fs.existsSync(dir)) return;
  const gltfFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".gltf"));
  if (!gltfFile) return;
  const gltfPath = path.join(dir, gltfFile);
  let gltf: any;
  try { gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8")); } catch { return; }

  const materials: any[] = gltf.materials ?? [];
  const images: any[] = gltf.images ?? [];
  const textures: any[] = gltf.textures ?? [];
  // texture group a slot's colour map lives in: from the glTF image uri when it's already
  // "textures/<group>/…" (a re-import of a consolidated model), else the slot name.
  const groupOf = (m: any, fallback: string): string => {
    const ref = m.pbrMetallicRoughness?.baseColorTexture;
    const uri = ref && textures[ref.index] != null ? images[textures[ref.index].source]?.uri : undefined;
    const mm = typeof uri === "string" && uri.match(/^(?:\.\.\/\.\.\/)?textures\/([^/]+)\//);
    return mm ? mm[1] : fallback;
  };

  const assignments: Record<string, string> = {};
  materials.forEach((m: any, mi: number) => {
    const slot = m.name ?? `${sanitize(name)}_material_${mi}`;
    const asset = sanitize(slot);
    const pbr = m.pbrMetallicRoughness ?? {};
    const matFile = matPath(root, asset);
    // only create a material if one doesn't already exist (idempotent / respects edits)
    if (!fs.existsSync(matFile)) {
      const def = /glass/i.test(slot) ? glassDefFromPbr(pbr) : standardDefFromPbr(groupOf(m, asset), pbr, m.emissiveFactor);
      fs.mkdirSync(path.join(root, MAT_DIR), { recursive: true });
      fs.writeFileSync(matFile, JSON.stringify(def, null, 2) + "\n");
    }
    assignments[slot] = asset;
  });

  // strip to geometry: no images/textures/samplers, no material→texture bindings or
  // shading extensions (the library material owns all shading). Also drop the top-level
  // extensionsUsed/Required so an unsupported ext (KHR_materials_specular/ior) can't abort
  // the load.
  delete gltf.images; delete gltf.textures; delete gltf.samplers;
  delete gltf.extensionsUsed; delete gltf.extensionsRequired;
  for (const m of materials) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr) { delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; }
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture; delete m.extensions;
  }
  fs.writeFileSync(gltfPath, JSON.stringify(gltf, null, 2) + "\n");

  // record the per-slot material assignment on the model's meta (drop the legacy field)
  const metaFile = path.join(dir, "meta.json");
  let meta: any = {};
  if (fs.existsSync(metaFile)) { try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { meta = {}; } }
  meta.materials = { ...(meta.materials ?? {}), ...assignments };
  delete meta.material;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
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
export function createTexture(root: string, name?: string): { ok?: boolean; error?: string; name?: string } {
  const base = path.join(root, "public", "assets", "textures");
  fs.mkdirSync(base, { recursive: true });
  // a name may be given up front (the create dialog); otherwise auto-name uniquely.
  if (name != null && String(name).trim() !== "") {
    const n = sanitize(name);
    if (!n) return { error: "invalid texture name" };
    if (fs.existsSync(path.join(base, n))) return { error: "a texture with that name already exists" };
    fs.mkdirSync(path.join(base, n), { recursive: true });
    return { ok: true, name: n };
  }
  let n = "texture";
  let i = 1;
  while (fs.existsSync(path.join(base, n))) n = `texture_${++i}`;
  fs.mkdirSync(path.join(base, n), { recursive: true });
  return { ok: true, name: n };
}

/** rename a texture set folder (public/assets/textures/<from> → <to>). Fails if the
 *  target already exists. Materials that referenced the old name are repointed by the
 *  caller (the editor shell), mirroring the material rename flow. */
export function renameTexture(root: string, from: string, to: string): { ok?: boolean; error?: string; name?: string } {
  const base = path.join(root, "public", "assets", "textures");
  const a = path.join(base, sanitize(from)), bName = sanitize(to);
  if (!bName) return { error: "invalid name" };
  const b = path.join(base, bName);
  if (!fs.existsSync(a)) return { error: "texture not found" };
  if (a !== b && fs.existsSync(b)) return { error: "a texture with that name already exists" };
  fs.renameSync(a, b);
  return { ok: true, name: bName };
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

/** delete a map — its flat `<id>.json` file, or the whole `<id>/` folder for a folder map
 *  (removing its previews too). Accepts a catalog `file` path or a bare id. */
export function deleteMap(root: string, file: string): { ok?: boolean; error?: string } {
  const dir = mapsRoot(root);
  const raw = String(file).replace(/^\.?\//, "");
  // a folder-map file path ("assets/maps/<id>/map.json") → delete the folder, not just the json
  const folderMatch = /(?:^|[/\\])maps[/\\]([^/\\]+)[/\\][^/\\]+$/.exec(raw);
  const id = folderMatch ? sanitize(folderMatch[1]) : sanitize(path.basename(raw).replace(/\.json$/, ""));
  const folder = path.join(dir, id);
  if (folderMapJson(root, id) && fs.existsSync(folder)) { fs.rmSync(folder, { recursive: true, force: true }); return { ok: true }; }
  const flat = path.join(dir, `${id}.json`);
  if (fs.existsSync(flat)) fs.rmSync(flat);
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
    // make the model geometry-only: strip the glTF's textures/material bindings and
    // write meta.materials, so it loads + shades from the material library right away
    // (an un-stripped glTF 404s on missing texture files and renders as nothing).
    geometryOnlyModel(root, name);
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
