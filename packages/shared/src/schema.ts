// ─── `.map` format schema (shared by game + editor) ──────────────────────────
// A map is a self-contained, declarative data object (a "MapDef"). It describes
// geometry, materials, skybox/lighting, spawns, pickups and placed objects — no
// build code. The game's loader interprets it; object types (game/objects.ts)
// turn named placements into entities/collision/behaviour. Because a MapDef is
// pure data it lives as a JSON file under `maps/` and is fetched at runtime —
// the same interpreter loads it in the game and in the editor.

export type Tuple3 = [number, number, number];

/** shared PBR material slots every map draws from (loaded once, reused) */
export type MatId = "wall" | "floor" | "crate" | "metal" | "stone" | "dark";

/** solid/visual cuboid — the structural workhorse (walls, floors, ledges) */
export interface BoxBrush {
  k: "box";
  at: Tuple3;               // center
  size: Tuple3;             // w, h, d
  mat: MatId;
  tile?: [number, number];  // texture repeats u,v (default [1,1])
  solid?: boolean;          // default true (false = decoration, no collision)
}

/** flat translucent water plane (visual only) */
export interface WaterBrush { k: "water"; at: Tuple3; s: number }

/** rising staircase; `at` is the low-step start, axis is climb direction */
export interface StairBrush {
  k: "stairs";
  at: Tuple3;
  axis: "x+" | "x-" | "z+" | "z-";
  rise: number;   // total height
  run: number;    // total length along axis
  width: number;  // depth across the steps
  steps?: number; // default 8
  mat?: MatId;    // default "dark"
}

export type Brush = BoxBrush | WaterBrush | StairBrush;

/** a named object from the registry, positioned in the map, with param overrides.
 *  e.g. { type: "barrel", at: [-27,0,-15], params: { hp: 50 } } */
export interface Placement {
  type: string;
  at: Tuple3;
  rot?: number;                       // yaw degrees
  params?: Record<string, unknown>;   // shallow-merged over the type's defaults
}

/** player/pickup spawn (y is resolved to floor height at load) */
export interface SpawnDef { at: [number, number]; yaw: number }

/** skybox + lighting + fog identity for the map */
export interface MapEnv {
  sky: { hdri?: string; solid?: Tuple3 };  // hdri path OR solid rgb (0..1) background
  fog?: { color: Tuple3; start: number; end: number } | null;
  ambient: { color: Tuple3; intensity: number; specular?: number };
  sun: { rot: Tuple3; color: Tuple3; strength: number };
  water?: Tuple3;                          // ambient water-loop source (optional)
}

export interface MapMeta {
  id: string;
  name: string;
  theme: string;
  /** whether this map is part of the random/vote rotation (default true).
   *  false = available (lobby/editor) but never auto-selected into a match. */
  rotate?: boolean;
}

export interface MapDef {
  meta: MapMeta;
  env: MapEnv;
  /** per-map texture palette: slot → folder under public/assets/textures/.
   *  unbound slots fall back to DEFAULT_TEX. this is what makes maps look distinct. */
  textures?: Partial<Record<MatId, string>>;
  brushes: Brush[];
  objects: Placement[];
  spawns: SpawnDef[];
  pickups: Tuple3[];
  powerups: Tuple3[];
}

/** an empty, valid map — the starting point for "New Map" in the editor */
export function emptyMap(id: string, name: string): MapDef {
  return {
    meta: { id, name, theme: "" },
    env: {
      sky: { solid: [0.05, 0.06, 0.08] },
      fog: null,
      ambient: { color: [0.6, 0.62, 0.68], intensity: 0.7, specular: 0.85 },
      sun: { rot: [-50, -35, 0], color: [1.2, 1.15, 1.0], strength: 0.8 },
    },
    textures: {},
    brushes: [{ k: "box", at: [0, -0.5, 0], size: [40, 1, 40], mat: "floor", tile: [10, 10] }],
    objects: [],
    spawns: [{ at: [0, 0], yaw: 0 }],
    pickups: [],
    powerups: [],
  };
}
