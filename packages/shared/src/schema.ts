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
 *  (see resolveWorld). Transform fields are optional and default to identity. */
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
  /** simulate the whole group as ONE movable rigid body (a lantern = mesh + light,
   *  a stack of crates…): its members are parented under a single dynamic body and
   *  move/tumble together. Members contribute no static collision — the body's
   *  collider (derived from their combined bounds) is the only one. Default off. */
  physics?: boolean;
  /** body mass in kg when `physics` is on (heavier = harder to shove). Default 8. */
  mass?: number;
  /** surface grip 0 (ice) … 1+ (rubber) — PhysX static+dynamic friction. Default 0.6. */
  friction?: number;
  /** bounciness 0 (dead thud) … 1 (super-ball) — PhysX restitution. Default 0.15. */
  restitution?: number;
  /** how fast the body loses linear speed as it coasts (0 = never). Default 0.05. */
  linearDamping?: number;
  /** how fast the body loses spin (higher = stops rolling sooner). Default 0.35. */
  angularDamping?: number;
}

/** the physical tuning of a dynamic rigid body — shared by physics groups and physics
 *  props, and consumed by the PhysX prop simulation. All optional; missing fields fall
 *  back to PHYSICS_DEFAULTS so a body is meaningful the moment `physics` is switched on. */
export interface PhysicsProps {
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
}

/** engine-matched defaults for a dynamic body (mirror the values PhysxProps used to
 *  bake in globally, so turning a body's params on changes nothing until you tune it). */
export const PHYSICS_DEFAULTS: Required<PhysicsProps> = {
  mass: 8, friction: 0.6, restitution: 0.15, linearDamping: 0.05, angularDamping: 0.35,
};

/** fill a partial physics spec with the defaults (mass may be overridden separately —
 *  props default to a lighter 5kg, so pass it explicitly). */
export function resolvePhysics(p: PhysicsProps): Required<PhysicsProps> {
  return {
    mass: p.mass ?? PHYSICS_DEFAULTS.mass,
    friction: p.friction ?? PHYSICS_DEFAULTS.friction,
    restitution: p.restitution ?? PHYSICS_DEFAULTS.restitution,
    linearDamping: p.linearDamping ?? PHYSICS_DEFAULTS.linearDamping,
    angularDamping: p.angularDamping ?? PHYSICS_DEFAULTS.angularDamping,
  };
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
// space. To render or collide it we compose that up the chain of groups: scale is
// multiplied per-axis; position is the child's local position scaled, rotated by the
// parent, then offset by the parent origin; rotation is composed as a QUATERNION
// product (not component-wise euler addition — that only works for rotations about a
// single shared axis, which silently skews tilted groups). All rotation maths here
// mirror the engine's own euler convention (Galacean `Quaternion.rotationEuler`, i.e.
// intrinsic Y→X→Z) so a composed transform renders exactly as the engine orients it,
// and collision built from the same helpers lines up with the visual.

/** a resolved transform (all fields present) */
export interface WorldTf { at: Tuple3; rot: Tuple3; scale: Tuple3 }

// ── quaternion helpers (engine-convention, pure — no engine dependency) ───────
// [x, y, z, w]. These replicate Galacean's math bit-for-bit (verified against
// @galacean/engine-math): euler↔quat, product, conjugate, and vector rotation, so
// the shared schema can compose rotations correctly without importing the engine.
const D2R = Math.PI / 180;
type Quat = [number, number, number, number];

/** euler DEGREES (x,y,z) → quaternion, matching `Quaternion.rotationEuler` (Y→X→Z) */
function eulerToQuat(deg: Tuple3): Quat {
  const hx = deg[0] * D2R * 0.5, hy = deg[1] * D2R * 0.5, hz = deg[2] * D2R * 0.5;
  const sx = Math.sin(hx), cx = Math.cos(hx), sy = Math.sin(hy), cy = Math.cos(hy), sz = Math.sin(hz), cz = Math.cos(hz);
  return [cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz, cy * cx * sz - sy * sx * cz, cy * cx * cz + sy * sx * sz];
}

/** quaternion → euler DEGREES, matching `Quaternion.toEuler` (inverse of eulerToQuat) */
function quatToEuler(q: Quat): Tuple3 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, ww = w * w, unit = xx + yy + zz + ww;
  const test = 2 * (x * w - y * z);
  let px: number, py: number, pz: number;   // yaw-pitch-roll temps (pre-swap)
  if (test > (1 - 1e-6) * unit) { px = Math.atan2(2 * (w * y - x * z), xx + ww - yy - zz); py = Math.PI / 2; pz = 0; }
  else if (test < -(1 - 1e-6) * unit) { px = Math.atan2(2 * (w * y - x * z), xx + ww - yy - zz); py = -Math.PI / 2; pz = 0; }
  else { px = Math.atan2(2 * (z * x + y * w), zz + ww - yy - xx); py = Math.asin(test / unit); pz = Math.atan2(2 * (x * y + z * w), yy + ww - zz - xx); }
  return [py / D2R, px / D2R, pz / D2R];   // toEuler swaps x/y: eulerX=pitch, eulerY=yaw, eulerZ=roll
}

