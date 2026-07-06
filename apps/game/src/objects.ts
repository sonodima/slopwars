// ─── Object registry: every placeable thing in a map is a registered object ───
// Following modern game-engine convention, a map is just a list of object
// placements — geometry (box/water/stairs), props, spawns, pickups, power-ups,
// sounds and lights are ALL object types. Each type declares DEFAULT params, an
// editor `category`, and a build() that turns a transform (position/rotation/
// scale) + params into geometry/collision/behaviour. New behaviours = one
// defineObject() call; the loader and the editor pick them up for free.
import { Color, PointLight } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import type { MapBuilder } from "./mapbuilder";
import { AABB } from "./map";
import { assetUrl } from "./assets";
import type { MatId, Placement } from "./maps/schema";

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

/** build a placed object, merging overrides over its defaults and resolving the
 *  transform (rot/scale default to identity). */
export function buildObject(b: MapBuilder, o: Placement): void {
  const t = REGISTRY.get(o.type);
  if (!t) { console.warn("[map] unknown object type:", o.type); return; }
  const p = { ...t.defaults, ...(o.params ?? {}) };
  const tf: Transform = { at: o.at, rot: o.rot ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1] };
  t.build(b, tf, p);
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

// ─── geometry ─────────────────────────────────────────────────────────────────

/** textured cuboid — the structural workhorse. scale IS its w/h/d (scale gizmo
 *  resizes it). solid=false → decoration (no collision). */
