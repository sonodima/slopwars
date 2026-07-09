// ─── Object registry: every placeable thing in a map is a registered object ───
// Following modern game-engine convention, a map is just a list of object
// placements — geometry (boxes; a water/glass material makes one a liquid surface
// or a window), props, spawns, pickups, power-ups, sounds and lights are ALL object
// types. Each type declares DEFAULT params, an
// editor `category`, and a build() that turns a transform (position/rotation/
// scale) + params into geometry/collision/behaviour. New behaviours = one
// defineObject() call; the loader and the editor pick them up for free.
import catalog from "virtual:asset-catalog";
import type { MapBuilder } from "./mapbuilder";
import { AABB } from "./map";
import { assetUrl } from "./assets";
import { DEFAULT_MATERIAL, materialTextureFolders } from "./materials";
import { PARTICLE_LOOK, type ParticleLook } from "./particles";
import {
  buildPointLight, buildDirLight, buildSpotLight, POINT_LIGHT, DIR_LIGHT, SPOT_LIGHT,
  type PointLightLook, type DirLightLook, type SpotLightLook,
} from "./lights";
import type { MapDef, Placement, MaterialDef } from "./maps/schema";
import { modelMaterials, type ModelMeta } from "@slopwars/shared";

export const BARREL_HP = 120;

/** a resolved transform passed to every object build() */
export interface Transform {
  at: readonly [number, number, number];
  rot: readonly [number, number, number];   // euler degrees
  scale: readonly [number, number, number];
}

/** editor grouping for the asset browser */
export type ObjCategory = "geometry" | "prop" | "entity" | "structure" | "marker" | "sound" | "light";

export interface ObjectType<P extends object> {
  defaults: P;
  category: ObjCategory;
  /** built in a second pass, after all geometry (floor-relative markers) */
  deferred?: boolean;
  build(b: MapBuilder, t: Transform, p: P): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, ObjectType<any>>();

export function defineObject<P extends object>(name: string, type: ObjectType<P>): void {
  REGISTRY.set(name, type);
}

/** Object wrapping: register `name` as a preset of an existing `base` object type
 *  with some params pre-filled. The wrapper appears in the editor as its own
 *  object (with the merged defaults, so its params are still editable) but reuses
 *  the base type's build() — no duplicated logic. This is how `fire` and `smoke`
 *  are just a `particles` emitter with different defaults. */
export function definePreset<P extends object>(
  name: string, base: string, preset: Partial<P>, category?: ObjCategory,
): void {
  const bt = REGISTRY.get(base);
  if (!bt) { console.warn("[object] preset base not found:", base); return; }
  REGISTRY.set(name, {
    defaults: { ...bt.defaults, ...preset },
    category: category ?? bt.category,
    deferred: bt.deferred,
    build: bt.build,
  });
}

// editor default transform scale for a dropped object type (model props carry a
// tuned native size; everything else drops at 1). Objects honour the regular
// Scale tool via their transform — there is no per-object "scale" param anymore.
const DROP_SCALE = new Map<string, number>();
export function objectDropScale(name: string): number { return DROP_SCALE.get(name) ?? 1; }

/** build a placed object, merging overrides over its defaults and resolving the
 *  transform (rot/scale default to identity). */
export function buildObject(b: MapBuilder, o: Placement, index = -1): void {
  const t = REGISTRY.get(o.type);
  if (!t) { console.warn("[map] unknown object type:", o.type); return; }
  const p = { ...t.defaults, ...(o.params ?? {}) };
  const tf: Transform = { at: o.at, rot: o.rot ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1] };
  b.buildIndex = index;
  t.build(b, tf, p);
  b.buildIndex = -1;
}

/** deferred types (spawns/pickups) are built after geometry so floors resolve */
export function isDeferredType(name: string): boolean {
  return REGISTRY.get(name)?.deferred === true;
}

// ── editor introspection ──────────────────────────────────────────────────────
/** the human sub-label for a placement: the salient param that identifies it (a
 *  prop's model, a sound's clip), or "" for a plain typed object. Shared by the
 *  editor outliner + inspector so both name an object the same way. */
