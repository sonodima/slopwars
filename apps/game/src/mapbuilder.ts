// ─── MapBuilder: low-level primitives shared by the loader + object types ─────
// Writes geometry/collision straight into a GameMap, shading every surface through
// the MaterialLibrary (materials.ts) — geometry names a *material*, never a texture.
// Both brush interpretation (loader) and named object types (objects.ts) build
// exclusively through this, so there is one place that knows how to make a wall.
import {
  BoundingBox, Engine, Entity, MeshRenderer, PrimitiveMesh,
} from "@galacean/engine";
import { GameModels, instantiate } from "./models";
import { MapTextures, PbrSet, DEFAULT_FOLDER } from "./textures";
import { MaterialLibrary } from "./materials";
import type { MaterialDef } from "@slopwars/shared";
import type { AABB, GameMap } from "./map";

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

  constructor(
    public engine: Engine,
    public root: Entity,
    public tex: MapTextures,
    public models: GameModels,
    public map: GameMap,
    matDefs?: Map<string, MaterialDef>,
  ) {
    this.lib = new MaterialLibrary(engine, tex, matDefs);
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

  /** cuboid mesh shaded by a named material (visual only) */
  mesh(x: number, y: number, z: number, w: number, h: number, d: number, mat: string, tu = 1, tv = 1): Entity {
    const e = this.root.createChild("b");
    e.transform.setPosition(x, y, z);
    e.transform.setScale(w, h, d);
    const r = e.addComponent(MeshRenderer);
    r.mesh = this.unitCube();
    r.setMaterial(this.lib.build(mat, tu, tv));
    r.castShadows = true;
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

  /** instantiate a model with a full transform (per-axis scale + euler rotation).
   *  used by the generic "prop" object so any model can be dropped in and posed. */
  placeModelTf(id: string, at: Vec3T, rot: Vec3T, scale: Vec3T): Entity | null {
    const e = instantiate(this.models[id]);
    if (!e) return null;
    e.transform.setPosition(at[0], at[1], at[2]);
    e.transform.setScale(scale[0], scale[1], scale[2]);
    e.transform.setRotation(rot[0], rot[1], rot[2]);
    this.root.addChild(e);
    this.map.tris += 500;
    return this.track(e);
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
