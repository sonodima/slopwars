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
import { buildWater, WATER_LOOK, type WaterLook } from "./water";
import { buildGlass, GLASS_LOOK, type GlassLook } from "./glass";
import { buildParticles, PARTICLE_LOOK, type ParticleLook } from "./particles";
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

/** every texture folder a map references (via any object's `tex`, merged over
 *  defaults) plus the folders structures use internally — what the renderer must
 *  load before building. */
export function mapTextureFolders(def: MapDef): string[] {
  const set = new Set<string>(["metal", "stone", "crate"]); // used inside structures
  for (const o of def.objects) {
    const t = REGISTRY.get(o.type);
    if (!t) continue;
    const merged = { ...t.defaults, ...(o.params ?? {}) } as Record<string, unknown>;
    if (typeof merged.tex === "string" && merged.tex) set.add(merged.tex);
  }
  return [...set];
}

// ─── geometry ─────────────────────────────────────────────────────────────────

/** textured (or plain-colour) cuboid — the structural workhorse. scale IS its
 *  w/h/d (scale gizmo resizes it). `tex` is a texture folder name; leave it empty
 *  to render an untextured solid `color` (gray by default — a plain cube you can
 *  give any texture, exactly like a prop). solid=false → decoration. */
defineObject<{ tex: string; color: [number, number, number]; tile: [number, number]; solid: boolean }>("box", {
  defaults: { tex: "", color: [0.6, 0.6, 0.62], tile: [1, 1], solid: true },
  category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at; const [w, h, d] = t.scale;
    const e = p.tex
      ? b.mesh(x, y, z, w, h, d, b.texOf(p.tex), p.tile[0], p.tile[1])
      : b.meshColor(x, y, z, w, h, d, p.color[0], p.color[1], p.color[2]);
    const [rx, ry, rz] = t.rot;
    if (rx || ry || rz) e.transform.setRotation(rx, ry, rz);   // visual only (collision stays AABB)
    if (p.solid !== false) b.pushSolid({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  },
});

/** flat animated water surface (visual only); scale.x = size. Every look control
 *  is a param, so each pool/river is tuned independently (see water.ts). The
 *  surface builds itself here rather than through a MapBuilder helper — water is
 *  a single object type, not a shared primitive like a box, so its construction
 *  lives with the object instead of bloating the builder's primitive vocabulary. */
defineObject<WaterLook>("water", {
  defaults: { ...WATER_LOOK }, category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const e = buildWater(b.engine, b.root, x, y, z, t.scale[0], p);
    b.map.tris += 12;
    b.track(e);
  },
});

/** refractive glass box (windows, panels) — scale IS its w/h/d, like a box. Solid
 *  by default so you can't walk through a window; set solid=false for décor. */
defineObject<GlassLook & { solid: boolean }>("glass", {
  defaults: { ...GLASS_LOOK, solid: true }, category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at; const [w, h, d] = t.scale;
    const e = buildGlass(b.engine, b.root, x, y, z, w, h, d, p);
    const [rx, ry, rz] = t.rot;
    if (rx || ry || rz) e.transform.setRotation(rx, ry, rz);   // visual only (collision stays AABB)
    b.map.tris += 12;
    b.track(e);
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

definePreset<ParticleLook & { tex: string }>("fire", "particles", {
  rate: 46, lifetime: 1.1, speed: 1.6, size: 0.7, growth: 0.25, spread: 16,
  gravity: -0.35, color: [1.0, 0.55, 0.14], opacity: 0.9, additive: true, world: true,
}, "entity");

definePreset<ParticleLook & { tex: string }>("smoke", "particles", {
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
    const [x, , z] = t.at;
    const m = p.scale ?? 1;   // legacy multiplier; drop scale is 1.15 (transform)
    const e = b.placeModelTf("Barrel_01", [x, 0, z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]);
    // collision stays authored radius/height (as before) — barrels aren't resized
    const solid: AABB = { min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } };
    b.pushSolid(solid);
    b.map.barrels.push({ pos: { x, y: p.height / 2, z }, entity: e, solid, hp: p.hp, dead: false });
  },
});

