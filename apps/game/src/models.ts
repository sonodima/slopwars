// ─── glTF models: catalog-driven loading, keyed by folder name ────────────────
// The *set of models that exist* is discovered by the asset pipeline (scanned
// from public/assets/models/ into `virtual:asset-catalog`) — no asset file list
// is hardcoded here, so committing a new model folder makes it load with zero
// code changes. Models are referenced everywhere by their folder name directly
// (e.g. "Barrel_01", "wep_ak47") — there is no aliasing layer.
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import type { ModelMeta } from "@slopwars/shared";
import catalog from "virtual:asset-catalog";
import { loadGLTF } from "./assets";
import { shadeModelSlots, type MaterialLibrary } from "./materials";

/** loaded models, keyed by their folder name (the canonical asset key). null when
 *  a model failed to load — callers must guard. */
export type GameModels = Record<string, GLTFResource | null>;

/** how many models the pipeline will load — drives the loading bar denominator */
export const MODEL_LOAD_COUNT = catalog.models.length;

/** per-model calibration metas (from models/<name>/meta.json), keyed by folder name */
const MODEL_META = new Map<string, ModelMeta>(catalog.models.map((m) => [m.name, (m.meta ?? {}) as ModelMeta]));

/** a model's calibration meta (empty object if none) */
export function modelMetaOf(name: string): ModelMeta { return MODEL_META.get(name) ?? {}; }

/** the pool of models flagged usable as Prop-Hunt disguises (meta.propHunt). Empty
 *  when no model opts in — callers fall back to the built-in crate disguise. */
export function propHuntPool(): string[] {
  return catalog.models.filter((m) => (m.meta as ModelMeta | undefined)?.propHunt).map((m) => m.name);
}

/** instantiate a calibrated static disguise prop (its own meta scale / base offset /
 *  base rotation applied), parented nowhere and resting with its footing at y=0 so the
 *  caller can drop it at a player's feet. null when the model isn't loaded.
 *  Pass `lib` (a MaterialLibrary that has the prop's slot-material textures loaded) so
 *  the prop is shaded with its assigned MAIN materials — exactly like the same model
 *  placed in a map. Without it a model that relies on slot assignments (e.g. Barrel_01)
 *  renders with its untextured glTF placeholder material (the Prop-Hunt "no texture" bug). */
export function buildProp(models: GameModels, name: string, lib?: MaterialLibrary): Entity | null {
  const e = instantiate(models[name]);
  if (!e) return null;
  const meta = modelMetaOf(name);
  if (lib) shadeModelSlots(e, meta, lib);
  const ms = meta.scale ?? 1;
  e.transform.setScale(ms, ms, ms);
  const base = (meta.base ?? 0) * ms;
  e.transform.setPosition(0, base, 0);
  if (meta.baseRot && (meta.baseRot[0] || meta.baseRot[1] || meta.baseRot[2])) {
    e.transform.setRotation(meta.baseRot[0], meta.baseRot[1], meta.baseRot[2]);
  }
  return e;
}

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
