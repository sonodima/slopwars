// ─── glTF models (Poly Haven CC0): weapon proxies + map props + vegetation ────
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import { loadGLTF } from "./assets";
import { ACTIVE_MODEL_IDS, MODEL_SOURCES, ModelId } from "./model-manifest";
export type { ModelId } from "./model-manifest";
/** null when a model failed to load — callers must guard (loading stays resilient) */
export type GameModels = Record<ModelId, GLTFResource | null>;

const ALL_MODEL_IDS = Object.keys(MODEL_SOURCES) as ModelId[];

export const MODEL_LOAD_COUNT = ACTIVE_MODEL_IDS.length;

export async function loadModels(engine: Engine, onEach?: () => void): Promise<GameModels> {
  // Keep every model id present so inactive-map props still degrade gracefully to
  // null/fallback behavior if one is ever requested.
  const out = Object.fromEntries(ALL_MODEL_IDS.map((id) => [id, null])) as GameModels;
  const loaded = await Promise.all(
    ACTIVE_MODEL_IDS.map((id) =>
      loadGLTF(engine, `models/${MODEL_SOURCES[id]}/${MODEL_SOURCES[id]}.gltf`)
        .then((r): GLTFResource | null => { onEach?.(); return r; })
        .catch((e): GLTFResource | null => { console.warn("[model] failed:", id, e); onEach?.(); return null; }),
    ),
  );
  ACTIVE_MODEL_IDS.forEach((id, i) => { out[id] = loaded[i]; });
  return out;
}

/** fresh scene-graph instance of a loaded model (null-safe) */
export function instantiate(res: GLTFResource | null): Entity | null {
  return res ? res.instantiateSceneRoot() : null;
}
