// ─── Behaviours: composable gameplay traits you attach to a placed object ─────
// Following the component/composition convention of modern engines (Unity
// components, Unreal ActorComponents, Godot nodes), an object's *look* (its model)
// is decoupled from its *behaviour*. Instead of a monolithic "explodable" object
// type that bakes in one model + one behaviour, a `prop` hosts a MODEL and a LIST
// of behaviours — so an explosive barrel is a `prop` (model: Barrel_01) with an
// `explode` behaviour, and you can compose more (e.g. also a `light`) on the same
// object. A new behaviour = one defineBehaviour() call; the editor picks it up for
// free (it reads the same registry the game builds from), exactly like objects.ts.
//
// Behaviours attach at BUILD time: each is handed the host entity + its resolved
// world transform and wires itself into the map (registers a barrel, spawns a
// light, …). A behaviour that manages the host's collision declares ownsCollision
// so the host skips its own static solids (the explode behaviour owns a barrel's
// shootable collider, which killBarrel later removes as a unit).
import type { Entity } from "@galacean/engine";
import type { MapBuilder } from "./mapbuilder";
import type { AABB } from "./map";
import { buildPointLight, POINT_LIGHT, type PointLightLook } from "./lights";

/** default hit-points of an explosive barrel (shared with the explode behaviour) */
export const BARREL_HP = 120;

/** everything a behaviour needs to wire itself into the map: the host entity it
 *  augments and that entity's resolved WORLD transform (groups already composed). */
export interface BehaviourCtx {
  /** the placed model/entity this behaviour augments (may be null if the model failed) */
  entity: Entity | null;
  model: string;                                   // host model folder ("" if none)
  at: readonly [number, number, number];           // world position
  rot: readonly [number, number, number];          // euler degrees
  scale: readonly [number, number, number];
  /** world AABB of the placed model, for behaviours that auto-size to it (or null) */
  bounds: AABB | null;
}

export interface BehaviourType<P extends object> {
  /** editor display name (the picker label) */
  label: string;
  defaults: P;
  /** this behaviour owns the host's collision → the host skips its own static solids
   *  (e.g. explode registers a barrel collider that killBarrel removes on detonation). */
  ownsCollision?: boolean;
  /** wire the behaviour into the map, given the host entity + its transform */
  attach(b: MapBuilder, ctx: BehaviourCtx, p: P): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, BehaviourType<any>>();

export function defineBehaviour<P extends object>(type: string, t: BehaviourType<P>): void {
  REGISTRY.set(type, t);
}

/** a behaviour instance as stored in a placement's params: a `type` tag plus flat
 *  param overrides shallow-merged over the type's defaults (mirrors object params). */
export interface BehaviourSpec { type: string; [k: string]: unknown }

// ── editor introspection (mirrors objects.ts so the inspector needs no game logic) ──
export interface BehaviourEntry { type: string; label: string; defaults: Record<string, unknown> }
export function behaviourCatalog(): BehaviourEntry[] {
  return [...REGISTRY.entries()]
    .map(([type, t]) => ({ type, label: t.label, defaults: { ...t.defaults } }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
export function behaviourDefaults(type: string): Record<string, unknown> { return { ...(REGISTRY.get(type)?.defaults ?? {}) }; }
export function behaviourLabel(type: string): string { return REGISTRY.get(type)?.label ?? type; }

/** does any behaviour in the list manage collision? (host then skips its own solids) */
export function behavioursOwnCollision(list: readonly BehaviourSpec[] | undefined): boolean {
  return !!list && list.some((s) => REGISTRY.get(s.type)?.ownsCollision === true);
}

/** attach every behaviour in a placement's list to its host, merging each spec over
 *  its type's defaults. Unknown types are skipped with a warning (a map authored
 *  against a behaviour that was later removed still loads). */
export function attachBehaviours(b: MapBuilder, ctx: BehaviourCtx, list: readonly BehaviourSpec[] | undefined): void {
  if (!list) return;
  for (const spec of list) {
    const t = REGISTRY.get(spec.type);
    if (!t) { console.warn("[behaviour] unknown type:", spec.type); continue; }
    const p = { ...t.defaults, ...spec } as Record<string, unknown>;
    delete p.type;
    t.attach(b, ctx, p);
  }
}

// ─── built-in behaviours ──────────────────────────────────────────────────────

/** explode: makes the host shootable and detonating at 0 hp — the barrel gameplay
 *  path, now a behaviour instead of a bespoke object. `radius`/`height` size the
 *  shootable + blast collider (a cylinder-ish AABB around the host's base). This
 *  owns the host's collision so the whole thing (visual + collider) vanishes on
 *  detonation via killBarrel. Point a `prop`'s model at a barrel/gas-tank/crate and
 *  add this to make it blow up. */
defineBehaviour<{ hp: number; radius: number; height: number }>("explode", {
  label: "Explode",
  defaults: { hp: BARREL_HP, radius: 0.45, height: 1.1 },
  ownsCollision: true,
  attach(b, ctx, p) {
    const [x, y, z] = ctx.at;
    const solid: AABB = {
      min: { x: x - p.radius, y, z: z - p.radius },
      max: { x: x + p.radius, y: y + p.height, z: z + p.radius },
    };
    b.pushSolid(solid);
    b.map.barrels.push({ pos: { x, y: y + p.height / 2, z }, entity: ctx.entity, solid, hp: p.hp, dead: false });
  },
});

/** light: attach a point light to the host — compose it onto any prop to make a
 *  lantern glow, a barrel cast firelight, a sign emit. `offsetY` lifts the light off
 *  the object's origin so it sits at the emitter, not the floor. Demonstrates real
 *  composition: an explosive barrel that also glows is `prop` + explode + light. */
defineBehaviour<PointLightLook & { offsetY: number }>("light", {
  label: "Light",
  defaults: { ...POINT_LIGHT, offsetY: 1.0 },
  attach(b, ctx, p) {
    const [x, y, z] = ctx.at;
    b.track(buildPointLight(b.root, [x, y + p.offsetY, z], p));
  },
});
