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

export type ModelId = keyof typeof SOURCES;
/** null when a model failed to load — callers must guard (loading stays resilient) */
export type GameModels = Record<ModelId, GLTFResource | null>;

export const MODEL_LOAD_COUNT = Object.keys(SOURCES).length;

export async function loadModels(engine: Engine, onEach?: (name: string) => void): Promise<GameModels> {
  const ids = Object.keys(SOURCES) as ModelId[];
  const pretty = (id: ModelId): string => SOURCES[id].replace(/[_-]+/g, " ").trim();
  const loaded = await Promise.all(
    ids.map((id) =>
      loadGLTF(engine, `models/${SOURCES[id]}/${SOURCES[id]}.gltf`)
        .then((r): GLTFResource | null => { onEach?.(pretty(id)); return r; })
        .catch((e): GLTFResource | null => { console.warn("[model] failed:", id, e); onEach?.(pretty(id)); return null; }),
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