/** hanging/standing lantern that also casts a warm point light */
defineObject<{ color: number; distance: number; scale?: number }>("lantern", {
  defaults: { color: 0xe69e52, distance: 8 },
  category: "light",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const m = p.scale ?? 1;
    const e = b.placeModelTf("Lantern_01", [x, y, z], [0, t.rot[1], 0], [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m]) ?? b.root.createChild("lamp");
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
    const [x, , z] = t.at;
    const m = p.scale ?? 1;
    const sv: [number, number, number] = [t.scale[0] * m, t.scale[1] * m, t.scale[2] * m];
    b.placeModelTf("planter_box_01", [x, 0, z], [0, 0, 0], sv);
    b.placeModelTf(p.plant, [x, p.top, z], [0, t.rot[1], 0], [t.scale[0], t.scale[1], t.scale[2]]);
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: 0.7, z: z + p.radius } });
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
defineObject<{ tex: string }>("pallet", {
  defaults: { tex: "crate" }, category: "structure",
  build(b, t, p) { const [x, , z] = t.at; b.box(x, 0.08, z, 1.3, 0.16, 1.1, b.texOf(p.tex), 0.8, 0.7); },
});

/** stack of sandbags; rot 1 = rotate footprint 90° */
defineObject<{ rot: 0 | 1; tex: string }>("sandbags", {
  defaults: { rot: 0, tex: "wall" }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    const w = p.rot ? 0.65 : 1.5, d = p.rot ? 1.5 : 0.65;
    b.box(x, 0.28, z, w, 0.56, d, b.texOf(p.tex), 0.6, 0.3);
    b.box(x + (p.rot ? 0 : 0.1), 0.72, z + (p.rot ? 0.1 : 0), w * 0.8, 0.34, d * 0.8, b.texOf(p.tex), 0.5, 0.2);
  },
});

/** market stall: counter + 4 poles + a jumpable canopy */
defineObject<{ tex: string }>("stall", {
  defaults: { tex: "crate" }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.box(x, 0.5, z, 2.6, 1.0, 1.1, b.texOf(p.tex), 1.4, 0.6);
    for (const [dx, dz] of [[-1.2, -0.9], [1.2, -0.9], [-1.2, 0.9], [1.2, 0.9]]) {
      b.box(x + dx, 1.2, z + dz, 0.14, 2.4, 0.14, b.texOf(p.tex), 0.1, 1.4);
    }
    b.box(x, 2.45, z, 3.1, 0.14, 2.4, b.texOf("metal"), 1.4, 1);
    b.box(x - 0.5, 0.08, z + 1.7, 1.3, 0.16, 1.1, b.texOf(p.tex), 0.8, 0.7); // pallet beside
  },
});

/** stone column with capital + base (cylinder shaft) */
defineObject<{ height: number; radius: number; tex: string }>("column", {
  defaults: { height: 2.9, radius: 0.32, tex: "stone" }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.cylinder(x, 1.45, z, p.radius, p.radius, p.height, b.texOf(p.tex), 0.6, 1.4, 10);
    b.box(x, 3.05, z, 0.85, 0.3, 0.85, b.texOf(p.tex), 0.3, 0.15); // capital
    b.box(x, 0.15, z, 0.85, 0.3, 0.85, b.texOf(p.tex), 0.3, 0.15); // base
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } });
  },
});

/** window opening in an x-facing wall: sill + header fills around a 1.6-wide hole */
defineObject<{ ledge: boolean; tex: string }>("window", {
  defaults: { ledge: true, tex: "wall" }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.box(x, 0.55, z, 0.9, 1.1, 1.6, b.texOf(p.tex), 0.5, 0.4);   // sill fill
    b.box(x, 2.85, z, 0.9, 1.1, 1.6, b.texOf(p.tex), 0.5, 0.4);   // header fill
    if (p.ledge) b.box(x, 1.12, z, 1.1, 0.14, 1.9, b.texOf("stone"), 0.6, 0.08); // sill ledge
  },
});

/** metal awning slab jutting from a wall (visual+solid) */
defineObject<{ w: number; d: number; tex: string }>("awning", {
  defaults: { w: 2.6, d: 1.3, tex: "metal" }, category: "structure",
  build(b, t, p) { const [x, y, z] = t.at; b.box(x, y + 0.06, z, p.d, 0.12, p.w, b.texOf(p.tex), 0.6, 1); },
});
