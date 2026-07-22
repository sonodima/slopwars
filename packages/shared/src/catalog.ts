// ─── Asset catalog: the file-driven inventory of everything under public/assets ─
// The catalog is produced at dev/build time by the Vite asset-scanner plugin
// (vite-asset-catalog.ts), which reads the filesystem so that *no* asset file
// names are hardcoded in game or editor source. Adding a model/texture folder
// and committing it is all it takes to make the asset available — the scanner
// discovers it, the client loads it, and the editor lists it.

import type { Tuple3 } from "./schema";

// ─── Asset identity: UUID, not name ───────────────────────────────────────────
// Every asset carries a stable `id` (a UUID minted once, at import time) that is
// the ONLY thing authored data (maps, a model's slot materials, a map's HDRI)
// references. Because the reference is the id — never the name or file path — an
// asset can be renamed or moved between folders without breaking a single use.
// The other fields are how humans and code find it: `name` is the mutable display
// label, `slug` is the on-disk folder/file basename (a stable key CODE uses for
// its built-ins — weapon models, the "gray"/"wall" defaults — which are engine
// assets, not user content), and `folder` is the group path the asset lives under
// ("" = top level, "props/crates" = nested), derived purely from the directory
// structure so an importer can drop thousands of assets into folders and have them
// grouped automatically.

export interface AssetId {
  /** stable UUID minted at import time — the canonical identity authored data references */
  id: string;
  /** on-disk folder/file basename (sanitized) — the stable key code uses for built-ins */
  slug: string;
  /** mutable display name (defaults to the slug) */
  name: string;
  /** group path under the kind root, "/"-joined ("" = top level) */
  folder: string;
}

/** find an asset by its canonical id (what authored data stores) */
export function assetById<T extends AssetId>(list: readonly T[], id: string | undefined): T | undefined {
  return id ? list.find((a) => a.id === id) : undefined;
}
/** find an asset by its on-disk slug (what code uses for engine built-ins) */
export function assetBySlug<T extends AssetId>(list: readonly T[], slug: string | undefined): T | undefined {
  return slug ? list.find((a) => a.slug === slug) : undefined;
}
/** resolve a reference that may be either an id (authored data) or a slug (a code
 *  built-in, or legacy data being read) — id wins. For display/lookup resilience. */
export function assetByRef<T extends AssetId>(list: readonly T[], ref: string | undefined): T | undefined {
  return assetById(list, ref) ?? assetBySlug(list, ref);
}

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
  /** optional orientation (euler degrees, model-local). Omit → axis-aligned. The
   *  game collides it as the world AABB that encloses the oriented solid. */
  rot?: Tuple3;
  shape?: CollisionShape;
}

/** how a model's collision is derived: "auto" = one AABB hugging the whole mesh
 *  (the classic behaviour); "manual" = only the authored `collisionBoxes` (so e.g.
 *  a tree's canopy doesn't block the player, only its trunk does). */
export type CollisionMode = "auto" | "manual";

/** a named attachment point on a model, in model-local space. The one the game reads
 *  today is `muzzle` — where a weapon's flash + shots originate (the barrel tip). The
 *  anchors map is deliberately keyed by name so more anchors (sight, …) can be added
 *  later with no schema change. */
export interface ModelAnchor {
  at: Tuple3;         // position of the anchor, in the model's own displayed frame
  rot?: Tuple3;       // euler degrees, applied on top of the model's own orientation
}

/** one authorable anchor kind, driving the editor's anchor UI (the picker label, help
 *  text, and whether a rotation field is meaningful). The game reads anchors by name
 *  (modelAnchor), so a new kind = one entry here plus game code that honours it. */
export interface AnchorKind { key: string; label: string; help: string; rot: boolean }

/** the anchor kinds a model can carry. `grip` is the hand-attach point (where a
 *  third-person character holds the weapon); `muzzle` is where a weapon's flash +
 *  shots originate (the barrel tip). */
export const ANCHOR_KINDS: readonly AnchorKind[] = [
  {
    key: "grip", label: "Held point", rot: true,
    help: "Where a character's hand grips the model in third person — the hand snaps to this point. Rotation is an optional extra turn about it, on top of how the model already sits; leave it at zero unless the model needs re-aiming in the hand. Not used by the first-person viewmodel.",
  },
  {
    key: "muzzle", label: "Muzzle", rot: false,
    help: "Where a weapon's muzzle flash and shots originate — the tip of the barrel. Points forward (−Z) by the model's orientation.",
  },
  {
    key: "ammo", label: "Ammo readout", rot: true,
    help: "Where the first-person viewmodel shows the holographic ammo readout, seated on the weapon body. Rotation angles the readout back toward the eye. A weapon without this anchor shows no readout.",
  },
];

