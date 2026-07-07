// ─── MapBuilder: low-level primitives shared by the loader + object types ─────
// Owns the material cache and writes geometry/collision straight into a GameMap.
// Both brush interpretation (loader) and named object types (objects.ts) build
// exclusively through this, so there is one place that knows how to make a wall.
import {
  BoundingBox, Color, Engine, Entity, MeshRenderer, PBRMaterial, PrimitiveMesh, Vector4,
} from "@galacean/engine";
import { GameModels, instantiate } from "./models";
import { MapTextures, PbrSet, DEFAULT_FOLDER } from "./textures";
import { buildWater } from "./water";
import type { AABB, GameMap } from "./map";

type Vec3T = readonly [number, number, number];

export class MapBuilder {
  private mats = new Map<string, PBRMaterial>();
  private colorMats = new Map<string, PBRMaterial>();
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
  ) {}

  /** cached PBR material for a texture set at a given tiling */
  mat(set: PbrSet, tu: number, tv: number): PBRMaterial {
    const key = `${set.color.instanceId}:${tu}:${tv}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new PBRMaterial(this.engine);
      m.baseTexture = set.color;
      m.normalTexture = set.normal;
      m.roughnessMetallicTexture = set.arm; // G=roughness, B=metallic
      m.occlusionTexture = set.arm;         // R=ambient occlusion
      m.tilingOffset = new Vector4(tu, tv, 0, 0);
      this.mats.set(key, m);
    }
    return m;
  }

  pushSolid(a: AABB): void { this.map.solids.push(a); }

  /** cached plain-colour PBR material (no texture) — for untextured primitives
   *  like the default gray floor or a solid-colour cube. */
  colorMat(r: number, g: number, b: number): PBRMaterial {
    const key = `${r.toFixed(3)}:${g.toFixed(3)}:${b.toFixed(3)}`;
    let m = this.colorMats.get(key);
    if (!m) {
      m = new PBRMaterial(this.engine);
      m.baseColor = new Color(r, g, b, 1);
      m.roughness = 0.9; m.metallic = 0.02;
      this.colorMats.set(key, m);
    }
    return m;
  }

  /** untextured coloured cuboid (visual only) */
  meshColor(x: number, y: number, z: number, w: number, h: number, d: number, r: number, g: number, b: number): Entity {
    const e = this.root.createChild("bc");
    e.transform.setPosition(x, y, z);
    e.transform.setScale(w, h, d);
    const rend = e.addComponent(MeshRenderer);
    rend.mesh = this.unitCube();
    rend.setMaterial(this.colorMat(r, g, b));
    rend.castShadows = true;
    rend.receiveShadows = true;
    this.map.tris += 12;
    return this.track(e);
  }

  /** the PBR set for a texture folder, falling back to the default folder */
  texOf(folder?: string): PbrSet {
    return (folder && this.tex.get(folder)) || this.tex.get(DEFAULT_FOLDER) || this.tex.values().next().value!;
  }

  /** report a freshly created entity to the (editor-only) build hook so it can be
   *  associated with the placement it came from — no-op in the game. */
  private track(e: Entity): Entity { this.map.onBuildEntity?.(this.buildIndex, e); return e; }

  /** textured cuboid mesh (visual only) */
  mesh(x: number, y: number, z: number, w: number, h: number, d: number, set: PbrSet, tu: number, tv: number): Entity {
    const e = this.root.createChild("b");
    e.transform.setPosition(x, y, z);
    e.transform.setScale(w, h, d);
    const r = e.addComponent(MeshRenderer);
    r.mesh = this.unitCube();
    r.setMaterial(this.mat(set, tu, tv));
    r.castShadows = true;
    r.receiveShadows = true;
    this.map.tris += 12;
    return this.track(e);
  }

  /** cuboid + (optional) AABB collision — the structural workhorse */
  box(x: number, y: number, z: number, w: number, h: number, d: number, set: PbrSet, tu = 1, tv = 1, solid = true): void {
    this.mesh(x, y, z, w, h, d, set, tu, tv);
    if (solid) this.pushSolid({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  }

  cylinder(x: number, y: number, z: number, rTop: number, rBot: number, h: number, set: PbrSet, tu: number, tv: number, seg = 10): Entity {
    const e = this.root.createChild("cyl");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCylinder(this.engine, rTop, rBot, h, seg);
    r.setMaterial(this.mat(set, tu, tv));
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

  water(x: number, y: number, z: number, s: number): void {
    // realistic animated water (refraction + reflection + flow) — see water.ts
    const e = buildWater(this.engine, this.root, x, y, z, s);
    this.map.tris += 12;
    this.track(e);
  }

}
