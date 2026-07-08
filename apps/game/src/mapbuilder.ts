// ─── MapBuilder: low-level primitives shared by the loader + object types ─────
// Writes geometry/collision straight into a GameMap, shading every surface through
// the MaterialLibrary (materials.ts) — geometry names a *material*, never a texture.
// Both brush interpretation (loader) and named object types (objects.ts) build
// exclusively through this, so there is one place that knows how to make a wall.
import {
  BoundingBox, Engine, Entity, MeshRenderer, PrimitiveMesh, Quaternion,
} from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import { GameModels, instantiate } from "./models";
import { MapTextures, PbrSet, DEFAULT_FOLDER } from "./textures";
import { MaterialLibrary } from "./materials";
import type { MaterialDef, ModelMeta } from "@slopwars/shared";
import { rotateEuler } from "@slopwars/shared";
import type { AABB, GameMap } from "./map";

/** author-tuned per-model defaults (base offset / scale / material override),
 *  discovered from models/{name}/meta.json by the asset scanner. Applied to every
 *  instantiation so a model is calibrated once, not per placement. */
const MODEL_META = new Map<string, ModelMeta>(catalog.models.map((m) => [m.name, m.meta ?? {}]));

type Vec3T = readonly [number, number, number];

export class MapBuilder {
  /** the shared material factory (built from the map's resolved textures) */
  readonly lib: MaterialLibrary;
  /** index of the placement currently being built (for editor entity tagging) */
  buildIndex = -1;

  /** one shared unit cuboid, reused (scaled per-entity) by every box. A cuboid's
   *  UVs are 0..1 per face regardless of size and tiling lives in the material, so
   *  a scaled unit cube is pixel-identical to a bespoke-sized one — but we build
   *  the geometry once instead of once per box. Big win for the editor, which
   *  rebuilds the whole map on every edit (and every frame of a live drag). */
  private unitCubeMesh: ReturnType<typeof PrimitiveMesh.createCuboid> | null = null;
  private unitCube(): ReturnType<typeof PrimitiveMesh.createCuboid> {
    return (this.unitCubeMesh ??= PrimitiveMesh.createCuboid(this.engine, 1, 1, 1));
  }

  /** per-model calibration used when instantiating; the editor passes its live
   *  (possibly unsaved) metas so a meta edit previews immediately, the game omits it
   *  and the scanned catalog metas apply. */
  private readonly modelMeta: Map<string, ModelMeta>;

  constructor(
    public engine: Engine,
    public root: Entity,
    public tex: MapTextures,
    public models: GameModels,
    public map: GameMap,
    matDefs?: Map<string, MaterialDef>,
    modelMeta?: Map<string, ModelMeta>,
  ) {
    this.lib = new MaterialLibrary(engine, tex, matDefs);
    this.modelMeta = modelMeta ?? MODEL_META;
  }

  pushSolid(a: AABB): void { this.map.solids.push(a); }

  /** raw PBR texture set for a folder (falls back to the default) — for sprite
   *  consumers like the particle emitter that need an image, not a material. */
  texOf(folder?: string): PbrSet {
    return (folder && this.tex.get(folder)) || this.tex.get(DEFAULT_FOLDER) || this.tex.values().next().value!;
  }

  /** report a freshly created entity to the (editor-only) build hook so it can be
   *  associated with the placement it came from — no-op in the game. Public so
   *  object types that build their own entities (water, glass, particles) can
   *  register them for editor picking/highlighting the same way. */
  track(e: Entity): Entity { this.map.onBuildEntity?.(this.buildIndex, e); return e; }

  /** cuboid mesh shaded by a named material (visual only). A `water` material makes
   *  the box a rippling liquid surface: its UVs tile with the box's horizontal size
   *  (so ripples keep a consistent scale) and a WaterAnim scrolls them. */
  mesh(x: number, y: number, z: number, w: number, h: number, d: number, mat: string, tu = 1, tv = 1): Entity {
    const e = this.root.createChild("b");
    e.transform.setPosition(x, y, z);
    e.transform.setScale(w, h, d);
    const r = e.addComponent(MeshRenderer);
    r.mesh = this.unitCube();
    const water = this.lib.isWater(mat);
    let tuu = tu, tvv = tv;
    if (water) { const t = Math.max(1, Math.max(w, d) / 6); tuu = tvv = t; }
    const m = this.lib.build(mat, tuu, tvv);
    r.setMaterial(m);
    if (water) this.lib.animate(e, mat, m, tuu);
    r.castShadows = !water;   // a transparent liquid surface shouldn't cast a hard shadow
    r.receiveShadows = true;
    this.map.tris += 12;
    return this.track(e);
  }

