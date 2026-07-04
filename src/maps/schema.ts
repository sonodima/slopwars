// ─── `.map` format schema ─────────────────────────────────────────────────────
// A map is a self-contained, declarative data object (a "MapDef"). It describes
// geometry, materials, skybox/lighting, spawns, pickups and placed objects — no
// build code. The loader (loader.ts) interprets it; object types (objects.ts)
// turn named placements into entities/collision/behaviour. Because a MapDef is
// pure data it can be authored inline (src/maps/*.ts) or serialized to a `.map`
// JSON file and loaded at runtime — same interpreter either way.

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

export interface MapMeta { id: string; name: string; theme: string }

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