/** the display label for an anchor kind (falls back to the raw key for unknown names) */
export function anchorLabel(key: string): string {
  return ANCHOR_KINDS.find((k) => k.key === key)?.label ?? key;
}

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
  /** the model's surfaces, as first-class materials — one per glTF material slot.
   *  Keyed by the glTF material name (see ModelAsset.slots); the value is a material
   *  asset name. This is the model's MAIN material (not an override on top of the
   *  glTF's own textures): a slot listed here is shaded by the referenced material,
   *  a slot left out keeps whatever the glTF authored (e.g. a transparent glass part).
   *  Every model ships calibrated so each opaque slot points at its own material. */
  materials?: Record<string, string>;
  /** single material applied to EVERY surface `materials` doesn't cover — the way to
   *  shade a model with no named slots (a .glb, whose materials aren't scanned). */
  material?: string;
  /** collision derivation mode (default "auto"). "manual" uses `collisionBoxes`. */
  collision?: CollisionMode;
  /** authored collision solids (model-local space), honoured when collision="manual" */
  collisionBoxes?: CollisionBox[];
  /** may this model be used as a Prop-Hunt disguise? Off by default; flip it on in the
   *  editor's model options to add the model to the pool a hider is randomly disguised
   *  as (instead of the fixed crate). */
  propHunt?: boolean;
  /** named attachment points (model-local). `anchors.muzzle` is where a weapon's flash
   *  + shots originate; more names can be added later. */
  anchors?: Record<string, ModelAnchor>;
  [k: string]: unknown;
}

/** a glTF model discovered under public/assets/models/**\/{slug}/ */
export interface ModelAsset extends AssetId {
  gltf: string;            // path under assets/ e.g. "models/Barrel_01/Barrel_01.gltf"
  meta?: ModelMeta;
  /** the model's material slots (glTF `materials[].name`, in order), scanned from the
   *  .gltf so the editor can offer a per-slot material assignment. Empty/undefined for
   *  a .glb (binary — not parsed) or a model with no named materials. */
  slots?: string[];
}

/** the material asset a given glTF slot should render with (undefined → keep the glTF
 *  material). Prefers the per-slot `materials` map, falling back to the all-surfaces
 *  `material`. Shared by the game renderer and the editor preview so both agree. */
export function modelSlotMaterial(meta: ModelMeta | undefined, slot: string): string | undefined {
  if (!meta) return undefined;
  const perSlot = meta.materials?.[slot];
  if (perSlot) return perSlot;
  return typeof meta.material === "string" && meta.material ? meta.material : undefined;
}

/** a model's named anchor (model-local), or undefined if it has none. `muzzle` is the
 *  flash/shot origin read by the weapon code. */
export function modelAnchor(meta: ModelMeta | undefined, name: string): ModelAnchor | undefined {
  return meta?.anchors?.[name];
}

/** every material asset name a model references across its slots (for preloading the
 *  textures those materials consume). */
export function modelMaterials(meta: ModelMeta | undefined): string[] {
  if (!meta) return [];
  const out = new Set<string>();
  if (meta.materials) for (const v of Object.values(meta.materials)) if (v) out.add(v);
  if (typeof meta.material === "string" && meta.material) out.add(meta.material);
  return [...out];
}

/** which of the standard PBR maps a texture folder provides */
export interface TextureMaps {
  color?: string;   // path under assets/
  normal?: string;
  arm?: string;     // packed AO / roughness / metallic
  [k: string]: string | undefined;
}

/** a PBR texture set discovered under public/assets/textures/**\/{slug}/ */
export interface TextureAsset extends AssetId {
  maps: TextureMaps;
  meta?: Record<string, unknown>;
}

/** an audio clip discovered under public/assets/audio/ (flat file, nestable in folders) */
export interface AudioAsset extends AssetId {
  file: string;            // path under assets/
}

/** an HDRI environment map under public/assets/hdri/ */
export interface HdriAsset extends AssetId {
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

/** map summary produced by scanning the maps/ directory (for the pool + editor picker).
 *  A map is a `maps/<id>/` folder holding the map JSON (map.json / <id>.json) plus any
 *  screenshot images (`preview.*` first, then the rest alphabetically). */
export interface MapCatalogEntry {
  id: string;
  name: string;
  theme: string;
  file: string;            // path relative to the served root, e.g. "maps/koi/map.json"
  /** screenshot paths (served-root-relative) from the folder's preview.json — shown as
   *  thumbnails in the map picker / vote UI. Empty/absent when a map ships no previews. */
  previews?: string[];
}

// ── lookup helpers (used by both apps) — resolve by canonical id ─────────────

export function findModel(cat: AssetCatalog, id: string): ModelAsset | undefined {
  return assetById(cat.models, id);
}

export function findTexture(cat: AssetCatalog, id: string): TextureAsset | undefined {
  return assetById(cat.textures, id);
}
