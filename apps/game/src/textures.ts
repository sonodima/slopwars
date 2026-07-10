// ─── Map PBR textures — catalog-driven, per-folder, lazily loaded ─────────────
// Geometry references a texture *folder* by name directly (e.g. a box's `tex`
// param). The concrete image files for a folder come from the scanned asset
// catalog (no filenames hardcoded here); any missing PBR map falls back to a
// guaranteed-present default folder. Folders load once and are cached across map
// switches, so a rotation only pays for folders it hasn't loaded yet.
import { Engine, Texture2D } from "@galacean/engine";
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

const BY_NAME = new Map(catalog.textures.map((t) => [t.name, t]));
/** a folder guaranteed to exist — used when an object omits `tex` or names a gap */
export const DEFAULT_FOLDER = BY_NAME.has("wall") ? "wall" : (catalog.textures[0]?.name ?? "wall");

/** resolve the concrete file path for one PBR map of a folder, with fallback to
 *  the same map of the default folder (keeps rendering resilient to gaps). */
function pathFor(folder: string, slot: "color" | "normal" | "arm"): string {
  return BY_NAME.get(folder)?.maps[slot] ?? BY_NAME.get(DEFAULT_FOLDER)?.maps[slot] ?? `textures/${folder}/${slot}.jpg`;
}

/** folder → its loaded set (shared across all maps; loaded at most once) */
const cache = new Map<string, Promise<PbrSet>>();

function loadSet(engine: Engine, folder: string): Promise<PbrSet> {
  let p = cache.get(folder);
  if (!p) {
    p = (async (): Promise<PbrSet> => {
      const [color, normal, arm] = await Promise.all([
        loadTexture2D(engine, pathFor(folder, "color")),          // albedo — sRGB
        loadTexture2D(engine, pathFor(folder, "normal"), false),  // tangent normals — linear data
        loadTexture2D(engine, pathFor(folder, "arm"), false),     // AO/Rough/Metal — linear data
      ]);
      return { color, normal, arm };
    })();
    cache.set(folder, p);
  }
  return p;
}

/** load every folder in `folders` (plus the default), returning a folder→set map.
 *  Unknown folders resolve to the default folder's set so builds never break. */
export async function resolveTextures(engine: Engine, folders: string[]): Promise<MapTextures> {
  const want = new Set<string>([DEFAULT_FOLDER, ...folders]);
  const list = [...want];
  const sets = await Promise.all(list.map((f) => loadSet(engine, BY_NAME.has(f) ? f : DEFAULT_FOLDER)));
  const out: MapTextures = new Map();
  list.forEach((f, i) => out.set(f, sets[i]));
  return out;
}
