// ─── One-shot: pull every model's textures OUT of its folder into the library ──
// Dev-only follow-up to migrate-model-materials.mjs. A model must carry geometry
// only — no textures. This walks each model's glTF, and for every image it:
//   • picks the texture group that image belongs to (its material's slot: the group
//     is named after the glTF material; the map is color / normal / arm)
//   • ensures the file lives at public/assets/textures/<group>/<slot>.<ext> — moving
//     it there (a migrated slot already has an identical copy, so the model's original
//     is simply dropped)
//   • rewrites the glTF image URI to point at the shared group (../../textures/…)
// then deletes the model's now-empty textures/ folder. Afterwards every texture lives
// in one place, every material in one place, and a model folder is just .gltf + .bin.
//
// The URI written into the glTF is LIBRARY-relative — "textures/<group>/<file>", not a
// "../../" climb out of the model folder — so the repo reads cleanly. The shared Vite
// plugin (vite-asset-catalog) prefixes it back to the "../../textures/…" form the glTF
// loader needs when it serves/builds the file, so nothing on disk carries "../".
//
// Idempotent: re-running normalizes any legacy "../../textures/…" URI to the clean form
// and leaves already-clean ones (and the removed folders) alone.
// Usage:  node scripts/consolidate-model-textures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = path.join(ROOT, "public/assets/models");
const TEXTURES = path.join(ROOT, "public/assets/textures");

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
const extOf = (u) => (path.extname(u).slice(1).toLowerCase() || "jpg");

const stats = { moved: 0, reusedExisting: 0, urisRewritten: 0, foldersRemoved: 0, models: 0, skipped: [] };

/** the canonical file already present for a slot in a group (color.* / normal.* / arm.*) */
function existingSlotFile(groupDir, slot) {
  if (!fs.existsSync(groupDir)) return null;
  return fs.readdirSync(groupDir).find((f) => f.toLowerCase().startsWith(slot + ".")) ?? null;
}

function consolidate(model) {
  const dir = path.join(MODELS, model);
  const gltfFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".gltf"));
  if (!gltfFile) { stats.skipped.push(`${model} (no .gltf — .glb keeps embedded textures)`); return; }
  const gltfPath = path.join(dir, gltfFile);
  const gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8"));
  const images = gltf.images ?? [];
  const textures = gltf.textures ?? [];
  if (!images.length) return;

  // image index → { group, slot } from the materials that reference it (first wins)
  const dest = new Map();
  const mark = (ref, group, slot) => {
    if (!ref || textures[ref.index] == null) return;
    const src = textures[ref.index].source;
    if (src != null && !dest.has(src)) dest.set(src, { group, slot });
  };
  for (let mi = 0; mi < (gltf.materials ?? []).length; mi++) {
    const m = gltf.materials[mi];
    const group = sanitize(m.name ?? `${model}_material_${mi}`);
    const pbr = m.pbrMetallicRoughness ?? {};
    mark(pbr.baseColorTexture, group, "color");
    mark(m.normalTexture, group, "normal");
    mark(pbr.metallicRoughnessTexture ?? m.occlusionTexture, group, "arm");
  }

  let changed = false;
  // several glTF image entries can point at the SAME file (e.g. a glass part reuses the
  // body's diffuse); the file moves once and every entry rewrites to that one location.
  const movedUri = new Map();
  images.forEach((img, i) => {
    const uri = img.uri;
    if (!uri || uri.startsWith("data:")) return;                 // embedded → nothing to move
    if (uri.startsWith("textures/")) return;                     // already clean (library-relative)
    if (uri.startsWith("../../textures/")) {                     // legacy climb → normalize to clean
      img.uri = uri.slice("../../".length); stats.urisRewritten++; changed = true; return;
    }
    if (movedUri.has(uri)) { img.uri = movedUri.get(uri); stats.urisRewritten++; changed = true; return; }
    const srcAbs = path.join(dir, uri);
    const d = dest.get(i) ?? { group: `${sanitize(model)}_extra`, slot: sanitize(path.basename(uri, path.extname(uri))) };
    const groupDir = path.join(TEXTURES, d.group);
    // a migrated slot already holds an identical file → reuse it and drop the original;
    // otherwise move the model's file into the group as <slot>.<ext>.
    let fileName = existingSlotFile(groupDir, d.slot);
    if (fileName) {
      if (fs.existsSync(srcAbs)) fs.rmSync(srcAbs);
      stats.reusedExisting++;
    } else {
      fileName = `${d.slot}.${extOf(uri)}`;
      fs.mkdirSync(groupDir, { recursive: true });
      if (fs.existsSync(srcAbs)) { fs.renameSync(srcAbs, path.join(groupDir, fileName)); stats.moved++; }
    }
    const rel = `textures/${d.group}/${fileName}`;                // library-relative (plugin adds ../../)
    img.uri = rel;
    movedUri.set(uri, rel);
    stats.urisRewritten++;
    changed = true;
  });

  if (changed) fs.writeFileSync(gltfPath, JSON.stringify(gltf, null, 2) + "\n");
  // drop the (now-emptied) model textures folder so the model carries geometry only
  const texDir = path.join(dir, "textures");
  if (fs.existsSync(texDir)) {
    const left = fs.readdirSync(texDir);
    if (!left.length) { fs.rmdirSync(texDir); stats.foldersRemoved++; }
    else stats.skipped.push(`${model}: textures/ still has ${left.join(", ")}`);
  }
  stats.models++;
}

function validate() {
  const problems = [];
  for (const model of fs.readdirSync(MODELS)) {
    const dir = path.join(MODELS, model);
    if (!fs.statSync(dir).isDirectory()) continue;
    const gltfFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".gltf"));
    if (!gltfFile) continue;
    const gltf = JSON.parse(fs.readFileSync(path.join(dir, gltfFile), "utf8"));
    for (const img of gltf.images ?? []) {
      if (!img.uri || img.uri.startsWith("data:")) continue;
      // library-relative uris resolve against public/assets; anything else against the model dir
      const abs = img.uri.startsWith("textures/")
        ? path.join(ROOT, "public/assets", img.uri)
        : path.resolve(dir, img.uri);
      if (!fs.existsSync(abs)) problems.push(`${model}: ${img.uri} → MISSING`);
    }
    if (fs.existsSync(path.join(dir, "textures"))) problems.push(`${model}: textures/ still present`);
  }
  return problems;
}

const models = fs.readdirSync(MODELS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const m of models) consolidate(m);
console.log("Consolidation complete:");
console.log(`  models processed:   ${stats.models}`);
console.log(`  glTF URIs rewritten: ${stats.urisRewritten}`);
console.log(`  files moved to lib:  ${stats.moved}`);
console.log(`  reused migrated copy:${stats.reusedExisting}`);
console.log(`  textures/ removed:   ${stats.foldersRemoved}`);
if (stats.skipped.length) { console.log("  notes:"); for (const s of stats.skipped) console.log(`    - ${s}`); }
const problems = validate();
console.log(problems.length ? `\n  ⚠ VALIDATION PROBLEMS (${problems.length}):` : `\n  ✓ every glTF image resolves; no model carries textures.`);
for (const p of problems) console.log(`    - ${p}`);
process.exit(problems.length ? 1 : 0);
