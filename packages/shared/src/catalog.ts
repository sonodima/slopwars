// ─── Asset catalog: the file-driven inventory of everything under public/assets ─
// The catalog is produced at dev/build time by the Vite asset-scanner plugin
// (vite-asset-catalog.ts), which reads the filesystem so that *no* asset file
// names are hardcoded in game or editor source. Adding a model/texture folder
// and committing it is all it takes to make the asset available — the scanner
// discovers it, the client loads it, and the editor lists it.

import type { Tuple3 } from "./schema";

/** the primitive a collision solid is shaped from. A "box" fills its `size` bounds;
 *  a "cylinder" is upright along Y (radius = size.x/2 = size.z/2, height = size.y);
 *  a "sphere" is centred (radius = size.x/2). Cylinders/spheres let round props
 *  (barrels, balls) collide and tumble roundly instead of as a blocky box. */
export type CollisionShape = "box" | "cylinder" | "sphere";

/** one authored collision solid for a model, in the model's LOCAL space (native
 *  glTF units, before the meta `scale`/`base` calibration). `at` is the solid's
 *  centre, `size` its full extents (also the bounds a non-box shape is inscribed in).
 *  `shape` defaults to "box". Used only when a model's collision mode is "manual". */
export interface CollisionBox {
  at: Tuple3;
  size: Tuple3;
  shape?: CollisionShape;
}

/** how a model's collision is derived: "auto" = one AABB hugging the whole mesh
 *  (the classic behaviour); "manual" = only the authored `collisionBoxes` (so e.g.
 *  a tree's canopy doesn't block the player, only its trunk does). */
export type CollisionMode = "auto" | "manual";

/** author-tunable per-model defaults, persisted to models/{name}/meta.json. Applied
 *  every time the model is instantiated (props, veg, explodables, drops), so a
 *  model can be calibrated once — sit it on its base, size it, reskin it, author its
 *  collision — instead of nudging every placement. All optional; omitted fields keep
 *  the raw glTF (and collision defaults to "auto"). */
export interface ModelMeta {
  base?: number;    // vertical offset (metres) so the model rests on its footing
  /** default orientation (euler degrees) baked into the model so it faces the right
   *  way once, composed under every placement's own rotation. Omit → no reorient. */
  baseRot?: Tuple3;
  scale?: number;   // default uniform scale applied on top of a placement's scale
  material?: string; // material name to override every surface of the model with
  /** collision derivation mode (default "auto"). "manual" uses `collisionBoxes`. */
  collision?: CollisionMode;
  /** authored collision solids (model-local space), honoured when collision="manual" */
  collisionBoxes?: CollisionBox[];
  [k: string]: unknown;
}

/** a glTF model discovered under public/assets/models/{name}/ */
export interface ModelAsset {
  name: string;            // folder name = canonical asset key
  gltf: string;            // path under assets/ e.g. "models/Barrel_01/Barrel_01.gltf"
  meta?: ModelMeta;
}

/** which of the standard PBR maps a texture folder provides */
export interface TextureMaps {
  color?: string;   // path under assets/
  normal?: string;
  arm?: string;     // packed AO / roughness / metallic
  [k: string]: string | undefined;
}

/** a PBR texture set discovered under public/assets/textures/{name}/ */
export interface TextureAsset {
  name: string;
  maps: TextureMaps;
  meta?: Record<string, unknown>;
}

/** an audio clip discovered under public/assets/audio/ (flat file or folder) */
export interface AudioAsset {
  name: string;
  file: string;            // path under assets/
}

/** an HDRI environment map under public/assets/hdri/ */
export interface HdriAsset {
  name: string;
  file: string;            // path under assets/
}

import type { MaterialAsset } from "./materials";

/** the complete discovered inventory */
export interface AssetCatalog {
  models: ModelAsset[];
  textures: TextureAsset[];
  materials: MaterialAsset[];
  audio: AudioAsset[];
  hdri: HdriAsset[];
}

/** map summary produced by scanning maps/*.json (for the pool + editor picker) */
export interface MapCatalogEntry {
  id: string;
  name: string;
  theme: string;
  file: string;            // path relative to the served root, e.g. "maps/koi.json"
}

// ── lookup helpers (used by both apps) ──────────────────────────────────────

export function findModel(cat: AssetCatalog, name: string): ModelAsset | undefined {
  return cat.models.find((m) => m.name === name);
}

export function findTexture(cat: AssetCatalog, name: string): TextureAsset | undefined {
  return cat.textures.find((t) => t.name === name);
}
