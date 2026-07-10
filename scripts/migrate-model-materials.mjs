// ─── One-shot migration: model glTF material slots → first-class materials ────
// Dev-only tool (not part of the shipped editor/game). It walks every model under
// public/assets/models/, and for each PLAIN, OPAQUE glTF material slot it:
//   • copies that slot's color/normal into a texture group public/assets/textures/<slot>/
//   • builds a packed AO·Rough·Metal (`arm`) map for the group — the model's own arm
//     if it has one, else synthesized from its roughness map (AO=1, metal=0)
//   • writes a standard material public/assets/materials/<slot>.json referencing the
//     group, with any non-default glTF pbr factors baked in
//   • records meta.materials[<glTF material name>] = <slot> in models/<model>/meta.json
//
// Slots that are transparent (alphaMode BLEND/MASK) or carry material extensions
// (transmission / specular / ior — i.e. glass, foliage cutouts, fancy shading) are
// LEFT to the glTF's own material, since the `standard` material can't reproduce
// them; the editor can still assign them a material by hand later. The model's own
// textures/ folder is left untouched (copied, not moved) so glTF loading never breaks.
//
// Re-run safe: it overwrites the groups/materials it owns and rewrites each meta.
// Requires `sharp` (dev-only, not a shipped dependency) to synthesize arm maps:
//   pnpm --filter @slopwars/editor add sharp   # then run, then remove it again
// Usage:  node scripts/migrate-model-materials.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = path.join(ROOT, "public/assets/models");
const TEXTURES = path.join(ROOT, "public/assets/textures");
const MATERIALS = path.join(ROOT, "public/assets/materials");

// sharp lives in the editor workspace (dev tooling only) — resolve it from there.
const require = createRequire(pathToFileURL(path.join(ROOT, "apps/editor/package.json")));
const sharp = require("sharp");

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
const nearly = (a, b) => Math.abs(a - b) < 0.02;

// Hand-authored library materials (map surfaces) we must never clobber. A fixed
// snapshot so re-running the migration doesn't treat its OWN generated materials as
// reserved (model slot names are model-prefixed and never collide with these).
const RESERVED = new Set([
  "crate", "dark", "floor", "glass", "gray", "koi_floor", "koi_stone", "koi_wall",
  "metal", "neon_ground", "neon_stone", "neon_wall", "office_carpet", "office_ceil",
  "office_tile", "office_wall", "stone", "wall", "water", "wf_dark", "wf_floor",
  "wf_stone", "wf_wall",
]);

let created = { groups: 0, materials: 0, metas: 0, skipped: [] };

async function copyImage(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
}

/** synthesize a packed arm (R=AO, G=roughness, B=metallic) from a roughness-only map */
async function synthArmFromRough(roughAbs, destAbs, metal = 0) {
  const g = await sharp(roughAbs).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = g.info;
  const out = Buffer.alloc(width * height * 3);
  const mv = Math.round(Math.max(0, Math.min(1, metal)) * 255);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = 255;          // AO — none authored → fully lit
    out[i * 3 + 1] = g.data[i]; // roughness
    out[i * 3 + 2] = mv;        // metallic
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toFile(destAbs);
}

/** a solid packed arm when a slot has no roughness map at all */
async function synthFlatArm(destAbs, rough = 0.5, metal = 0) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: Math.round(rough * 255), b: Math.round(metal * 255) } } })
    .jpeg({ quality: 92 }).toFile(destAbs);
}

