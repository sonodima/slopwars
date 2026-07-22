// ─── Map PBR textures — catalog-driven, per-folder, lazily loaded ─────────────
// Geometry references a texture *folder* by name directly (e.g. a box's `tex`
// param). The concrete image files for a folder come from the scanned asset
// catalog (no filenames hardcoded here); any missing PBR map falls back to a
// guaranteed-present default folder. Folders load once and are cached across map
// switches, so a rotation only pays for folders it hasn't loaded yet.
import { Engine, Texture2D } from "@galacean/engine";
import type { TextureAsset } from "@slopwars/shared";
import catalog from "virtual:asset-catalog";
import { loadTexture2D } from "./assets";

/** one PBR material set: base color + tangent normal + packed AO/Rough/Metal */
export interface PbrSet {
  color: Texture2D;
  normal: Texture2D;
  arm: Texture2D; // R=AO, G=roughness, B=metallic (Galacean roughnessMetallic + occlusion)
}

/** resolved textures for a map: folder name → its loaded PBR set */
export type MapTextures = Map<string, PbrSet>;

const BY_ID = new Map(catalog.textures.map((t) => [t.id, t]));
const ID_BY_NAME = new Map(catalog.textures.map((t) => [t.name, t.id]));
/** the id of a texture set guaranteed to exist — the graceful default for a gap */
export const DEFAULT_FOLDER = ID_BY_NAME.get("wall") ?? catalog.textures[0]?.id ?? "wall";

/** resolve a texture reference to its id: an authored id passes through; a built-in's
 *  folder name is looked up. */
export function textureId(ref: string): string { return ID_BY_NAME.get(ref) ?? ref; }

/** the concrete file path for one PBR map of a texture, falling back to the same map of
 *  the default set (keeps rendering resilient to a missing map). */
function pathFor(byId: Map<string, TextureAsset>, id: string, slot: "color" | "normal" | "arm"): string {
  return byId.get(id)?.maps[slot] ?? byId.get(DEFAULT_FOLDER)?.maps[slot] ?? "";
}

/** texture id → its loaded set (shared across all maps; loaded at most once) */
const cache = new Map<string, Promise<PbrSet>>();

function loadSet(engine: Engine, byId: Map<string, TextureAsset>, id: string): Promise<PbrSet> {
  let p = cache.get(id);
  if (!p) {
    p = (async (): Promise<PbrSet> => {
      const [color, normal, arm] = await Promise.all([
        loadTexture2D(engine, pathFor(byId, id, "color")),          // albedo — sRGB
        loadTexture2D(engine, pathFor(byId, id, "normal"), false),  // tangent normals — linear data
        loadTexture2D(engine, pathFor(byId, id, "arm"), false),     // AO/Rough/Metal — linear data
      ]);
      return { color, normal, arm };
    })();
    cache.set(id, p);
  }
  return p;
}

/** load every texture in `refs` (ids or slugs, plus the default), returning an
 *  id→set map. An unknown reference resolves to the default so builds never break.
 *  `index` overrides the compiled-in catalog (the editor passes its live texture
 *  list so a just-imported folder resolves without a dev-server restart — the
 *  virtual catalog is a dev-server-start snapshot); the game omits it. */
export async function resolveTextures(engine: Engine, refs: string[], index?: TextureAsset[]): Promise<MapTextures> {
  const byId = index ? new Map(index.map((t) => [t.id, t])) : BY_ID;
  const byName = index ? new Map(index.map((t) => [t.name, t.id])) : ID_BY_NAME;
  const idOf = (ref: string): string => (byId.has(ref) ? ref : byName.get(ref) ?? ref);
  const want = new Set<string>([DEFAULT_FOLDER, ...refs.map(idOf)]);
  const list = [...want];
  const sets = await Promise.all(list.map((id) => loadSet(engine, byId, byId.has(id) ? id : DEFAULT_FOLDER)));
  const out: MapTextures = new Map();
  list.forEach((id, i) => out.set(id, sets[i]));
  return out;
}
