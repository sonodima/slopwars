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
  /** editor-only: id of the group this object belongs to (see MapDef.groups).
   *  Purely organizational — the game ignores it; objects keep world transforms. */
  group?: string;
}

/** editor-only grouping node. Groups nest (via `parent`) and let the editor move/
 *  rotate/scale their members together. The game loader ignores groups entirely —
 *  they carry no geometry and every object keeps its absolute transform. */
export interface GroupDef {
  id: string;
  name: string;
  parent?: string;     // parent group id (undefined = top level)
  collapsed?: boolean; // outliner fold state
}

/** shadow-map quality tier (drives resolution + softness); "off" disables shadows */
export type ShadowQuality = "off" | "low" | "medium" | "high" | "ultra";
/** camera tonemapping operator */
export type ToneMode = "none" | "neutral" | "aces";
/** fog falloff curve: linear (start→end) or exponential (density) */
export type FogFalloff = "linear" | "exp" | "exp2";

/** skybox + lighting + fog + render quality identity for the map. Newer fields
 *  (sun.intensity, fog.falloff/density, shadows, post) are all optional and fall
 *  back — via the resolve helpers below — to values that match the engine's
 *  original built-in look, so existing maps render identically. */
export interface MapEnv {
  sky: { hdri?: string; solid?: Tuple3 };  // hdri path OR solid rgb (0..1) background
  fog?: { color: Tuple3; start: number; end: number; falloff?: FogFalloff; density?: number } | null;
  ambient: { color: Tuple3; intensity: number; specular?: number };
  /** directional "sun". `intensity` scales the color (brightness); `strength` is
   *  the shadow darkness (kept for back-compat; see shadows.strength). */
  sun: { rot: Tuple3; color: Tuple3; strength: number; intensity?: number };
  water?: Tuple3;                          // ambient water-loop source (optional)
  /** shadow quality + behaviour (defaults ≈ the old built-in "high") */
  shadows?: { quality?: ShadowQuality; distance?: number; strength?: number };
  /** post-processing: tonemapping + bloom (defaults ≈ the old built-in stack) */
  post?: { tonemapping?: ToneMode; bloom?: { enabled?: boolean; intensity?: number; threshold?: number; scatter?: number } };
}

// ── resolved render settings (defaults centralised so game + editor agree) ────

export interface EnvShadows { quality: ShadowQuality; distance: number; strength: number }
export interface EnvBloom { enabled: boolean; intensity: number; threshold: number; scatter: number }
export interface EnvPost { tonemapping: ToneMode; bloom: EnvBloom }

/** shadow settings with defaults filled in (strength falls back to sun.strength) */
export function envShadows(env: MapEnv): EnvShadows {
  const s = env.shadows ?? {};
  return {
    quality: s.quality ?? "high",
    distance: s.distance ?? 70,
    strength: s.strength ?? env.sun.strength ?? 0.82,
  };
}

/** post-processing settings with defaults filled in */
export function envPost(env: MapEnv): EnvPost {
  const p = env.post ?? {};
  const b = p.bloom ?? {};
  return {
    tonemapping: p.tonemapping ?? "aces",
    bloom: { enabled: b.enabled ?? true, intensity: b.intensity ?? 0.55, threshold: b.threshold ?? 1.0, scatter: b.scatter ?? 0.6 },
  };
}

/** sun light colour scaled by its intensity (brightness), since engine lights
 *  carry brightness in the colour magnitude */
export function envSunColor(env: MapEnv): Tuple3 {
  const k = env.sun.intensity ?? 1;
  const c = env.sun.color;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** fog falloff + density with defaults (linear, matching start/end behaviour) */
export function envFogFalloff(fog: NonNullable<MapEnv["fog"]>): { falloff: FogFalloff; density: number } {
  return { falloff: fog.falloff ?? "linear", density: fog.density ?? 0.015 };
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
  /** editor-only object groups (organizational; ignored by the game) */
  groups?: GroupDef[];
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
      // plain gray floor by default (a box with no params uses the default "gray"
      // material — drop any material on its inspector slot to reskin it)
      { type: "box", at: [0, -0.5, 0], scale: [40, 1, 40] },
      { type: "spawn", at: [0, 0, 0] },
    ],
  };
}
