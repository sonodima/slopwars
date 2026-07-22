// ─── glTF models: catalog-driven loading, keyed by asset id ───────────────────
// The *set of models that exist* is discovered by the asset pipeline (scanned
// from public/assets/models/ into `virtual:asset-catalog`) — no asset file list
// is hardcoded here, so committing a new model folder makes it load with zero
// code changes. Every model carries a stable UUID `id`: authored data (a map's
// props) references that id, so a model can be renamed without breaking uses. The
// game's own built-ins (weapon viewmodels, the character) reference a model by its
// `slug` (the on-disk folder name) through `modelId`, since those are engine
// assets, not user content. Both paths funnel through the id-keyed maps below.
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import type { ModelMeta } from "@slopwars/shared";
import catalog from "virtual:asset-catalog";
import { loadGLTF } from "./assets";
import { shadeModelSlots, type MaterialLibrary } from "./materials";

/** loaded models, keyed by their asset id (the canonical key). null when a model
 *  failed to load — callers must guard. */
export type GameModels = Record<string, GLTFResource | null>;

/** how many models the pipeline will load — drives the loading bar denominator */
export const MODEL_LOAD_COUNT = catalog.models.length;

/** per-model calibration metas (from models/**\/meta.json), keyed by asset id */
const MODEL_META = new Map<string, ModelMeta>(catalog.models.map((m) => [m.id, (m.meta ?? {}) as ModelMeta]));
/** slug → id, so code built-ins can name a model by its on-disk folder */
const ID_BY_SLUG = new Map<string, string>(catalog.models.map((m) => [m.slug, m.id]));

/** resolve a model reference (an authored id, or a code built-in's slug) to its
 *  canonical id. An unknown ref passes through so a dangling reference stays inert. */
export function modelId(ref: string): string { return ID_BY_SLUG.get(ref) ?? ref; }

/** a model's calibration meta by reference (id or slug); empty object if none */
export function modelMetaOf(ref: string): ModelMeta { return MODEL_META.get(modelId(ref)) ?? {}; }

/** the pool of models flagged usable as Prop-Hunt disguises (meta.propHunt), by id.
 *  Empty when no model opts in — callers fall back to the built-in crate disguise. */
export function propHuntPool(): string[] {
  return catalog.models.filter((m) => (m.meta as ModelMeta | undefined)?.propHunt).map((m) => m.id);
}

/** instantiate a calibrated static disguise prop (its own meta scale / base offset /
 *  base rotation applied), parented nowhere and resting with its footing at y=0 so the
 *  caller can drop it at a player's feet. null when the model isn't loaded.
 *  Pass `lib` (a MaterialLibrary that has the prop's slot-material textures loaded) so
 *  the prop is shaded with its assigned MAIN materials — exactly like the same model
 *  placed in a map. Without it a model that relies on slot assignments (e.g. Barrel_01)
 *  renders with its untextured glTF placeholder material (the Prop-Hunt "no texture" bug). */
export function buildProp(models: GameModels, ref: string, lib?: MaterialLibrary): Entity | null {
  const e = instantiate(models[modelId(ref)]);
  if (!e) return null;
  const meta = modelMetaOf(ref);
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
        .then((r) => { out[m.id] = r; onEach?.(pretty(m.name)); })
        .catch((e) => { console.warn("[model] failed:", m.slug, e); out[m.id] = null; onEach?.(pretty(m.name)); }),
    ),
  );
  return out;
}

/** fresh scene-graph instance of a loaded model (null-safe) */
export function instantiate(res: GLTFResource | null): Entity | null {
  return res ? res.instantiateSceneRoot() : null;
}
