// ─── MapBuilder: low-level primitives shared by the loader + object types ─────
// Writes geometry/collision straight into a GameMap, shading every surface through
// the MaterialLibrary (materials.ts) — geometry names a *material*, never a texture.
// Both brush interpretation (loader) and named object types (objects.ts) build
// exclusively through this, so there is one place that knows how to make a wall.
import {
  BoundingBox, Engine, Entity, MeshRenderer, PrimitiveMesh, Quaternion, Texture2D,
} from "@galacean/engine";
import { buildParticles, reconfigureParticles, type ParticleLook } from "./particles";
import catalog from "virtual:asset-catalog";
import { GameModels, instantiate } from "./models";
import { MapTextures, PbrSet, DEFAULT_FOLDER } from "./textures";
import { MaterialLibrary, shadeModelSlots } from "./materials";
import type { GroupDef, MaterialDef, ModelMeta, PhysicsProps, Tuple3 } from "@slopwars/shared";
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

  /** while building the members of a physics group, static collision is suppressed —
   *  the group's single dynamic body is the only collider (see beginGroupBody). */
  suppressSolids = false;
  private groupRootStack: Entity[] = [];

  pushSolid(a: AABB): void { if (this.suppressSolids) return; this.map.solids.push(a); }

  /** build (or re-adopt) a pooled particle emitter identified by `key`. Emitters live
   *  under the map's persistent fxRoot, so a rebuild re-adopts a matching one and keeps
   *  its in-flight particles flowing (a moved/tuned emitter never restarts). */
  buildParticleEmitter(key: string, x: number, y: number, z: number, look: Partial<ParticleLook>, sprite: Texture2D | null): Entity {
    const reused = this.map.claimParticle(key);
    if (reused && !reused.destroyed && reconfigureParticles(reused, look, sprite, this.engine)) {
      reused.isActive = true;
      reused.transform.setPosition(x, y, z);
      this.map.particles.push({ key, entity: reused });
      return reused;
    }
    const e = buildParticles(this.engine, this.map.fxRoot, x, y, z, look, sprite);
    this.map.particles.push({ key, entity: e });
    return e;
  }

  /** raw PBR texture set for a folder (falls back to the default) — for sprite
   *  consumers like the particle emitter that need an image, not a material. */
  texOf(folder?: string): PbrSet {
    return (folder && this.tex.get(folder)) || this.tex.get(DEFAULT_FOLDER) || this.tex.values().next().value!;
  }

  /** the colour map of a texture folder for use as a raw sprite (particle emitter),
   *  or null if the folder isn't loaded. Unlike texOf, this does NOT fall back to the
   *  default folder: a particle whose `tex` can't be resolved shows the procedural
   *  soft puff (see particles.ts) instead of the opaque wall texture as a hard square. */
  texColorOf(folder?: string): Texture2D | null {
    const set = folder ? this.tex.get(folder) : null;
    return set ? set.color : null;
  }

  /** enable/disable shadow casting on every mesh of a placed entity (e.g. a lantern
   *  that houses its own light shouldn't also cast a hard shadow of its shell). */
  setCastShadows(e: Entity, cast: boolean): void {
    for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = cast;
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
   *  multiplier, a `base` vertical offset so it rests on its footing, and per-slot
   *  `materials` that shade each glTF surface. Used by every model placement
   *  (props, veg, explodables, lanterns) so a model is tuned once. */
  placeModelTf(id: string, at: Vec3T, rot: Vec3T, scale: Vec3T): Entity | null {
    const e = instantiate(this.models[id]);
    if (!e) return null;
    const meta = this.modelMeta.get(id) ?? {};
    const { ms, base } = modelCalib(meta);
    const sx = scale[0] * ms, sy = scale[1] * ms, sz = scale[2] * ms;
    e.transform.setScale(sx, sy, sz);
    e.transform.setPosition(at[0], at[1] + base * sy, at[2]);   // base is a local offset → scales with the model
    // compose the placement rotation over the model's baked baseRot (base applied
    // first, in the model's own frame) so a model can be oriented once in its meta.
    if (meta.baseRot && (meta.baseRot[0] || meta.baseRot[1] || meta.baseRot[2])) {
      e.transform.rotationQuaternion = composeRot(rot, meta.baseRot);
    } else {
      e.transform.setRotation(rot[0], rot[1], rot[2]);
    }
    // shade each surface with the material assigned to its glTF slot (the model's MAIN
    // materials): a slot with an assignment is rebuilt from that material asset, an
    // unassigned slot keeps the glTF's own material (e.g. a transparent glass part).
    shadeModelSlots(e, meta, this.lib);
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
    if (this.suppressSolids) return;
    const meta = this.modelMeta.get(id) ?? {};
    const boxes = meta.collision === "manual" ? (meta.collisionBoxes ?? []) : null;
    if (boxes) {
      const { ms, base } = modelCalib(meta);
      const sx = scale[0] * ms, sy = scale[1] * ms, sz = scale[2] * ms;
      const rotT: [number, number, number] = [rot[0], rot[1], rot[2]];
      const baseRot = meta.baseRot;
      const hasBaseRot = !!baseRot && (baseRot[0] !== 0 || baseRot[1] !== 0 || baseRot[2] !== 0);
      for (const box of boxes) {
        const shape = box.shape === "cylinder" || box.shape === "sphere" ? box.shape : undefined;
        const boxRot = box.rot;
        if (boxRot && (boxRot[0] || boxRot[1] || boxRot[2])) {
          // oriented solid: transform its 8 corners into world and collide as the
          // enclosing world AABB (the collision model is AABB-only, so a rotated
          // solid contributes the tight axis-aligned box that wraps it).
          let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
          const hx0 = box.size[0] / 2, hy0 = box.size[1] / 2, hz0 = box.size[2] / 2;
          for (let i = 0; i < 8; i++) {
            const off = rotateEuler([(i & 1 ? hx0 : -hx0), (i & 2 ? hy0 : -hy0), (i & 4 ? hz0 : -hz0)], boxRot);
            let p: [number, number, number] = [(box.at[0] + off[0]) * sx, (box.at[1] + off[1]) * sy, (box.at[2] + off[2]) * sz];
            if (hasBaseRot) p = rotateEuler(p, [baseRot![0], baseRot![1], baseRot![2]]);
            p = rotateEuler(p, rotT);
            const wx = at[0] + p[0], wy = at[1] + base * sy + p[1], wz = at[2] + p[2];
            if (wx < mnx) mnx = wx; if (wx > mxx) mxx = wx;
            if (wy < mny) mny = wy; if (wy > mxy) mxy = wy;
            if (wz < mnz) mnz = wz; if (wz > mxz) mxz = wz;
          }
          this.pushSolid({ min: { x: mnx, y: mny, z: mnz }, max: { x: mxx, y: mxy, z: mxz }, shape });
          continue;
        }
        // box centre in model-local space, scaled then rotated into world (extents
        // stay axis-aligned — collision is AABB-only, matching the box object type).
        // baseRot (if any) reorients the box in the model frame first, then placement.
        let local: [number, number, number] = [box.at[0] * sx, box.at[1] * sy, box.at[2] * sz];
        if (hasBaseRot) local = rotateEuler(local, [baseRot![0], baseRot![1], baseRot![2]]);
        const [rx, ry, rz] = rotateEuler(local, rotT);
        const cx = at[0] + rx, cy = at[1] + base * sy + ry, cz = at[2] + rz;
        const hx = Math.abs(box.size[0] * sx) / 2, hy = Math.abs(box.size[1] * sy) / 2, hz = Math.abs(box.size[2] * sz) / 2;
        this.pushSolid({ min: { x: cx - hx, y: cy - hy, z: cz - hz }, max: { x: cx + hx, y: cy + hy, z: cz + hz }, shape });
      }
      return;
    }
    const aabb = this.modelAABB(entity);
    if (aabb) this.pushSolid(aabb);
  }

  /** register a placed model as a dynamic physics body (see objects.ts `prop` with
   *  physics on). The collider is derived from the model's authored manual collision
   *  (so a barrel authored as a cylinder becomes a cylinder body) or, failing that,
   *  from its mesh bounds. `phys` carries mass (kg) plus the optional PhysX tuning
   *  (grip / bounce / damping). The simulation lives in the game (PhysicsWorld); the
   *  editor just leaves the prop where placed. */
  pushDynamicBody(id: string, entity: Entity, at: Vec3T, rot: Vec3T, scale: Vec3T, phys: PhysicsProps): void {
    if (this.suppressSolids) return;   // inside a physics group → the group body owns collision
    const meta = this.modelMeta.get(id) ?? {};
    const { ms, base } = modelCalib(meta);
    const sx = scale[0] * ms, sy = scale[1] * ms, sz = scale[2] * ms;
    const pos = { x: at[0], y: at[1] + base * sy, z: at[2] };   // entity origin (matches placeModelTf)
    let half: { x: number; y: number; z: number };
    let off: { x: number; y: number; z: number };
    let shape: "cylinder" | "sphere" | undefined;
    const boxes = meta.collision === "manual" ? meta.collisionBoxes : undefined;
    if (boxes && boxes.length) {
      const b0 = boxes[0];   // the first authored solid defines the body's collider
      if (b0.rot && (b0.rot[0] || b0.rot[1] || b0.rot[2])) {
        // enclosing axis-aligned half-extents of the oriented authored solid
        const hx0 = Math.abs(b0.size[0] * sx) / 2, hy0 = Math.abs(b0.size[1] * sy) / 2, hz0 = Math.abs(b0.size[2] * sz) / 2;
        let ex = 0, ey = 0, ez = 0;
        for (let i = 0; i < 8; i++) {
          const c = rotateEuler([(i & 1 ? hx0 : -hx0), (i & 2 ? hy0 : -hy0), (i & 4 ? hz0 : -hz0)], b0.rot);
          ex = Math.max(ex, Math.abs(c[0])); ey = Math.max(ey, Math.abs(c[1])); ez = Math.max(ez, Math.abs(c[2]));
        }
        half = { x: ex, y: ey, z: ez };
      } else {
        half = { x: Math.abs(b0.size[0] * sx) / 2, y: Math.abs(b0.size[1] * sy) / 2, z: Math.abs(b0.size[2] * sz) / 2 };
      }
      off = { x: b0.at[0] * sx, y: b0.at[1] * sy, z: b0.at[2] * sz };
      shape = b0.shape === "cylinder" || b0.shape === "sphere" ? b0.shape : undefined;
    } else {
      const aabb = this.modelAABB(entity);   // world AABB at spawn
      if (aabb) {
        half = { x: (aabb.max.x - aabb.min.x) / 2, y: (aabb.max.y - aabb.min.y) / 2, z: (aabb.max.z - aabb.min.z) / 2 };
        off = { x: (aabb.min.x + aabb.max.x) / 2 - pos.x, y: (aabb.min.y + aabb.max.y) / 2 - pos.y, z: (aabb.min.z + aabb.max.z) / 2 - pos.z };
      } else { half = { x: 0.4, y: 0.4, z: 0.4 }; off = { x: 0, y: 0.4, z: 0 }; }
    }
    const q = new Quaternion();
    Quaternion.rotationEuler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, q);   // start at the authored orientation
    this.map.dynBodies.push({
      entity, mass: Math.max(0.05, phys.mass ?? 5),
      friction: phys.friction, restitution: phys.restitution,
      linearDamping: phys.linearDamping, angularDamping: phys.angularDamping,
      half, off, shape, pos,
      vel: { x: 0, y: 0, z: 0 }, q, angVel: { x: 0, y: 0, z: 0 }, onGround: false, rest: 0,
    });
  }

  /** open a physics group: create one body-root entity at the group's world origin
   *  `at`, redirect subsequent builds into it, and suppress their static collision.
   *  The loader then builds the group's members (at transforms relative to `at`) and
   *  calls endGroupBody. Returns the body root (for the caller to build under). */
  beginGroupBody(at: Tuple3): Entity {
    const e = this.root.createChild("group-body");
    e.transform.setPosition(at[0], at[1], at[2]);
    this.groupRootStack.push(this.root);
    this.root = e;
    this.suppressSolids = true;
    return e;
  }

  /** close a physics group opened with beginGroupBody: restore the build root, derive
   *  the body's collider from the combined bounds of everything just built under it,
   *  and register it as a dynamic body the PhysicsWorld simulates as a single unit. */
  endGroupBody(g: GroupDef, at: Tuple3): void {
    const e = this.root;                         // the group-body entity
    this.root = this.groupRootStack.pop() ?? this.root;
    this.suppressSolids = false;
    // collider = combined world AABB of the members' meshes (lights add nothing)
    const aabb = this.modelAABB(e);
    let half: { x: number; y: number; z: number };
    let off: { x: number; y: number; z: number };
    if (aabb) {
      half = { x: (aabb.max.x - aabb.min.x) / 2, y: (aabb.max.y - aabb.min.y) / 2, z: (aabb.max.z - aabb.min.z) / 2 };
      off = { x: (aabb.min.x + aabb.max.x) / 2 - at[0], y: (aabb.min.y + aabb.max.y) / 2 - at[1], z: (aabb.min.z + aabb.max.z) / 2 - at[2] };
    } else { half = { x: 0.4, y: 0.4, z: 0.4 }; off = { x: 0, y: 0.4, z: 0 }; }
    const mass = typeof g.mass === "number" && g.mass > 0 ? g.mass : 8;
    this.map.dynBodies.push({
      entity: e, mass,
      friction: g.friction, restitution: g.restitution,
      linearDamping: g.linearDamping, angularDamping: g.angularDamping,
      half, off, shape: undefined, pos: { x: at[0], y: at[1], z: at[2] },
      vel: { x: 0, y: 0, z: 0 }, q: new Quaternion(), angVel: { x: 0, y: 0, z: 0 }, onGround: false, rest: 0,
    });
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

/** a model's calibration scalars from its meta: the uniform `scale` multiplier
 *  (default 1, non-positive values ignored) and the `base` vertical offset (default
 *  0). Extracted once so placement, static collision, and dynamic-body derivation all
 *  read the same calibration instead of re-deriving it three ways. */
function modelCalib(meta: ModelMeta): { ms: number; base: number } {
  return {
    ms: typeof meta.scale === "number" && meta.scale > 0 ? meta.scale : 1,
    base: typeof meta.base === "number" ? meta.base : 0,
  };
}
