// ─── `.map` format schema (shared by game + editor) ──────────────────────────
// A map is a self-contained, declarative data object (a "MapDef"). Following the
// convention of modern game-engine editors, *everything placed in a map is an
// object* — geometry (box/water), props, spawns, pickups, power-ups,
// sounds and lights are all `Placement`s of a registered object `type` with a
// full transform (position / rotation / scale) and per-type params. The game's
// loader interprets it; object types (game/objects.ts) turn placements into
// entities/collision/behaviour. Maps live as JSON under `maps/` and are fetched
// at runtime — the same interpreter loads them in the game and in the editor.

export type Tuple3 = [number, number, number];

/** a placed object: a registry `type` with a transform + param overrides.
 *  rot is euler degrees; scale defaults to [1,1,1]. For a "box" object the scale
 *  IS its width/height/depth, so the scale gizmo resizes it. */
export interface Placement {
  type: string;
  name?: string;                       // optional user-given label (editor/outliner)
  at: Tuple3;                          // position (world)
  rot?: Tuple3;                        // euler degrees (default [0,0,0])
  scale?: Tuple3;                      // (default [1,1,1])
  params?: Record<string, unknown>;    // shallow-merged over the type's defaults
}

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
  /** every placed object, in order (geometry, props, markers, sounds, …) */
  objects: Placement[];
}

// ── transform helpers ────────────────────────────────────────────────────────

export function placeAt(o: Placement): Tuple3 { return o.at; }
export function placeRot(o: Placement): Tuple3 { return o.rot ?? [0, 0, 0]; }
export function placeScale(o: Placement): Tuple3 { return o.scale ?? [1, 1, 1]; }

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
    objects: [
      { type: "box", at: [0, -0.5, 0], scale: [40, 1, 40], params: { tex: "floor", tile: [10, 10] } },
      { type: "spawn", at: [0, 0, 0] },
    ],
  };
}
