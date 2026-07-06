// ─── Map PBR textures — catalog-driven, per-map palettes, lazily loaded ───────
// A map binds each of the 6 semantic slots to a texture *folder*; unbound slots
// fall back to DEFAULT_TEX. The concrete image files for each folder come from
// the scanned asset catalog (no filenames hardcoded here), and any missing PBR
// map falls back to a guaranteed-present default folder. Folders load once and
// are cached across map switches, so a rotation only pays for new folders.
import { Engine, Texture2D } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import { loadTexture2D } from "./assets";
import { MatId } from "./maps/schema";

/** one PBR material set: base color + tangent normal + packed AO/Rough/Metal */
export interface PbrSet {
  color: Texture2D;
  normal: Texture2D;
  arm: Texture2D; // R=AO, G=roughness, B=metallic (Galacean roughnessMetallic + occlusion)
}

/** the 6 slots every map draws from, resolved to concrete texture sets */
export type MapTextures = Record<MatId, PbrSet>;

export const SLOTS: MatId[] = ["wall", "floor", "crate", "metal", "stone", "dark"];

/** slot → texture folder used when a map doesn't override it */
export const DEFAULT_TEX: Record<MatId, string> = {
  wall: "wall", floor: "floor", crate: "crate", metal: "metal", stone: "stone", dark: "dark",
};

const BY_NAME = new Map(catalog.textures.map((t) => [t.name, t]));
/** a folder guaranteed to exist (for map-level fallbacks) */
const FALLBACK = BY_NAME.has("wall") ? "wall" : (catalog.textures[0]?.name ?? "wall");

/** resolve the concrete file path for one PBR map of a folder, with fallback to
 *  the same map of the fallback folder (keeps rendering resilient to gaps). */
function pathFor(folder: string, slot: "color" | "normal" | "arm"): string {
  return BY_NAME.get(folder)?.maps[slot] ?? BY_NAME.get(FALLBACK)?.maps[slot] ?? `textures/${folder}/${slot}.jpg`;
}

/** folder → its loaded set (shared across all maps; loaded at most once) */
const cache = new Map<string, Promise<PbrSet>>();

function loadSet(engine: Engine, folder: string): Promise<PbrSet> {
  let p = cache.get(folder);
  if (!p) {
    p = (async (): Promise<PbrSet> => {
      const [color, normal, arm] = await Promise.all([
        loadTexture2D(engine, pathFor(folder, "color")),
        loadTexture2D(engine, pathFor(folder, "normal")),
        loadTexture2D(engine, pathFor(folder, "arm")),
      ]);
      return { color, normal, arm };
    })();
    cache.set(folder, p);
  }
  return p;
}

/** resolve a map's 6-slot palette (its bindings over DEFAULT_TEX), loading + caching folders */
export async function resolveTextures(engine: Engine, binding?: Partial<Record<MatId, string>>): Promise<MapTextures> {
  const folderOf = (s: MatId): string => {
    const want = binding?.[s] ?? DEFAULT_TEX[s];
    return BY_NAME.has(want) ? want : DEFAULT_TEX[s];
  };
  const sets = await Promise.all(SLOTS.map((s) => loadSet(engine, folderOf(s))));
  const out = {} as MapTextures;
  SLOTS.forEach((s, i) => { out[s] = sets[i]; });
  return out;
}
