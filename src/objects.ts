// ─── Object registry: named, parameterised, placeable map objects ────────────
// Each object type declares its DEFAULT params and a build() that turns a
// placement into geometry/collision/behaviour. A map places one by name and may
// override any param — e.g. an explosive barrel is 120 hp by default, but a map
// can drop one in with { params: { hp: 50 } }. New props/behaviours = one
// defineObject() call; the loader and every map get it for free.
import { Color, PointLight } from "@galacean/engine";
import type { MapBuilder } from "./mapbuilder";
import { AABB } from "./map";

export const BARREL_HP = 120;

export interface ObjectType<P extends object> {
  /** default params — a placement's `params` are shallow-merged over these */
  defaults: P;
  /** construct the object at a position/rotation with resolved params */
  build(b: MapBuilder, at: readonly [number, number, number], rotY: number, p: P): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, ObjectType<any>>();

export function defineObject<P extends object>(name: string, type: ObjectType<P>): void {
  REGISTRY.set(name, type);
}

/** build a placed object by name, merging overrides over its defaults. */
export function buildObject(b: MapBuilder, name: string, at: readonly [number, number, number], rot: number | undefined, params: Record<string, unknown> | undefined): void {
  const t = REGISTRY.get(name);
  if (!t) { console.warn("[map] unknown object type:", name); return; }
  const p = { ...t.defaults, ...(params ?? {}) };
  t.build(b, at, rot ?? 0, p);
}

// ─── built-in object types ────────────────────────────────────────────────────

/** explosive barrel — the interactive example: host tracks hp, explodes at 0 */
defineObject<{ hp: number; scale: number; radius: number; height: number }>("barrel", {
  defaults: { hp: BARREL_HP, scale: 1.15, radius: 0.45, height: 1.1 },
  build(b, at, rot, p) {
    const [x, , z] = at;
    const e = b.placeModel("barrel", x, 0, z, p.scale, rot);
    const solid: AABB = { min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } };
    b.pushSolid(solid);
    b.map.barrels.push({ pos: { x, y: p.height / 2, z }, entity: e, solid, hp: p.hp, dead: false });
  },
});

/** hanging/standing lantern that also casts a warm point light */
defineObject<{ color: number; distance: number; scale: number }>("lantern", {
  defaults: { color: 0xe69e52, distance: 8, scale: 1.0 },
  build(b, at, rot, p) {
    const [x, y, z] = at;
    const e = b.placeModel("lantern", x, y, z, p.scale, rot) ?? b.root.createChild("lamp");
    e.transform.setPosition(x, y, z);
    const l = e.addComponent(PointLight);
    l.color = new Color(((p.color >> 16) & 255) / 255, ((p.color >> 8) & 255) / 255, (p.color & 255) / 255, 1);
    l.distance = p.distance;
  },
});

/** planter box with a plant on top + collision */
defineObject<{ scale: number; top: number; radius: number; plant: "succulent" | "shrub" }>("planter", {
  defaults: { scale: 1.0, top: 0.5, radius: 0.8, plant: "succulent" },
  build(b, at, _rot, p) {
    const [x, , z] = at;
    b.placeModel("planter", x, 0, z, p.scale);
    b.placeModel(p.plant, x, p.top, z, 1.0, Math.random() * 360);
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: 0.7, z: z + p.radius } });
  },
});

/** ground vegetation (visual only) — rests on the floor, random yaw if unset */
function vegType(model: "succulent" | "shrub"): ObjectType<{ scale: number }> {
  return {
    defaults: { scale: 1.0 },
    build(b, at, rot, p) {
      const [x, , z] = at;
      b.placeModel(model, x, b.map.floorY(x, z), z, p.scale, rot || Math.random() * 360);
    },
  };
}
defineObject("shrub", vegType("shrub"));
defineObject("succulent", vegType("succulent"));

