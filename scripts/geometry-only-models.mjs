// ─── One-shot: make model glTFs pure geometry (ROADMAP: "Model = pure geometry")─
// The final step of the model/material consolidation. A model glTF must carry
// geometry only — no images, no textures, no material→texture bindings. Every
// surface is a first-class material from the library, resolved by the glTF material
// (slot) name through the model's meta.materials. This removes texture paths from
// the glTF entirely, so there is nothing to rewrite at load time.
//
// For each glTF material slot this ensures a library material exists and is assigned:
//   • a glass slot (glТF material name contains "glass") → a `glass` material
//     (tint/opacity taken from the glTF), which needs no texture;
//   • every other slot → a `standard` material referencing the slot's texture group
//     (already in the library from the consolidation step — resolved from the slot's
//     own image path so shared textures point at the right group), factors baked in.
// Then it strips images / textures / samplers and each material's texture bindings out
// of the glTF, writes meta.materials, and finally prunes texture groups that no
// material references any more (e.g. a glass slot's leftover maps).
//
// Idempotent. Usage:  node scripts/geometry-only-models.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = path.join(ROOT, "public/assets/models");
const TEXTURES = path.join(ROOT, "public/assets/textures");
const MATERIALS = path.join(ROOT, "public/assets/materials");

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
const nearly = (a, b) => Math.abs(a - b) < 0.02;
// texture groups consumed directly (not through a material): particle sprites.
const NON_MATERIAL_TEXTURES = new Set(["fire", "smoke"]);

const stats = { standard: 0, glass: 0, stripped: 0, prunedGroups: [], notes: [] };

function groupHasColor(group) {
  const dir = path.join(TEXTURES, group);
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.toLowerCase().startsWith("color."));
}

/** create a standard material def with the slot's texture group + baked glTF factors */
function standardDef(group, pbr, emissive) {
  const def = { type: "standard", texture: group };
  const bc = pbr.baseColorFactor;
  if (Array.isArray(bc) && !(nearly(bc[0], 1) && nearly(bc[1], 1) && nearly(bc[2], 1))) def.color = [bc[0], bc[1], bc[2]];
  if (typeof pbr.roughnessFactor === "number" && !nearly(pbr.roughnessFactor, 1)) def.roughness = pbr.roughnessFactor;
  if (typeof pbr.metallicFactor === "number" && !nearly(pbr.metallicFactor, 1)) def.metallic = pbr.metallicFactor;
  if (Array.isArray(emissive) && (emissive[0] || emissive[1] || emissive[2])) def.emissive = [emissive[0], emissive[1], emissive[2]];
  return def;
}

/** create a glass material def from the glТF material's tint/opacity */
function glassDef(pbr) {
  const bc = pbr.baseColorFactor;
  const color = Array.isArray(bc) ? [bc[0], bc[1], bc[2]] : [0.85, 0.92, 0.95];
  const opacity = Array.isArray(bc) && typeof bc[3] === "number" ? bc[3] : 0.18;
  return { type: "glass", color, opacity, roughness: 0.04, ior: 1.5, thickness: 0.3, tint: [0.9, 0.96, 0.98] };
}

function materialize(model) {
  const dir = path.join(MODELS, model);
  const gltfFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".gltf"));
  if (!gltfFile) { stats.notes.push(`${model}: no .gltf (skipped)`); return; }
  const gltfPath = path.join(dir, gltfFile);
  const gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8"));
  const materials = gltf.materials ?? [];
  const images = gltf.images ?? [];
  const textures = gltf.textures ?? [];
  // the texture group a slot's colour map lives in (consolidation rewrote image uris to
  // "textures/<group>/…"), so a slot that reused another's textures points at the right
  // group; falls back to the slot's own name.
  const groupOf = (m, fallback) => {
    const ref = m.pbrMetallicRoughness?.baseColorTexture;
    const uri = ref && textures[ref.index] != null ? images[textures[ref.index].source]?.uri : undefined;
    const mm = typeof uri === "string" && uri.match(/^(?:\.\.\/\.\.\/)?textures\/([^/]+)\//);
    return mm ? mm[1] : fallback;
  };

  const assignments = {};
  materials.forEach((m, mi) => {
    const name = m.name ?? `${model}_material_${mi}`;
    const asset = sanitize(name);
    const pbr = m.pbrMetallicRoughness ?? {};
    const isGlass = /glass/i.test(name);   // only a genuine glass slot → transmissive material
    const matPath = path.join(MATERIALS, `${asset}.json`);

    if (isGlass) {
      fs.writeFileSync(matPath, JSON.stringify(glassDef(pbr), null, 2) + "\n");
      stats.glass++;
    } else if (!fs.existsSync(matPath)) {
      const group = groupOf(m, asset);
      if (!groupHasColor(group)) stats.notes.push(`${model}:${name} → no texture group '${group}', wrote colour-only material`);
      fs.writeFileSync(matPath, JSON.stringify(standardDef(group, pbr, m.emissiveFactor), null, 2) + "\n");
      stats.standard++;
    }
    assignments[name] = asset;
  });

  // strip the glTF down to geometry: no images/textures/samplers, no material→texture
  // bindings, no material shading extensions (the library material owns all shading).
  delete gltf.images; delete gltf.textures; delete gltf.samplers;
  for (const m of materials) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr) { delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; }
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    delete m.extensions;
  }
  fs.writeFileSync(gltfPath, JSON.stringify(gltf, null, 2) + "\n");
  stats.stripped++;

  // record the per-slot material assignment on the model's meta
  const metaPath = path.join(dir, "meta.json");
  let meta = {};
  if (fs.existsSync(metaPath)) { try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { meta = {}; } }
  meta.materials = { ...(meta.materials ?? {}), ...assignments };
  delete meta.material;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

/** delete texture groups no material references any more (glass slots' leftover maps) */
function pruneOrphanGroups() {
  const referenced = new Set(NON_MATERIAL_TEXTURES);
  for (const f of fs.readdirSync(MATERIALS)) {
    if (!f.endsWith(".json")) continue;
    try { const d = JSON.parse(fs.readFileSync(path.join(MATERIALS, f), "utf8")); if (d.type === "standard" && d.texture) referenced.add(d.texture); } catch { /* skip */ }
  }
  for (const g of fs.readdirSync(TEXTURES, { withFileTypes: true })) {
    if (!g.isDirectory() || referenced.has(g.name)) continue;
    fs.rmSync(path.join(TEXTURES, g.name), { recursive: true, force: true });
    stats.prunedGroups.push(g.name);
  }
}

const models = fs.readdirSync(MODELS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const m of models) materialize(m);
pruneOrphanGroups();

console.log("Geometry-only models:");
console.log(`  glTFs stripped to geometry: ${stats.stripped}`);
console.log(`  standard materials ensured: ${stats.standard}`);
console.log(`  glass materials written:    ${stats.glass}`);
console.log(`  orphan groups pruned:       ${stats.prunedGroups.length}${stats.prunedGroups.length ? " (" + stats.prunedGroups.join(", ") + ")" : ""}`);
if (stats.notes.length) { console.log("  notes:"); for (const n of stats.notes) console.log(`    - ${n}`); }
