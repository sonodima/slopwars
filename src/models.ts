// ─── glTF models (Poly Haven CC0): weapon proxies + map props + vegetation ────
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import { loadGLTF } from "./assets";

// PH id → role. Only 2 real firearms on PH → AWP reuses the bolt-action (a sniper).
const SOURCES = {
  ak: "bolt_action_rifle_7_62",
  usp: "service_pistol",
  knife: "machete",
  mol: "bleach_bottle",
  barrel: "Barrel_01",
  lantern: "Lantern_01",
  planter: "planter_box_01",
  succulent: "cheiridopsis_succulent",
  shrub: "didelta_spinosa",
} as const;

export type ModelId = keyof typeof SOURCES;
/** null when a model failed to load — callers must guard (loading stays resilient) */
export type GameModels = Record<ModelId, GLTFResource | null>;

export const MODEL_LOAD_COUNT = Object.keys(SOURCES).length;

export async function loadModels(engine: Engine, onEach?: () => void): Promise<GameModels> {
  const ids = Object.keys(SOURCES) as ModelId[];
  const loaded = await Promise.all(
    ids.map((id) =>
      loadGLTF(engine, `models/${SOURCES[id]}/${SOURCES[id]}.gltf`)
        .then((r): GLTFResource | null => { onEach?.(); return r; })
        .catch((e): GLTFResource | null => { console.warn("[model] failed:", id, e); onEach?.(); return null; }),
    ),
  );
  const out = {} as GameModels;
  ids.forEach((id, i) => { out[id] = loaded[i]; });
  return out;
}

/** fresh scene-graph instance of a loaded model (null-safe) */
export function instantiate(res: GLTFResource | null): Entity | null {
  return res ? res.instantiateSceneRoot() : null;
}
