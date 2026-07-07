// ─── glTF models: catalog-driven loading, keyed by folder name ────────────────
// The *set of models that exist* is discovered by the asset pipeline (scanned
// from public/assets/models/ into `virtual:asset-catalog`) — no asset file list
// is hardcoded here, so committing a new model folder makes it load with zero
// code changes. Models are referenced everywhere by their folder name directly
// (e.g. "Barrel_01", "bolt_action_rifle_7_62") — there is no aliasing layer.
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import { loadGLTF } from "./assets";

/** loaded models, keyed by their folder name (the canonical asset key). null when
 *  a model failed to load — callers must guard. */
export type GameModels = Record<string, GLTFResource | null>;

/** how many models the pipeline will load — drives the loading bar denominator */
export const MODEL_LOAD_COUNT = catalog.models.length;

const pretty = (name: string): string => name.replace(/[_-]+/g, " ").trim();

/** load every model in the catalog, keyed by folder name. Discovering the set
 *  from the catalog means new model folders are picked up automatically; the game
 *  just won't reference them until an object type or weapon names one. */
export async function loadModels(engine: Engine, onEach?: (name: string) => void): Promise<GameModels> {
  const out: GameModels = {};
  await Promise.all(
    catalog.models.map((m) =>
      loadGLTF(engine, m.gltf)
        .then((r) => { out[m.name] = r; onEach?.(pretty(m.name)); })
        .catch((e) => { console.warn("[model] failed:", m.name, e); out[m.name] = null; onEach?.(pretty(m.name)); }),
    ),
  );
  return out;
}

/** fresh scene-graph instance of a loaded model (null-safe) */
export function instantiate(res: GLTFResource | null): Entity | null {
  return res ? res.instantiateSceneRoot() : null;
}
