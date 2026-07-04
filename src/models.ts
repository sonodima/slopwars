// ─── glTF models (Poly Haven CC0): weapon proxies + map props ─────────────────
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import { loadGLTF } from "./assets";

// PH id → role. Weapons are proxies (no exact AK/USP/knife on PH); AWP + nades stay procedural.
const SOURCES = {
  ak: "bolt_action_rifle_7_62",
  usp: "service_pistol",
  knife: "machete",
  barrel: "Barrel_01",
  lantern: "Lantern_01",
  planter: "planter_box_01",
} as const;

export type ModelId = keyof typeof SOURCES;
export type GameModels = Record<ModelId, GLTFResource>;

/** number of model loads (for progress accounting) */
export const MODEL_LOAD_COUNT = Object.keys(SOURCES).length;

export async function loadModels(engine: Engine, onEach?: () => void): Promise<GameModels> {
  const ids = Object.keys(SOURCES) as ModelId[];
  const loaded = await Promise.all(
    ids.map((id) =>
      loadGLTF(engine, `models/${SOURCES[id]}/${SOURCES[id]}.gltf`).then((r) => { onEach?.(); return r; }),
    ),
  );
  const out = {} as GameModels;
  ids.forEach((id, i) => { out[id] = loaded[i]; });
  return out;
}

/** fresh scene-graph instance of a loaded model (safe to place many times) */
export function instantiate(res: GLTFResource): Entity {
  return res.instantiateSceneRoot();
}
