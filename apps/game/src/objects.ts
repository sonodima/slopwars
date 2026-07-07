// ─── Object registry: every placeable thing in a map is a registered object ───
// Following modern game-engine convention, a map is just a list of object
// placements — geometry (box/water), props, spawns, pickups, power-ups,
// sounds and lights are ALL object types. Each type declares DEFAULT params, an
// editor `category`, and a build() that turns a transform (position/rotation/
// scale) + params into geometry/collision/behaviour. New behaviours = one
// defineObject() call; the loader and the editor pick them up for free.
import { Color, PointLight } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import type { MapBuilder } from "./mapbuilder";
import { AABB } from "./map";
import { assetUrl } from "./assets";
import { buildWater } from "./water";
import { DEFAULT_MATERIAL, materialTextureFolders } from "./materials";
import { buildParticles, PARTICLE_LOOK, type ParticleLook } from "./particles";
import {
  buildPointLight, buildDirLight, buildSpotLight, POINT_LIGHT, DIR_LIGHT, SPOT_LIGHT,
  type PointLightLook, type DirLightLook, type SpotLightLook,
} from "./lights";
import type { MapDef, Placement } from "./maps/schema";

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

/** every material a map references: each object's `mat` (merged over defaults)
 *  plus the ones structures use internally, and the default. */
export function mapMaterials(def: MapDef): string[] {
  const set = new Set<string>([DEFAULT_MATERIAL, ...STRUCTURE_MATERIALS]);
  for (const o of def.objects) {
    const t = REGISTRY.get(o.type);
    if (!t) continue;
    const merged = { ...t.defaults, ...(o.params ?? {}) } as Record<string, unknown>;
    if (typeof merged.mat === "string" && merged.mat) set.add(merged.mat);
  }
  return [...set];
}

/** every texture folder the renderer must load for a map: the textures its
 *  referenced materials consume, plus particle-sprite `tex` folders (particles
 *  consume a raw sprite texture, not a surface material). */
export function mapTextureFolders(def: MapDef): string[] {
  const set = new Set<string>(materialTextureFolders(mapMaterials(def)));
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
 *  slot); `tile` scales its UVs. A transmissive material (glass) makes it a window
 *  — geometry and shading are decoupled. solid=false → decoration. */
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

/** glass = a box carrying a glass material (a preset, not a bespoke type): the
 *  material owns the refraction, the box owns the geometry. Drop it thin for a
 *  window pane; give it any glass-type material for tinted/frosted variants. */
definePreset<{ mat: string; tile: [number, number]; solid: boolean }>("glass", "box", { mat: "glass" });

/** flat animated water surface (visual only); scale.x = size. `mat` names a
 *  `water`-type material (its WaterLook drives the look). Water is a surface
 *  *system* — a plane + a flow script — so it stays its own object rather than a
 *  material you paint on arbitrary geometry (see water.ts / materials.ts). */
defineObject<{ mat: string }>("water", {
  defaults: { mat: "water" }, category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const e = buildWater(b.engine, b.root, x, y, z, t.scale[0], b.lib.waterLook(p.mat));
    b.map.tris += 12;
    b.track(e);
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
    const el = new Audio(assetUrl(a.file));
    el.loop = p.loop;
    const spatial = p.spatial !== false;
    // non-spatial (2D) sources play at their full volume everywhere — ambience,
    // music beds; spatial ones start silent and are faded in by distance each tick.
    el.volume = spatial ? 0 : Math.min(1, p.volume);
    el.play().catch(() => { /* awaits user-gesture audio unlock */ });
    b.map.sounds.push({ pos: { x: t.at[0], y: t.at[1], z: t.at[2] }, el, radius: p.radius, volume: p.volume, spatial });
  },
});