/** Hamilton product a·b, matching `Quaternion.multiply` */
function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** conjugate (inverse rotation for a unit quaternion) */
function quatConj(q: Quat): Quat { return [-q[0], -q[1], -q[2], q[3]]; }

/** rotate a vector by a quaternion, matching `Vector3.transformByQuat` */
function quatRotate(q: Quat, v: Tuple3): Tuple3 {
  const [qx, qy, qz, qw] = q, [x, y, z] = v;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw - iw * qx - iy * qz + iz * qy, iy * qw - iw * qy - iz * qx + ix * qz, iz * qw - iw * qz - ix * qy + iy * qx];
}

/** rotate a vector by an euler-degree triple (engine convention) */
export function rotateEuler(v: Tuple3, deg: Tuple3): Tuple3 {
  if (!deg[0] && !deg[1] && !deg[2]) return [v[0], v[1], v[2]];
  return quatRotate(eulerToQuat(deg), v);
}

/** inverse of rotateEuler: rotate by the opposite of an euler-degree triple */
export function rotateEulerInv(v: Tuple3, deg: Tuple3): Tuple3 {
  if (!deg[0] && !deg[1] && !deg[2]) return [v[0], v[1], v[2]];
  return quatRotate(quatConj(eulerToQuat(deg)), v);
}

/** apply a parent transform to a child (local) transform → world transform */
export function composeTf(parent: WorldTf, child: WorldTf): WorldTf {
  const pq = eulerToQuat(parent.rot);
  const scaled: Tuple3 = [child.at[0] * parent.scale[0], child.at[1] * parent.scale[1], child.at[2] * parent.scale[2]];
  const rp = quatRotate(pq, scaled);
  return {
    at: [parent.at[0] + rp[0], parent.at[1] + rp[1], parent.at[2] + rp[2]],
    rot: quatToEuler(quatMul(pq, eulerToQuat(child.rot))),
    scale: [parent.scale[0] * child.scale[0], parent.scale[1] * child.scale[1], parent.scale[2] * child.scale[2]],
  };
}

/** a group's own (local) transform, defaulting missing fields to identity */
export function groupLocalTf(g: GroupDef): WorldTf {
  return { at: g.at ?? [0, 0, 0], rot: g.rot ?? [0, 0, 0], scale: g.scale ?? [1, 1, 1] };
}

// ── group hierarchy queries (pure MapDef helpers — shared by editor + game) ────
// A map's groups form a forest (each GroupDef.parent points at another group, or the
// top level) and every object may belong to one group. These read-only walks over
// that hierarchy back both the editor (outliner, selection, group transforms — via
// thin EditorState wrappers) and the game loader (physics groups), so they live here:
// one definition, no drift between the two sides.

/** the group with this id (undefined id → undefined) */
export function groupById(def: MapDef, id: string | undefined): GroupDef | undefined {
  return id ? def.groups?.find((g) => g.id === id) : undefined;
}

/** direct child groups of a parent (undefined parent → the top-level groups) */
export function childGroups(def: MapDef, parent: string | undefined): GroupDef[] {
  return (def.groups ?? []).filter((g) => (g.parent ?? undefined) === (parent ?? undefined));
}

/** objects placed directly in a group (not its descendant groups) */
export function groupMembersDirect(def: MapDef, groupId: string): Placement[] {
  return def.objects.filter((o) => o.group === groupId);
}

/** objects in a group and, when `recursive`, all its descendant groups too */
export function groupMembers(def: MapDef, groupId: string, recursive = true): Placement[] {
  const out = groupMembersDirect(def, groupId);
  if (recursive) for (const g of childGroups(def, groupId)) out.push(...groupMembers(def, g.id, true));
  return out;
}

/** physics-enabled groups whose ancestor chain has no *other* physics group, so a
 *  nested physics group is absorbed by the outermost one (one body, not many). */
export function topPhysicsGroups(def: MapDef): GroupDef[] {
  const ancestorHasPhysics = (g: GroupDef): boolean => {
    let p = groupById(def, g.parent);
    while (p) { if (p.physics) return true; p = groupById(def, p.parent); }
    return false;
  };
  return (def.groups ?? []).filter((g) => g.physics && !ancestorHasPhysics(g));
}

/** a group's world transform (composed up its parent chain) */
export function groupWorldTf(def: MapDef, groupId: string | undefined): WorldTf {
  if (!groupId) return { at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  const g = groupById(def, groupId);
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
 *  world-placed object can be stored relative to a group it's dropped into). Rotation
 *  is undone as parent⁻¹ · world (quaternion), the exact inverse of composeTf. */
export function invComposeTf(parent: WorldTf, world: WorldTf): WorldTf {
  const pInv = quatConj(eulerToQuat(parent.rot));
  const rel: Tuple3 = [world.at[0] - parent.at[0], world.at[1] - parent.at[1], world.at[2] - parent.at[2]];
  const unr = quatRotate(pInv, rel);
  const div = (a: number, b: number): number => (Math.abs(b) < 1e-6 ? a : a / b);
  return {
    at: [div(unr[0], parent.scale[0]), div(unr[1], parent.scale[1]), div(unr[2], parent.scale[2])],
    rot: quatToEuler(quatMul(pInv, eulerToQuat(world.rot))),
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
