// ─── glTF models: catalog-driven loading + semantic role bindings ─────────────
// The *set of models that exist* is discovered by the asset pipeline (scanned
// from public/assets/models/ into `virtual:asset-catalog`) — no asset file list
// is hardcoded here, so committing a new model folder makes it load with zero
// code changes. MODEL_ALIAS below is the only game-side knowledge: it binds the
// short semantic ids the game/objects/weapons reference (a "barrel", the "ak")
// to a concrete model folder. Those are entity→asset bindings, not an inventory.
import { Engine, Entity, GLTFResource } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import { loadGLTF } from "./assets";

// semantic id → model folder name (must exist under public/assets/models/).
// PH id → role. Only 2 real firearms on PH → AWP reuses the bolt-action (a sniper).
export const MODEL_ALIAS = {
  ak: "bolt_action_rifle_7_62",
  usp: "service_pistol",
  knife: "machete",
  mol: "bleach_bottle",
  barrel: "Barrel_01",
  lantern: "Lantern_01",
  planter: "planter_box_01",
  succulent: "cheiridopsis_succulent",
  shrub: "didelta_spinosa",
  // ── props added for map variety (native dims noted for scale math in objects.ts) ──
  crate: "old_military_crate",   // 0.93×0.36×0.68 — wooden supply crate (cover)
  crate2: "plastic_crate_01",    // 0.30×0.26×0.41 — stackable plastic bin (neon)
  rockset: "rock_moss_set_01",   // 2.66×1.77×3.37 — cluster of mossy rocks
  boulder: "namaqualand_boulder_04", // 2.52×1.9×2.5 — single big boulder
  fern: "fern_02",               // 0.99×0.43×0.89 — ground fern (no collision)
  stump: "tree_stump_01",        // 1.43×0.57×1.59 — tree stump (low cover)
  dtree: "quiver_tree_01",       // 1.18×2.72×0.97 — desert quiver tree
  deadtree: "dead_tree_trunk",   // 3.05×0.29×0.28 — fallen log
  toolbox: "metal_toolbox",      // 0.40×0.17×0.32 — small clutter
  desk: "metal_office_desk",     // 2.00×0.79×0.95 — office desk
  chair: "SchoolChair_01",       // 0.57×1.00×0.68 — chair
  pplant: "potted_plant_01",     // 0.59×1.34×0.63 — tall potted plant
  cabinet: "drawer_cabinet",     // 1.14×1.88×0.49 — filing cabinet
  // ── office building props (office map) ──
  sofa: "Sofa_01",               // 1.57×0.80×0.66 — reception/lounge sofa (cover)
  bookshelf: "wooden_bookshelf_worn", // 1.37×2.06×0.58 — tall bookshelf (cover)
  trashcan: "metal_trash_can",   // 0.61×0.98×0.56 — office bin clutter
  extinguisher: "korean_fire_extinguisher_01", // 0.28×0.66×0.37 — wall detail
  cofftable: "modern_coffee_table_01", // 0.60×0.39×1.20 — lounge coffee table
  cardbox: "cardboard_box_01",   // 0.39×0.34×0.52 — storage box (stackable)
  pplant2: "potted_plant_02",    // 0.73×0.63×0.76 — bushy potted plant
  clock: "wall_clock",           // 0.32×0.32×0.05 — wall clock (decoration)
  // ── big nature (waterfall / open outdoor maps) ──
  treebig: "island_tree_01",     // 4.76×5.03×4.82 — large canopy tree
  treemed: "island_tree_02",     // 4.21×3.41×4.07 — medium tree
  cliff: "coastal_cliff_04",     // 86.8×11×24.3 — huge cliff face (scenery backdrop)
  rockset2: "rock_moss_set_02",  // 2.49×1.71×2.02 — mossy rock cluster (variant)
  tropplant: "pachira_aquatica_01", // 1.11×1.9×1.0 — tropical tree-plant
  leafplant: "calathea_orbifolia_01", // 0.6×0.42×0.56 — broad tropical leaves
} as const;

export type ModelId = keyof typeof MODEL_ALIAS;
/** null when a model failed to load — callers must guard (loading stays resilient) */
export type GameModels = Record<ModelId, GLTFResource | null>;

/** how many models the pipeline will load — drives the loading bar denominator */
export const MODEL_LOAD_COUNT = catalog.models.length;

const pretty = (name: string): string => name.replace(/[_-]+/g, " ").trim();

/** load every model in the catalog, then resolve the semantic aliases the game
 *  references. Discovering the set from the catalog means new model folders are
 *  picked up automatically; the game just won't reference them until an alias or
 *  object type points at one. */
export async function loadModels(engine: Engine, onEach?: (name: string) => void): Promise<GameModels> {
  const byName = new Map<string, GLTFResource | null>();
  await Promise.all(
    catalog.models.map((m) =>
      loadGLTF(engine, m.gltf)
        .then((r) => { byName.set(m.name, r); onEach?.(pretty(m.name)); })
        .catch((e) => { console.warn("[model] failed:", m.name, e); byName.set(m.name, null); onEach?.(pretty(m.name)); }),
    ),
  );
  const out = {} as GameModels;
  for (const id of Object.keys(MODEL_ALIAS) as ModelId[]) {
    const folder = MODEL_ALIAS[id];
    if (!byName.has(folder)) console.warn("[model] alias target missing from catalog:", id, "->", folder);
    out[id] = byName.get(folder) ?? null;
  }
  return out;
}

/** fresh scene-graph instance of a loaded model (null-safe) */
export function instantiate(res: GLTFResource | null): Entity | null {
  return res ? res.instantiateSceneRoot() : null;
}