// ─── generic model prop — the drag-a-model target ─────────────────────────────
// Places ANY model by folder name with a full transform; collision is derived
// from the model's actual mesh bounds. Dropping a model in the editor creates
// one of these with { model } set.
defineObject<{ model: string; solid: boolean }>("prop", {
  defaults: { model: "", solid: true },
  category: "prop",
  build(b, t, p) {
    if (!p.model) return;
    const e = b.placeModelTf(p.model, t.at, t.rot, t.scale);
    if (!e) return;
    if (p.solid) { const aabb = b.modelAABB(e); if (aabb) b.pushSolid(aabb); }
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
    const e = buildParticles(b.engine, b.root, x, y, z, p, sprite);
    const [rx, ry, rz] = t.rot;
    if (rx || ry || rz) e.transform.setRotation(rx, ry, rz);
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

/** explosive barrel — host tracks hp, explodes at 0 */
DROP_SCALE.set("barrel", 1.15);
defineObject<{ hp: number; scale?: number; radius: number; height: number }>("barrel", {
  defaults: { hp: BARREL_HP, radius: 0.45, height: 1.1 },
  category: "entity",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const m = p.scale ?? 1;   // legacy multiplier; drop scale is 1.15 (transform)
    const e = b.placeModelTf("Barrel_01", [x, y, z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]);
    // collision stays authored radius/height (as before) — barrels aren't resized
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

/** hanging/standing lantern that also casts a warm point light. Kept for existing
 *  maps and one-drop convenience — the modern way is a plain lantern `prop` grouped
 *  with a `pointlight`, but this bundles both for a quick warm glow. */
defineObject<{ color: number; distance: number; scale?: number }>("lantern", {
  defaults: { color: 0xe69e52, distance: 8 },
  category: "light",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const m = p.scale ?? 1;
    // placeModelTf already tracks the model entity for editor picking; only the
    // (rare) fallback lamp — created when the model fails to load — needs tracking.
    const model = b.placeModelTf("Lantern_01", [x, y, z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]);
    const e = model ?? b.track(b.root.createChild("lamp"));
    e.transform.setPosition(x, y, z);
    const l = e.addComponent(PointLight);
    l.color = new Color(((p.color >> 16) & 255) / 255, ((p.color >> 8) & 255) / 255, (p.color & 255) / 255, 1);
    l.distance = p.distance;
  },
});

/** planter box with a plant on top + collision */
defineObject<{ scale?: number; top: number; radius: number; plant: string }>("planter", {
  defaults: { top: 0.5, radius: 0.8, plant: "cheiridopsis_succulent" },
  category: "prop",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const m = p.scale ?? 1;
    const sv: [number, number, number] = [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m];
    b.placeModelTf("planter_box_01", [x, y, z], [0, 0, 0], sv);
    b.placeModelTf(p.plant, [x, y + p.top, z], [0, t.rot[1], 0], [t.scale[0], t.scale[1], t.scale[2]]);
    b.pushSolid({ min: { x: x - p.radius, y, z: z - p.radius }, max: { x: x + p.radius, y: y + 0.7, z: z + p.radius } });
  },
});

/** ground vegetation (visual only) — rests on the floor. `model` is a model
 *  folder name; shrub/succulent below are just presets over this one type. */
defineObject<{ scale?: number; model: string }>("veg", {
  defaults: { model: "" }, category: "prop",
  build(b, t, p) {
    if (!p.model) return;
    const [x, , z] = t.at;
    const m = p.scale ?? 1;
    b.placeModelTf(p.model, [x, b.map.floorY(x, z), z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]);
  },
});
definePreset<{ scale?: number; model: string }>("shrub", "veg", { model: "didelta_spinosa" });
definePreset<{ scale?: number; model: string }>("succulent", "veg", { model: "cheiridopsis_succulent" });

// ─── code-built structures (no model) ─────────────────────────────────────────

/** low wooden pallet (visual+solid, short) */
defineObject<{ mat: string }>("pallet", {
  defaults: { mat: "crate" }, category: "structure",
  build(b, t, p) { const [x, y, z] = t.at; b.box(x, y + 0.08, z, 1.3, 0.16, 1.1, p.mat, 0.8, 0.7); },
});

/** stack of sandbags; rot 1 = rotate footprint 90° */
defineObject<{ rot: 0 | 1; mat: string }>("sandbags", {
  defaults: { rot: 0, mat: "wall" }, category: "structure",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const w = p.rot ? 0.65 : 1.5, d = p.rot ? 1.5 : 0.65;
    b.box(x, y + 0.28, z, w, 0.56, d, p.mat, 0.6, 0.3);
    b.box(x + (p.rot ? 0 : 0.1), y + 0.72, z + (p.rot ? 0.1 : 0), w * 0.8, 0.34, d * 0.8, p.mat, 0.5, 0.2);
  },
});

/** market stall: counter + 4 poles + a jumpable canopy */
defineObject<{ mat: string }>("stall", {
  defaults: { mat: "crate" }, category: "structure",
  build(b, t, p) {
    const [x, y, z] = t.at;
    b.box(x, y + 0.5, z, 2.6, 1.0, 1.1, p.mat, 1.4, 0.6);
    for (const [dx, dz] of [[-1.2, -0.9], [1.2, -0.9], [-1.2, 0.9], [1.2, 0.9]]) {
      b.box(x + dx, y + 1.2, z + dz, 0.14, 2.4, 0.14, p.mat, 0.1, 1.4);
    }
    b.box(x, y + 2.45, z, 3.1, 0.14, 2.4, "metal", 1.4, 1);
    b.box(x - 0.5, y + 0.08, z + 1.7, 1.3, 0.16, 1.1, p.mat, 0.8, 0.7); // pallet beside
  },
});

/** stone column with capital + base (cylinder shaft) */
defineObject<{ height: number; radius: number; mat: string }>("column", {
  defaults: { height: 2.9, radius: 0.32, mat: "stone" }, category: "structure",
  build(b, t, p) {
    const [x, y, z] = t.at;
    b.cylinder(x, y + 1.45, z, p.radius, p.radius, p.height, p.mat, 0.6, 1.4, 10);
    b.box(x, y + 3.05, z, 0.85, 0.3, 0.85, p.mat, 0.3, 0.15); // capital
    b.box(x, y + 0.15, z, 0.85, 0.3, 0.85, p.mat, 0.3, 0.15); // base
    b.pushSolid({ min: { x: x - p.radius, y, z: z - p.radius }, max: { x: x + p.radius, y: y + p.height, z: z + p.radius } });
  },
});

/** window opening in an x-facing wall: sill + header fills around a 1.6-wide hole */
defineObject<{ ledge: boolean; mat: string }>("window", {
  defaults: { ledge: true, mat: "wall" }, category: "structure",
  build(b, t, p) {
    const [x, y, z] = t.at;
    b.box(x, y + 0.55, z, 0.9, 1.1, 1.6, p.mat, 0.5, 0.4);   // sill fill
    b.box(x, y + 2.85, z, 0.9, 1.1, 1.6, p.mat, 0.5, 0.4);   // header fill
    if (p.ledge) b.box(x, y + 1.12, z, 1.1, 0.14, 1.9, "stone", 0.6, 0.08); // sill ledge
  },
});

/** metal awning slab jutting from a wall (visual+solid) */
defineObject<{ w: number; d: number; mat: string }>("awning", {
  defaults: { w: 2.6, d: 1.3, mat: "metal" }, category: "structure",
  build(b, t, p) { const [x, y, z] = t.at; b.box(x, y + 0.06, z, p.d, 0.12, p.w, p.mat, 0.6, 1); },
});