export function placementDetail(o: Placement): string {
  if (o.type === "prop" && typeof o.params?.model === "string") return o.params.model;
  if (o.type === "sound" && typeof o.params?.clip === "string") return o.params.clip;
  return "";
}

export interface ObjEntry { name: string; category: ObjCategory; defaults: Record<string, unknown> }
export function objectTypeNames(): string[] { return [...REGISTRY.keys()].sort(); }
export function objectDefaults(name: string): Record<string, unknown> { return { ...(REGISTRY.get(name)?.defaults ?? {}) }; }
export function objectCategory(name: string): ObjCategory | undefined { return REGISTRY.get(name)?.category; }
export function objectCatalog(): ObjEntry[] {
  return [...REGISTRY.entries()].map(([name, t]) => ({ name, category: t.category, defaults: { ...t.defaults } }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** materials structures reference internally (not exposed as a `mat` param) —
 *  seeded so their textures are always loaded even if no object names them. */
const STRUCTURE_MATERIALS = ["metal", "stone", "crate", "wall"];

/** per-model calibration metas, keyed by folder name (for resolving the materials a
 *  placed model's slots reference — those textures must load too). */
const MODEL_META = new Map<string, ModelMeta>(catalog.models.map((m) => [m.name, m.meta ?? {}]));

/** every material a map references: each object's `mat` (merged over defaults), the
 *  materials each placed model's slots use, the ones structures use internally, and
 *  the default. */
export function mapMaterials(def: MapDef): string[] {
  const set = new Set<string>([DEFAULT_MATERIAL, ...STRUCTURE_MATERIALS]);
  for (const o of def.objects) {
    const t = REGISTRY.get(o.type);
    if (!t) continue;
    const merged = { ...t.defaults, ...(o.params ?? {}) } as Record<string, unknown>;
    if (typeof merged.mat === "string" && merged.mat) set.add(merged.mat);
    // a placed model shades its surfaces through its own materials → load them too
    if (typeof merged.model === "string" && merged.model) {
      for (const m of modelMaterials(MODEL_META.get(merged.model))) set.add(m);
    }
  }
  return [...set];
}

/** every texture folder the renderer must load for a map: the textures its
 *  referenced materials consume, plus particle-sprite `tex` folders (particles
 *  consume a raw sprite texture, not a surface material). `matDefs` may be the
 *  editor's live material defs so a just-assigned texture loads before rebuild. */
export function mapTextureFolders(def: MapDef, matDefs?: Map<string, MaterialDef>): string[] {
  const set = new Set<string>(materialTextureFolders(mapMaterials(def), matDefs));
  for (const o of def.objects) {
    const t = REGISTRY.get(o.type);
    if (!t) continue;
    const merged = { ...t.defaults, ...(o.params ?? {}) } as Record<string, unknown>;
    if (typeof merged.tex === "string" && merged.tex) set.add(merged.tex); // particle sprite
  }
  return [...set];
}

// ─── geometry ─────────────────────────────────────────────────────────────────

/** cuboid shaded by a material — the structural workhorse. scale IS its w/h/d
 *  (scale gizmo resizes it). `mat` is a material name (drop one on the inspector
 *  slot); `tile` scales its UVs. Shading is fully decoupled from geometry: a glass
 *  material makes the box a window, a water material makes it a rippling liquid
 *  surface (drop it thin + wide for a pool). solid=false → decoration you pass
 *  through (water pools and window panes are usually solid=false). */
defineObject<{ mat: string; tile: [number, number]; solid: boolean }>("box", {
  defaults: { mat: DEFAULT_MATERIAL, tile: [1, 1], solid: true },
  category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at; const [w, h, d] = t.scale;
    const e = b.mesh(x, y, z, w, h, d, p.mat, p.tile[0], p.tile[1]);
    const [rx, ry, rz] = t.rot;
    if (rx || ry || rz) e.transform.setRotation(rx, ry, rz);   // visual only (collision stays AABB)
    if (p.solid !== false) b.pushSolid({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  },
});

// ─── markers (built after geometry so floor heights resolve) ──────────────────

defineObject<object>("spawn", {
  defaults: {}, category: "marker", deferred: true,
  build(b, t) { const [x, , z] = t.at; b.map.spawns.push({ p: { x, y: b.map.floorY(x, z) + 0.05, z }, yaw: t.rot[1] }); },
});
defineObject<object>("pickup", {
  defaults: {}, category: "marker", deferred: true,
  build(b, t) { const [x, y, z] = t.at; b.map.pickupSpots.push({ x, y, z }); },
});
defineObject<object>("powerup", {
  defaults: {}, category: "marker", deferred: true,
  build(b, t) { const [x, y, z] = t.at; b.map.powerupSpots.push({ x, y, z }); },
});

// ─── sound (positional looping audio; volume falls off with distance) ─────────

defineObject<{ clip: string; radius: number; volume: number; loop: boolean; spatial: boolean }>("sound", {
  defaults: { clip: "", radius: 12, volume: 1, loop: true, spatial: true },
  category: "sound",
  build(b, t, p) {
    const a = catalog.audio.find((c) => c.name === p.clip);
    if (!a) { if (p.clip) console.warn("[sound] clip not found:", p.clip); return; }
    const spatial = p.spatial !== false;
    // re-adopt a still-playing element for the same clip (an editor rebuild) so the
    // track keeps its position instead of restarting; otherwise start a fresh one.
    const reused = b.map.claimSound(p.clip);
    const el = reused ?? new Audio(assetUrl(a.file));
    el.loop = p.loop;
    // non-spatial (2D) sources play at their full volume everywhere — ambience,
    // music beds; spatial ones start silent and are faded in by distance each tick.
    if (!reused) el.volume = spatial ? 0 : Math.min(1, p.volume);
    el.play().catch(() => { /* awaits user-gesture audio unlock */ });
    b.map.sounds.push({ clip: p.clip, pos: { x: t.at[0], y: t.at[1], z: t.at[2] }, el, radius: p.radius, volume: p.volume, spatial });
  },
});

// ─── generic model prop — the drag-a-model target ─────────────────────────────
// Places ANY model by folder name with a full transform; collision is derived
// from the model's actual mesh bounds. Dropping a model in the editor creates
// one of these with { model } set. Flip `physics` on to make it a movable rigid
// body (mass in kg): light props (a crate, a can) get shoved when you shoot, blast
// or walk into them; heavy ones barely budge. Physics props are dynamic, so they
// don't contribute static collision — the PhysicsWorld drives them at runtime.
defineObject<{ model: string; solid: boolean; physics: boolean; mass: number }>("prop", {
  defaults: { model: "", solid: true, physics: false, mass: 5 },
  category: "prop",
  build(b, t, p) {
    if (!p.model) return;
    const e = b.placeModelTf(p.model, t.at, t.rot, t.scale);
    if (!e) return;
    if (p.physics) { b.pushDynamicBody(p.model, e, t.at, t.rot, t.scale, p.mass); return; }
    if (p.solid) b.pushModelSolids(p.model, e, t.at, t.rot, t.scale);
  },
});

// ─── particle emitter (fire / smoke / dust / sparks) ──────────────────────────
// A tunable emitter (see particles.ts). `tex` picks a texture folder's colour map
// as the particle sprite; leave it empty for a soft procedural puff. The cone
// aims up the object's local +Y, so the regular Rotate tool sets the direction.
// `fire` and `smoke` below are the same emitter with preset params (see
// definePreset) — object wrapping, no duplicated build logic.
defineObject<ParticleLook & { tex: string }>("particles", {
  defaults: { tex: "", ...PARTICLE_LOOK }, category: "entity",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const sprite = p.tex ? b.texOf(p.tex).color : null;
    // pooled by placement index so an editor rebuild (every edit/move) re-adopts the
    // same emitter and keeps its particles flowing instead of restarting from empty.
    const e = b.buildParticleEmitter(`particles:${b.buildIndex}`, x, y, z, p, sprite);
    const [rx, ry, rz] = t.rot;
    e.transform.setRotation(rx, ry, rz);   // always set so a reused emitter re-orients
    b.track(e);
  },
});

// `tex` points each preset at its realistic sprite folder (public/assets/textures/
// {fire,smoke}/) — a flame teardrop and a billowy smoke puff. Drop a different
// sheet into that folder to restyle every fire/smoke in the game.
definePreset<ParticleLook & { tex: string }>("fire", "particles", {
  tex: "fire",
  rate: 46, lifetime: 1.1, speed: 1.6, size: 0.7, growth: 0.25, spread: 16,
  gravity: -0.35, color: [1.0, 0.55, 0.14], opacity: 0.9, additive: true, world: true,
}, "entity");

definePreset<ParticleLook & { tex: string }>("smoke", "particles", {
  tex: "smoke",
  rate: 14, lifetime: 3.2, speed: 0.8, size: 0.8, growth: 2.6, spread: 22,
  gravity: -0.1, color: [0.28, 0.28, 0.3], opacity: 0.45, additive: false, world: true,
}, "entity");

// ─── gameplay entities ────────────────────────────────────────────────────────

/** generic explodable prop — any `model` that takes damage and explodes at 0 hp
 *  (host-tracked, reusing the barrel gameplay path). Drop one and point `model` at
 *  a barrel, crate, gas tank… to make it shootable+explosive. `radius`/`height`
 *  size its collision + blast cylinder. (An explosive barrel is just this with the
 *  barrel model dropped in — there is no bespoke `barrel` preset.) */
defineObject<{ model: string; hp: number; scale?: number; radius: number; height: number }>("explodable", {
  defaults: { model: "", hp: BARREL_HP, radius: 0.45, height: 1.1 },
  category: "entity",
  build(b, t, p) {
    if (!p.model) return;
    const [x, y, z] = t.at;
    const m = p.scale ?? 1;   // legacy multiplier; drop scale carries the native size
    const e = b.placeModelTf(p.model, [x, y, z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]);
    // collision stays authored radius/height (explodables aren't resized by scale)
    const solid: AABB = { min: { x: x - p.radius, y, z: z - p.radius }, max: { x: x + p.radius, y: y + p.height, z: z + p.radius } };
    b.pushSolid(solid);
    b.map.barrels.push({ pos: { x, y: y + p.height / 2, z }, entity: e, solid, hp: p.hp, dead: false });
  },
});

// ─── standalone light sources (point / directional / spot) ────────────────────
// Pure lights, no model — the Unity-style building block. Group one with any prop
// (a lantern model, a neon sign, a torch) in the editor to make it glow, instead
// of baking a light into a bespoke model object. Colour is an rgb triple so the
// inspector shows a colour picker; `intensity` is a brightness multiplier. Editor
// rebuilds run the same build(), so the light lights the viewport live as you tune
// it. See lights.ts for the controls each type exposes.
defineObject<PointLightLook>("pointlight", {
  defaults: { ...POINT_LIGHT }, category: "light",
  build(b, t, p) { b.track(buildPointLight(b.root, t.at, p)); },
});
defineObject<DirLightLook>("dirlight", {
  defaults: { ...DIR_LIGHT }, category: "light",
  build(b, t, p) { b.track(buildDirLight(b.root, t.at, t.rot, p)); },
});
defineObject<SpotLightLook>("spotlight", {
  defaults: { ...SPOT_LIGHT }, category: "light",
  build(b, t, p) { b.track(buildSpotLight(b.root, t.at, t.rot, p)); },
});

// NOTE: the old bespoke decoration/structure object types (lantern, planter, veg,
// pallet, sandbags, stall, column, window, awning) were removed — each was just a
// bundle of `prop`/`box`/`pointlight` placements, so they're authored directly from
// those primitives now (existing maps were migrated to the equivalent placements).
