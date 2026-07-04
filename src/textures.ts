// ─── Map PBR textures (Poly Haven CC0) — loaded, not generated ───────────────
import { Engine, Texture2D } from "@galacean/engine";
import { loadTexture2D } from "./assets";

/** one PBR material set: base color + tangent normal + packed AO/Rough/Metal */
export interface PbrSet {
  color: Texture2D;
  normal: Texture2D;
  arm: Texture2D; // R=AO, G=roughness, B=metallic (Galacean roughnessMetallic + occlusion)
}

export interface MapTextures {
  wall: PbrSet;   // sand plaster
  floor: PbrSet;  // gravel concrete
  crate: PbrSet;  // worn wood planks
  metal: PbrSet;  // corrugated iron
  stone: PbrSet;  // sandstone blocks
  dark: PbrSet;   // asphalt
}

const SLOTS: (keyof MapTextures)[] = ["wall", "floor", "crate", "metal", "stone", "dark"];

/** number of individual texture loads (for progress accounting) */
export const TEXTURE_LOAD_COUNT = SLOTS.length * 3;

async function loadSet(engine: Engine, slot: string, onEach?: () => void): Promise<PbrSet> {
  const one = (map: string): Promise<Texture2D> =>
    loadTexture2D(engine, `textures/${slot}/${map}.jpg`).then((t) => { onEach?.(); return t; });
  const [color, normal, arm] = await Promise.all([one("color"), one("normal"), one("arm")]);
  return { color, normal, arm };
}

export async function loadMapTextures(engine: Engine, onEach?: () => void): Promise<MapTextures> {
  const sets = await Promise.all(SLOTS.map((s) => loadSet(engine, s, onEach)));
  const out = {} as MapTextures;
  SLOTS.forEach((s, i) => { out[s] = sets[i]; });
  return out;
}
