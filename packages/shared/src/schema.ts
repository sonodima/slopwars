// ─── `.map` format schema (shared by game + editor) ──────────────────────────
// A map is a self-contained, declarative data object (a "MapDef"). Following the
// convention of modern game-engine editors, *everything placed in a map is an
// object* — geometry (boxes, which a water/glass material turns into a liquid
// surface or a window), props, spawns, pickups, power-ups, sounds and lights are
// all `Placement`s of a registered object `type` with a
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

/** a grouping node with its OWN transform — a first-class parent, like an empty in
 *  Unity/Blender. Its members' stored transforms are *relative to the group* (its
 *  local space), so moving/rotating/scaling the group transforms every child as a
 *  unit while their own stored transforms stay put. Groups nest via `parent`. Both
 *  the editor and the game compose a placement's world transform up its group chain
 *  (see resolveWorld). Transform fields are optional and default to identity, so a
 *  legacy group with no transform composes to the child's absolute transform — old
 *  maps render unchanged. */
export interface GroupDef {
  id: string;
  name: string;
  parent?: string;     // parent group id (undefined = top level)
  collapsed?: boolean; // outliner fold state
  /** group origin/pivot in its parent's space (default [0,0,0]) */
  at?: Tuple3;
  /** group euler rotation in degrees (default [0,0,0]) */
  rot?: Tuple3;
  /** group scale (default [1,1,1]) */
  scale?: Tuple3;
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

// ── group / world transform composition ──────────────────────────────────────
// A placement (or a nested group) stores its transform in its parent group's local
// space. To render or collide it we compose that up the chain of groups. Rotation
// is composed as component-wise euler addition (the same approximation the editor's
// group gizmo has always used — fine for this game's mostly-yaw rotations); scale
// is multiplied per-axis; position is the child's local position scaled+rotated by
// the group then offset by the group origin.

/** a resolved transform (all fields present) */
export interface WorldTf { at: Tuple3; rot: Tuple3; scale: Tuple3 }

/** rotate a vector by an euler-degree triple, applying X then Y then Z */
function rotateEuler(v: Tuple3, deg: Tuple3): Tuple3 {
  const D = Math.PI / 180;
  let [x, y, z] = v;
  if (deg[0]) { const c = Math.cos(deg[0] * D), s = Math.sin(deg[0] * D); const ny = y * c - z * s, nz = y * s + z * c; y = ny; z = nz; }
  if (deg[1]) { const c = Math.cos(deg[1] * D), s = Math.sin(deg[1] * D); const nx = x * c + z * s, nz = -x * s + z * c; x = nx; z = nz; }
  if (deg[2]) { const c = Math.cos(deg[2] * D), s = Math.sin(deg[2] * D); const nx = x * c - y * s, ny = x * s + y * c; x = nx; y = ny; }
  return [x, y, z];
}

/** inverse of rotateEuler: undo an X→Y→Z rotation (apply −Z, −Y, −X) */
function rotateEulerInv(v: Tuple3, deg: Tuple3): Tuple3 {
  const D = Math.PI / 180;
  let [x, y, z] = v;
  if (deg[2]) { const c = Math.cos(-deg[2] * D), s = Math.sin(-deg[2] * D); const nx = x * c - y * s, ny = x * s + y * c; x = nx; y = ny; }
  if (deg[1]) { const c = Math.cos(-deg[1] * D), s = Math.sin(-deg[1] * D); const nx = x * c + z * s, nz = -x * s + z * c; x = nx; z = nz; }
  if (deg[0]) { const c = Math.cos(-deg[0] * D), s = Math.sin(-deg[0] * D); const ny = y * c - z * s, nz = y * s + z * c; y = ny; z = nz; }
  return [x, y, z];
}

/** apply a parent transform to a child (local) transform → world transform */
export function composeTf(parent: WorldTf, child: WorldTf): WorldTf {
  const scaled: Tuple3 = [child.at[0] * parent.scale[0], child.at[1] * parent.scale[1], child.at[2] * parent.scale[2]];
  const rp = rotateEuler(scaled, parent.rot);
  return {
    at: [parent.at[0] + rp[0], parent.at[1] + rp[1], parent.at[2] + rp[2]],
    rot: [parent.rot[0] + child.rot[0], parent.rot[1] + child.rot[1], parent.rot[2] + child.rot[2]],
    scale: [parent.scale[0] * child.scale[0], parent.scale[1] * child.scale[1], parent.scale[2] * child.scale[2]],
  };
}

/** a group's own (local) transform, defaulting missing fields to identity */
export function groupLocalTf(g: GroupDef): WorldTf {
  return { at: g.at ?? [0, 0, 0], rot: g.rot ?? [0, 0, 0], scale: g.scale ?? [1, 1, 1] };
}

/** a group's world transform (composed up its parent chain) */
export function groupWorldTf(def: MapDef, groupId: string | undefined): WorldTf {
  if (!groupId) return { at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  const g = def.groups?.find((x) => x.id === groupId);
  if (!g) return { at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  return composeTf(groupWorldTf(def, g.parent), groupLocalTf(g));
}

/** a placement's world transform — its stored (group-local) transform composed
 *  with its group chain. Ungrouped objects return their stored transform as-is. */
export function resolveWorld(def: MapDef, o: Placement): WorldTf {
  const local: WorldTf = { at: o.at, rot: placeRot(o), scale: placeScale(o) };
  if (!o.group) return local;
  return composeTf(groupWorldTf(def, o.group), local);
}

/** inverse of composeTf: express a world transform in a parent's local space (so a
 *  world-placed object can be stored relative to a group it's dropped into). */
export function invComposeTf(parent: WorldTf, world: WorldTf): WorldTf {
  const rel: Tuple3 = [world.at[0] - parent.at[0], world.at[1] - parent.at[1], world.at[2] - parent.at[2]];
  const unr = rotateEulerInv(rel, parent.rot);
  const div = (a: number, b: number): number => (Math.abs(b) < 1e-6 ? a : a / b);
  return {
    at: [div(unr[0], parent.scale[0]), div(unr[1], parent.scale[1]), div(unr[2], parent.scale[2])],
    rot: [world.rot[0] - parent.rot[0], world.rot[1] - parent.rot[1], world.rot[2] - parent.rot[2]],
    scale: [div(world.scale[0], parent.scale[0]), div(world.scale[1], parent.scale[1]), div(world.scale[2], parent.scale[2])],
  };
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
    objects: [
      // plain gray floor by default (a box with no params uses the default "gray"
      // material — drop any material on its inspector slot to reskin it)
      { type: "box", at: [0, -0.5, 0], scale: [40, 1, 40] },
      { type: "spawn", at: [0, 0, 0] },
    ],
  };
}