defineObject<{ mat: MatId; tile: [number, number]; solid: boolean }>("box", {
  defaults: { mat: "wall", tile: [1, 1], solid: true },
  category: "geometry",
  build(b, t, p) {
    const [x, y, z] = t.at; const [w, h, d] = t.scale; const [tu, tv] = p.tile;
    const e = b.mesh(x, y, z, w, h, d, b.tex[p.mat], tu, tv);
    const [rx, ry, rz] = t.rot;
    if (rx || ry || rz) e.transform.setRotation(rx, ry, rz);   // visual only (collision stays AABB)
    if (p.solid !== false) b.pushSolid({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  },
});

/** flat translucent water plane (visual only); scale.x = size */
defineObject<object>("water", {
  defaults: {}, category: "geometry",
  build(b, t) { const [x, y, z] = t.at; b.water(x, y, z, t.scale[0]); },
});

/** rising staircase (params-driven; each step is a solid box) */
defineObject<{ axis: "x+" | "x-" | "z+" | "z-"; rise: number; run: number; width: number; steps: number; mat: MatId }>("stairs", {
  defaults: { axis: "x+", rise: 3, run: 5, width: 2, steps: 8, mat: "dark" },
  category: "geometry",
  build(b, t, p) { b.stairs(t.at, p.axis, p.rise, p.run, p.width, b.tex[p.mat], p.steps); },
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

defineObject<{ clip: string; radius: number; volume: number; loop: boolean }>("sound", {
  defaults: { clip: "", radius: 12, volume: 1, loop: true },
  category: "sound",
  build(b, t, p) {
    const a = catalog.audio.find((c) => c.name === p.clip);
    if (!a) { if (p.clip) console.warn("[sound] clip not found:", p.clip); return; }
    const el = new Audio(assetUrl(a.file));
    el.loop = p.loop; el.volume = 0;
    el.play().catch(() => { /* awaits user-gesture audio unlock */ });
    b.map.sounds.push({ pos: { x: t.at[0], y: t.at[1], z: t.at[2] }, el, radius: p.radius, volume: p.volume });
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

// ─── gameplay entities ────────────────────────────────────────────────────────

/** explosive barrel — host tracks hp, explodes at 0 */
defineObject<{ hp: number; scale: number; radius: number; height: number }>("barrel", {
  defaults: { hp: BARREL_HP, scale: 1.15, radius: 0.45, height: 1.1 },
  category: "entity",
  build(b, t, p) {
    const [x, , z] = t.at;
    const e = b.placeModel("barrel", x, 0, z, p.scale, t.rot[1]);
    const solid: AABB = { min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } };
    b.pushSolid(solid);
    b.map.barrels.push({ pos: { x, y: p.height / 2, z }, entity: e, solid, hp: p.hp, dead: false });
  },
});

/** hanging/standing lantern that also casts a warm point light */
defineObject<{ color: number; distance: number; scale: number }>("lantern", {
  defaults: { color: 0xe69e52, distance: 8, scale: 1.0 },
  category: "light",
  build(b, t, p) {
    const [x, y, z] = t.at;
    const e = b.placeModel("lantern", x, y, z, p.scale, t.rot[1]) ?? b.root.createChild("lamp");
    e.transform.setPosition(x, y, z);
    const l = e.addComponent(PointLight);
    l.color = new Color(((p.color >> 16) & 255) / 255, ((p.color >> 8) & 255) / 255, (p.color & 255) / 255, 1);
    l.distance = p.distance;
  },
});

/** planter box with a plant on top + collision */
defineObject<{ scale: number; top: number; radius: number; plant: "succulent" | "shrub" }>("planter", {
  defaults: { scale: 1.0, top: 0.5, radius: 0.8, plant: "succulent" },
  category: "prop",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.placeModel("planter", x, 0, z, p.scale);
    b.placeModel(p.plant, x, p.top, z, 1.0, Math.random() * 360);
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: 0.7, z: z + p.radius } });
  },
});

/** ground vegetation (visual only) — rests on the floor, random yaw if unset */
function vegType(model: "succulent" | "shrub"): ObjectType<{ scale: number }> {
  return {
    defaults: { scale: 1.0 }, category: "prop",
    build(b, t, p) {
      const [x, , z] = t.at;
      b.placeModel(model, x, b.map.floorY(x, z), z, p.scale, t.rot[1] || Math.random() * 360);
    },
  };
}
defineObject("shrub", vegType("shrub"));
defineObject("succulent", vegType("succulent"));

// ─── modeled props (glTF) with footprint collision ──────────────────────────
// A prop places a loaded model and derives an axis-aligned solid from the model's
// native bounding box × scale. `nw/nh/nd` are the native metres (see models.ts).
// solid=false → decoration only (vegetation the player walks through). These
// tuned types are kept for the existing maps; new placements use "prop".
function modelProp(model: string, nw: number, nh: number, nd: number, defScale: number, solid = true): ObjectType<{ scale: number; randomYaw: boolean }> {
  return {
    defaults: { scale: defScale, randomYaw: false }, category: "prop",
    build(b, t, p) {
      const [x, baseY, z] = t.at;
      const yaw = t.rot[1] || (p.randomYaw ? Math.random() * 360 : 0);
      const e = b.placeModel(model, x, baseY, z, p.scale, yaw);
      if (!solid) return;
      const near90 = Math.abs(((yaw % 180) + 180) % 180 - 90) < 45;
      const hw = (near90 ? nd : nw) * p.scale / 2;
      const hd = (near90 ? nw : nd) * p.scale / 2;
      const h = nh * p.scale;
      const solidAABB: AABB = { min: { x: x - hw, y: baseY, z: z - hd }, max: { x: x + hw, y: baseY + h, z: z + hd } };
      if (e) b.pushSolid(solidAABB);
      else b.box(x, baseY + h / 2, z, hw * 2, h, hd * 2, b.tex.crate, 1, 1); // fallback cube if model missing
    },
  };
}

defineObject("crate", modelProp("crate", 0.93, 0.36, 0.68, 1.8));
defineObject("crate2", modelProp("crate2", 0.30, 0.26, 0.41, 2.6));
defineObject("rockset", modelProp("rockset", 2.66, 1.77, 3.37, 0.7));
defineObject("boulder", modelProp("boulder", 2.52, 1.9, 2.5, 0.75));
defineObject("fern", modelProp("fern", 0.99, 0.43, 0.89, 1.3, false));
defineObject("stump", modelProp("stump", 1.43, 0.57, 1.59, 1.0));
defineObject("dtree", modelProp("dtree", 0.5, 2.72, 0.5, 1.1));
defineObject("deadtree", modelProp("deadtree", 3.05, 0.32, 0.32, 1.0));
defineObject("toolbox", modelProp("toolbox", 0.40, 0.17, 0.32, 1.6));
defineObject("desk", modelProp("desk", 2.0, 0.79, 0.95, 1.0));
defineObject("chair", modelProp("chair", 0.57, 1.0, 0.68, 1.0, false));
defineObject("pplant", modelProp("pplant", 0.59, 1.34, 0.63, 1.0));
defineObject("cabinet", modelProp("cabinet", 1.14, 1.88, 0.49, 1.0));
defineObject("sofa", modelProp("sofa", 1.57, 0.80, 0.66, 1.0));
defineObject("bookshelf", modelProp("bookshelf", 1.37, 2.06, 0.58, 1.0));
defineObject("trashcan", modelProp("trashcan", 0.61, 0.98, 0.56, 0.75));
defineObject("extinguisher", modelProp("extinguisher", 0.28, 0.66, 0.37, 1.0, false));
defineObject("cofftable", modelProp("cofftable", 0.60, 0.39, 1.20, 1.0));
defineObject("cardbox", modelProp("cardbox", 0.39, 0.34, 0.52, 1.4));
defineObject("pplant2", modelProp("pplant2", 0.73, 0.63, 0.76, 1.2));
defineObject("clock", modelProp("clock", 0.32, 0.32, 0.05, 1.4, false));
defineObject("tree", modelProp("treebig", 0.8, 5.0, 0.8, 1.0));
defineObject("tree2", modelProp("treemed", 0.7, 3.4, 0.7, 1.0));
defineObject("cliff", modelProp("cliff", 86.8, 11, 24.3, 0.5, false));
defineObject("rockset2", modelProp("rockset2", 2.49, 1.71, 2.02, 0.85));
defineObject("tropplant", modelProp("tropplant", 0.6, 1.9, 0.6, 1.0));
defineObject("leafplant", modelProp("leafplant", 0.6, 0.42, 0.56, 1.6, false));

// ─── code-built structures (no model) ─────────────────────────────────────────

/** low wooden pallet (visual+solid, short) */
defineObject<object>("pallet", {
  defaults: {}, category: "structure",
  build(b, t) { const [x, , z] = t.at; b.box(x, 0.08, z, 1.3, 0.16, 1.1, b.tex.crate, 0.8, 0.7); },
});

/** stack of sandbags; rot 1 = rotate footprint 90° */
defineObject<{ rot: 0 | 1 }>("sandbags", {
  defaults: { rot: 0 }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    const w = p.rot ? 0.65 : 1.5, d = p.rot ? 1.5 : 0.65;
    b.box(x, 0.28, z, w, 0.56, d, b.tex.wall, 0.6, 0.3);
    b.box(x + (p.rot ? 0 : 0.1), 0.72, z + (p.rot ? 0.1 : 0), w * 0.8, 0.34, d * 0.8, b.tex.wall, 0.5, 0.2);
  },
});

/** market stall: counter + 4 poles + a jumpable canopy */
defineObject<object>("stall", {
  defaults: {}, category: "structure",
  build(b, t) {
    const [x, , z] = t.at;
    b.box(x, 0.5, z, 2.6, 1.0, 1.1, b.tex.crate, 1.4, 0.6);
    for (const [dx, dz] of [[-1.2, -0.9], [1.2, -0.9], [-1.2, 0.9], [1.2, 0.9]]) {
      b.box(x + dx, 1.2, z + dz, 0.14, 2.4, 0.14, b.tex.crate, 0.1, 1.4);
    }
    b.box(x, 2.45, z, 3.1, 0.14, 2.4, b.tex.metal, 1.4, 1);
    b.box(x - 0.5, 0.08, z + 1.7, 1.3, 0.16, 1.1, b.tex.crate, 0.8, 0.7); // pallet beside
  },
});

/** stone column with capital + base (cylinder shaft) */
defineObject<{ height: number; radius: number }>("column", {
  defaults: { height: 2.9, radius: 0.32 }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.cylinder(x, 1.45, z, p.radius, p.radius, p.height, b.tex.stone, 0.6, 1.4, 10);
    b.box(x, 3.05, z, 0.85, 0.3, 0.85, b.tex.stone, 0.3, 0.15); // capital
    b.box(x, 0.15, z, 0.85, 0.3, 0.85, b.tex.stone, 0.3, 0.15); // base
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } });
  },
});

/** window opening in an x-facing wall: sill + header fills around a 1.6-wide hole */
defineObject<{ ledge: boolean }>("window", {
  defaults: { ledge: true }, category: "structure",
  build(b, t, p) {
    const [x, , z] = t.at;
    b.box(x, 0.55, z, 0.9, 1.1, 1.6, b.tex.wall, 0.5, 0.4);   // sill fill
    b.box(x, 2.85, z, 0.9, 1.1, 1.6, b.tex.wall, 0.5, 0.4);   // header fill
    if (p.ledge) b.box(x, 1.12, z, 1.1, 0.14, 1.9, b.tex.stone, 0.6, 0.08); // sill ledge
  },
});

/** metal awning slab jutting from a wall (visual+solid) */
defineObject<{ w: number; d: number }>("awning", {
  defaults: { w: 2.6, d: 1.3 }, category: "structure",
  build(b, t, p) { const [x, y, z] = t.at; b.box(x, y + 0.06, z, p.d, 0.12, p.w, b.tex.metal, 0.6, 1); },
});