// ─── modeled props (glTF) with footprint collision ──────────────────────────
// A prop places a loaded model and derives an axis-aligned solid from the model's
// native bounding box × scale. `nw/nh/nd` are the native metres (see models.ts).
// solid=false → decoration only (vegetation the player walks through).
function modelProp(
  model: "crate" | "crate2" | "rockset" | "boulder" | "fern" | "stump" | "dtree" | "deadtree" | "toolbox" | "desk" | "chair" | "pplant" | "cabinet" | "treebig" | "treemed" | "cliff" | "rockset2" | "tropplant" | "leafplant" | "sofa" | "bookshelf" | "trashcan" | "extinguisher" | "cofftable" | "cardbox" | "pplant2" | "clock",
  nw: number, nh: number, nd: number, defScale: number, solid = true,
): ObjectType<{ scale: number; randomYaw: boolean }> {
  return {
    defaults: { scale: defScale, randomYaw: false },
    build(b, at, rot, p) {
      const [x, baseY, z] = at;
      const yaw = rot || (p.randomYaw ? Math.random() * 360 : 0);
      const e = b.placeModel(model, x, baseY, z, p.scale, yaw);
      if (!solid) return;
      // footprint from native bbox; when rotated ~90° swap w/d so collision follows
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

/** wooden supply crate (modeled) — waist-high cover, no longer an ugly box */
defineObject("crate", modelProp("crate", 0.93, 0.36, 0.68, 1.8));
/** stackable plastic bin — cyber/industrial clutter */
defineObject("crate2", modelProp("crate2", 0.30, 0.26, 0.41, 2.6));
/** cluster of mossy rocks — jungle cover */
defineObject("rockset", modelProp("rockset", 2.66, 1.77, 3.37, 0.7));
/** single large boulder */
defineObject("boulder", modelProp("boulder", 2.52, 1.9, 2.5, 0.75));
/** ground fern — decoration only */
defineObject("fern", modelProp("fern", 0.99, 0.43, 0.89, 1.3, false));
/** tree stump — low cover / step */
defineObject("stump", modelProp("stump", 1.43, 0.57, 1.59, 1.0));
/** desert quiver tree — tall thin silhouette (collision only around trunk) */
defineObject("dtree", modelProp("dtree", 0.5, 2.72, 0.5, 1.1));
/** fallen dead log — long low cover; rotate to lay across a lane */
defineObject("deadtree", modelProp("deadtree", 3.05, 0.32, 0.32, 1.0));
/** small metal toolbox — floor clutter */
defineObject("toolbox", modelProp("toolbox", 0.40, 0.17, 0.32, 1.6));
/** office desk */
defineObject("desk", modelProp("desk", 2.0, 0.79, 0.95, 1.0));
/** chair — decoration (walk-through, tiny) */
defineObject("chair", modelProp("chair", 0.57, 1.0, 0.68, 1.0, false));
/** tall potted plant */
defineObject("pplant", modelProp("pplant", 0.59, 1.34, 0.63, 1.0));
/** filing cabinet — tall cover */
defineObject("cabinet", modelProp("cabinet", 1.14, 1.88, 0.49, 1.0));
/** reception/lounge sofa — waist-high cover */
defineObject("sofa", modelProp("sofa", 1.57, 0.80, 0.66, 1.0));
/** tall bookshelf — full-height cover, good wall filler */
defineObject("bookshelf", modelProp("bookshelf", 1.37, 2.06, 0.58, 1.0));
/** office bin — small floor clutter */
defineObject("trashcan", modelProp("trashcan", 0.61, 0.98, 0.56, 0.75));
/** wall fire extinguisher — detail only (walk-through) */
defineObject("extinguisher", modelProp("extinguisher", 0.28, 0.66, 0.37, 1.0, false));
/** lounge coffee table — low cover (long axis = z) */
defineObject("cofftable", modelProp("cofftable", 0.60, 0.39, 1.20, 1.0));
/** cardboard storage box — stackable low cover */
defineObject("cardbox", modelProp("cardbox", 0.39, 0.34, 0.52, 1.4));
/** bushy potted plant (variant) */
defineObject("pplant2", modelProp("pplant2", 0.73, 0.63, 0.76, 1.2));
/** wall clock — decoration only */
defineObject("clock", modelProp("clock", 0.32, 0.32, 0.05, 1.4, false));
/** large canopy tree — thin trunk collision only */
defineObject("tree", modelProp("treebig", 0.8, 5.0, 0.8, 1.0));
/** medium tree — thin trunk collision only */
defineObject("tree2", modelProp("treemed", 0.7, 3.4, 0.7, 1.0));
/** huge cliff face — pure scenery backdrop (no collision; place outside arena walls) */
defineObject("cliff", modelProp("cliff", 86.8, 11, 24.3, 0.5, false));
/** mossy rock cluster (variant) */
defineObject("rockset2", modelProp("rockset2", 2.49, 1.71, 2.02, 0.85));
/** tropical tree-plant */
defineObject("tropplant", modelProp("tropplant", 0.6, 1.9, 0.6, 1.0));
/** broad tropical leaves — decoration only */
defineObject("leafplant", modelProp("leafplant", 0.6, 0.42, 0.56, 1.6, false));

/** low wooden pallet (visual+solid, short) */
defineObject<object>("pallet", {
  defaults: {},
  build(b, at) {
    const [x, , z] = at;
    b.box(x, 0.08, z, 1.3, 0.16, 1.1, b.tex.crate, 0.8, 0.7);
  },
});

/** stack of sandbags; rot 1 = rotate footprint 90° */
defineObject<{ rot: 0 | 1 }>("sandbags", {
  defaults: { rot: 0 },
  build(b, at, _rot, p) {
    const [x, , z] = at;
    const w = p.rot ? 0.65 : 1.5, d = p.rot ? 1.5 : 0.65;
    b.box(x, 0.28, z, w, 0.56, d, b.tex.wall, 0.6, 0.3);
    b.box(x + (p.rot ? 0 : 0.1), 0.72, z + (p.rot ? 0.1 : 0), w * 0.8, 0.34, d * 0.8, b.tex.wall, 0.5, 0.2);
  },
});

/** market stall: counter + 4 poles + a jumpable canopy */
defineObject<object>("stall", {
  defaults: {},
  build(b, at) {
    const [x, , z] = at;
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
  defaults: { height: 2.9, radius: 0.32 },
  build(b, at, _rot, p) {
    const [x, , z] = at;
    b.cylinder(x, 1.45, z, p.radius, p.radius, p.height, b.tex.stone, 0.6, 1.4, 10);
    b.box(x, 3.05, z, 0.85, 0.3, 0.85, b.tex.stone, 0.3, 0.15); // capital
    b.box(x, 0.15, z, 0.85, 0.3, 0.85, b.tex.stone, 0.3, 0.15); // base
    b.pushSolid({ min: { x: x - p.radius, y: 0, z: z - p.radius }, max: { x: x + p.radius, y: p.height, z: z + p.radius } });
  },
});

/** window opening in an x-facing wall: sill + header fills around a 1.6-wide hole */
defineObject<{ ledge: boolean }>("window", {
  defaults: { ledge: true },
  build(b, at, _rot, p) {
    const [x, , z] = at;
    b.box(x, 0.55, z, 0.9, 1.1, 1.6, b.tex.wall, 0.5, 0.4);   // sill fill
    b.box(x, 2.85, z, 0.9, 1.1, 1.6, b.tex.wall, 0.5, 0.4);   // header fill
    if (p.ledge) b.box(x, 1.12, z, 1.1, 0.14, 1.9, b.tex.stone, 0.6, 0.08); // sill ledge
  },
});

/** metal awning slab jutting from a wall (visual+solid) */
defineObject<{ w: number; d: number }>("awning", {
  defaults: { w: 2.6, d: 1.3 },
  build(b, at, _rot, p) {
    const [x, y, z] = at;
    b.box(x, y + 0.06, z, p.d, 0.12, p.w, b.tex.metal, 0.6, 1);
  },
});