async function migrateModel(model) {
  const dir = path.join(MODELS, model);
  const gltfFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".gltf"));
  if (!gltfFile) { created.skipped.push(`${model} (no .gltf — .glb not parsed)`); return; }
  const gltf = JSON.parse(fs.readFileSync(path.join(dir, gltfFile), "utf8"));
  const images = (gltf.images ?? []).map((i) => i.uri);
  const textures = gltf.textures ?? [];
  const imgOf = (ref) => (ref && textures[ref.index] != null ? images[textures[ref.index].source] : undefined);
  // resolve a texture reference to an image URI only if the file is actually on disk
  // (some glTFs reference an arm/rough map that was never shipped → treat as absent).
  const fileOf = (ref) => { const u = imgOf(ref); return u && fs.existsSync(path.join(dir, u)) ? u : undefined; };

  const materialsMap = {};   // glTF material name → generated material asset name
  for (let mi = 0; mi < (gltf.materials ?? []).length; mi++) {
    const m = gltf.materials[mi];
    const slotName = m.name ?? `${model}_material_${mi}`;
    const asset = sanitize(slotName);
    const alpha = m.alphaMode ?? "OPAQUE";
    const exts = Object.keys(m.extensions ?? {});
    // leave transparent / extension-shaded surfaces to the glTF (standard can't do them)
    if (alpha !== "OPAQUE" || exts.length) {
      created.skipped.push(`${model}:${slotName} (${alpha}${exts.length ? " " + exts.join(",") : ""})`);
      continue;
    }
    if (RESERVED.has(asset)) { created.skipped.push(`${model}:${slotName} (name '${asset}' reserved)`); continue; }
    const pbr = m.pbrMetallicRoughness ?? {};
    const baseUri = fileOf(pbr.baseColorTexture);
    const normalUri = fileOf(m.normalTexture);
    const mrUri = fileOf(pbr.metallicRoughnessTexture);
    const occUri = fileOf(m.occlusionTexture);
    if (!baseUri) { created.skipped.push(`${model}:${slotName} (no base color texture)`); continue; }

    const groupDir = path.join(TEXTURES, asset);
    const ext = (u) => path.extname(u).slice(1).toLowerCase() || "jpg";
    // color (required) + normal (optional)
    await copyImage(path.join(dir, baseUri), path.join(groupDir, `color.${ext(baseUri)}`));
    if (normalUri) await copyImage(path.join(dir, normalUri), path.join(groupDir, `normal.${ext(normalUri)}`));
    // arm: packed (MR image doubles as occlusion) → copy; roughness-only → synthesize
    const mF = typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1;
    const armOut = path.join(groupDir, "arm.jpg");
    if (mrUri && (mrUri === occUri || /(_arm_|_orm_)/i.test(mrUri))) {
      await copyImage(path.join(dir, mrUri), path.join(groupDir, `arm.${ext(mrUri)}`));
    } else if (mrUri) {
      await synthArmFromRough(path.join(dir, mrUri), armOut, mF);
    } else {
      await synthFlatArm(armOut, typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 0.6, mF);
    }
    created.groups++;

    // material def — bake any non-default pbr factors so the surface matches the glTF
    const def = { type: "standard", texture: asset };
    const bc = pbr.baseColorFactor;
    if (Array.isArray(bc) && !(nearly(bc[0], 1) && nearly(bc[1], 1) && nearly(bc[2], 1))) def.color = [bc[0], bc[1], bc[2]];
    if (typeof pbr.roughnessFactor === "number" && !nearly(pbr.roughnessFactor, 1)) def.roughness = pbr.roughnessFactor;
    if (typeof pbr.metallicFactor === "number" && !nearly(pbr.metallicFactor, 1)) def.metallic = pbr.metallicFactor;
    const em = m.emissiveFactor;
    if (Array.isArray(em) && (em[0] || em[1] || em[2])) def.emissive = [em[0], em[1], em[2]];
    fs.mkdirSync(MATERIALS, { recursive: true });
    fs.writeFileSync(path.join(MATERIALS, `${asset}.json`), JSON.stringify(def, null, 2) + "\n");
    created.materials++;
    materialsMap[slotName] = asset;
  }

  if (!Object.keys(materialsMap).length) return;
  // merge into (or create) the model's meta.json, preserving any existing calibration
  const metaPath = path.join(dir, "meta.json");
  let meta = {};
  if (fs.existsSync(metaPath)) { try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { meta = {}; } }
  meta.materials = { ...(meta.materials ?? {}), ...materialsMap };
  delete meta.material;   // supersede any legacy single-material override
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  created.metas++;
}

async function main() {
  const models = fs.readdirSync(MODELS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const m of models) await migrateModel(m);
  console.log(`\nMigration complete:`);
  console.log(`  texture groups written: ${created.groups}`);
  console.log(`  materials written:      ${created.materials}`);
  console.log(`  model metas updated:    ${created.metas}`);
  console.log(`\n  left to glTF (${created.skipped.length}):`);
  for (const s of created.skipped) console.log(`    - ${s}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