  /** cuboid + (optional) AABB collision — the structural workhorse */
  box(x: number, y: number, z: number, w: number, h: number, d: number, mat: string, tu = 1, tv = 1, solid = true): void {
    this.mesh(x, y, z, w, h, d, mat, tu, tv);
    if (solid) this.pushSolid({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  }

  cylinder(x: number, y: number, z: number, rTop: number, rBot: number, h: number, mat: string, tu: number, tv: number, seg = 10): Entity {
    const e = this.root.createChild("cyl");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCylinder(this.engine, rTop, rBot, h, seg);
    r.setMaterial(this.lib.build(mat, tu, tv));
    r.castShadows = true; r.receiveShadows = true;
    this.map.tris += seg * 6;
    return this.track(e);
  }

  /** instantiate a loaded glTF model (null-safe: returns null if it failed to load) */
  placeModel(id: string, x: number, y: number, z: number, scale: number, rotY = 0): Entity | null {
    const e = instantiate(this.models[id]);
    if (!e) return null;
    e.transform.setPosition(x, y, z);
    e.transform.setScale(scale, scale, scale);
    e.transform.setRotation(0, rotY, 0);
    this.root.addChild(e);
    this.map.tris += 500; // approx, for stats overlay
    return this.track(e);
  }

  /** instantiate a model with a full transform (per-axis scale + euler rotation),
   *  applying the model's calibrated meta (models/<id>/meta.json): a uniform `scale`
   *  multiplier, a `base` vertical offset so it rests on its footing, and a
   *  `material` override that reskins every surface. Used by every model placement
   *  (props, veg, explodables, lanterns) so a model is tuned once. */
  placeModelTf(id: string, at: Vec3T, rot: Vec3T, scale: Vec3T): Entity | null {
    const e = instantiate(this.models[id]);
    if (!e) return null;
    const meta = this.modelMeta.get(id) ?? {};
    const ms = typeof meta.scale === "number" && meta.scale > 0 ? meta.scale : 1;
    const sx = scale[0] * ms, sy = scale[1] * ms, sz = scale[2] * ms;
    const base = typeof meta.base === "number" ? meta.base : 0;
    e.transform.setScale(sx, sy, sz);
    e.transform.setPosition(at[0], at[1] + base * sy, at[2]);   // base is a local offset → scales with the model
    // compose the placement rotation over the model's baked baseRot (base applied
    // first, in the model's own frame) so a model can be oriented once in its meta.
    if (meta.baseRot && (meta.baseRot[0] || meta.baseRot[1] || meta.baseRot[2])) {
      e.transform.rotationQuaternion = composeRot(rot, meta.baseRot);
    } else {
      e.transform.setRotation(rot[0], rot[1], rot[2]);
    }
    if (typeof meta.material === "string" && meta.material) {
      const m = this.lib.build(meta.material);
      for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) r.setMaterial(m);
    }
    this.root.addChild(e);
    this.map.tris += 500;
    return this.track(e);
  }

  /** push a model placement's collision into the map. Honours the model's authored
   *  collision mode (models/<id>/meta.json): "manual" pushes each authored box
   *  (transformed by the placement + meta calibration) so e.g. only a tree's trunk
   *  blocks the player; "auto" (default) pushes one AABB hugging the whole mesh.
   *  `at`/`rot`/`scale` are the placement's WORLD transform (groups already resolved). */
  pushModelSolids(id: string, entity: Entity, at: Vec3T, rot: Vec3T, scale: Vec3T): void {
    const meta = this.modelMeta.get(id) ?? {};
    const boxes = meta.collision === "manual" ? (meta.collisionBoxes ?? []) : null;
    if (boxes) {
      const ms = typeof meta.scale === "number" && meta.scale > 0 ? meta.scale : 1;
      const base = typeof meta.base === "number" ? meta.base : 0;
      const sx = scale[0] * ms, sy = scale[1] * ms, sz = scale[2] * ms;
      const rotT: [number, number, number] = [rot[0], rot[1], rot[2]];
      const baseRot = meta.baseRot;
      for (const box of boxes) {
        // box centre in model-local space, scaled then rotated into world (extents
        // stay axis-aligned — collision is AABB-only, matching the box object type).
        // baseRot (if any) reorients the box in the model frame first, then placement.
        let local: [number, number, number] = [box.at[0] * sx, box.at[1] * sy, box.at[2] * sz];
        if (baseRot && (baseRot[0] || baseRot[1] || baseRot[2])) local = rotateEuler(local, [baseRot[0], baseRot[1], baseRot[2]]);
        const [rx, ry, rz] = rotateEuler(local, rotT);
        const cx = at[0] + rx, cy = at[1] + base * sy + ry, cz = at[2] + rz;
        const hx = Math.abs(box.size[0] * sx) / 2, hy = Math.abs(box.size[1] * sy) / 2, hz = Math.abs(box.size[2] * sz) / 2;
        this.pushSolid({ min: { x: cx - hx, y: cy - hy, z: cz - hz }, max: { x: cx + hx, y: cy + hy, z: cz + hz } });
      }
      return;
    }
    const aabb = this.modelAABB(entity);
    if (aabb) this.pushSolid(aabb);
  }

  /** world-space AABB of a placed model, unioned from its mesh renderers' bounds.
   *  lets props derive collision from actual geometry (null if no renderers). */
  modelAABB(e: Entity): AABB | null {
    const renderers = e.getComponentsIncludeChildren(MeshRenderer, []);
    if (renderers.length === 0) return null;
    const box = new BoundingBox();
    let has = false;
    for (const r of renderers) {
      if (!r.mesh) continue;
      if (!has) { box.copyFrom(r.bounds); has = true; } else { BoundingBox.merge(box, r.bounds, box); }
    }
    if (!has) return null;
    const { min, max } = box;
    return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } };
  }

}

/** compose an outer euler rotation over an inner (base) one: R = R_outer · R_base,
 *  i.e. the base orientation is applied first in the model's local frame, then the
 *  placement rotation. Returns the combined quaternion. */
function composeRot(outer: Vec3T, base: Vec3T): Quaternion {
  const qo = new Quaternion(), qb = new Quaternion(), out = new Quaternion();
  Quaternion.rotationEuler(outer[0] * DEG, outer[1] * DEG, outer[2] * DEG, qo);
  Quaternion.rotationEuler(base[0] * DEG, base[1] * DEG, base[2] * DEG, qb);
  Quaternion.multiply(qo, qb, out);
  return out;
}
const DEG = Math.PI / 180;
