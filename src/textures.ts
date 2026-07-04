// ─── Map PBR textures (Poly Haven CC0) — per-map palettes, lazily loaded ─────
// A map binds each of the 6 semantic slots to a texture *folder*; unbound slots
// fall back to DEFAULT_TEX. Folders load once and are cached across map switches,
// so a rotation only pays for the folders a map actually introduces.
import { Engine, Texture2D } from "@galacean/engine";
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

/** folder → its loaded set (shared across all maps; loaded at most once) */
const cache = new Map<string, Promise<PbrSet>>();

function loadSet(engine: Engine, folder: string): Promise<PbrSet> {
  let p = cache.get(folder);
  if (!p) {
    p = (async (): Promise<PbrSet> => {
      const one = (map: string): Promise<Texture2D> => loadTexture2D(engine, `textures/${folder}/${map}.jpg`);
      const [color, normal, arm] = await Promise.all([one("color"), one("normal"), one("arm")]);
      return { color, normal, arm };
    })();
    cache.set(folder, p);
  }
  return p;
}

/** resolve a map's 6-slot palette (its bindings over DEFAULT_TEX), loading + caching folders */
export async function resolveTextures(engine: Engine, binding?: Partial<Record<MatId, string>>): Promise<MapTextures> {
  const sets = await Promise.all(SLOTS.map((s) => loadSet(engine, binding?.[s] ?? DEFAULT_TEX[s])));
  const out = {} as MapTextures;
  SLOTS.forEach((s, i) => { out[s] = sets[i]; });
  return out;
}
