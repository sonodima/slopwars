// ─── MapBuilder: low-level primitives shared by the loader + object types ─────
// Owns the material cache and writes geometry/collision straight into a GameMap.
// Both brush interpretation (loader) and named object types (objects.ts) build
// exclusively through this, so there is one place that knows how to make a wall.
import {
  Color, Engine, Entity, MeshRenderer, PBRMaterial, PrimitiveMesh, Vector4,
} from "@galacean/engine";
import { GameModels, ModelId, instantiate } from "./models";
import { MapTextures, PbrSet } from "./textures";
import type { AABB, GameMap } from "./map";

export class MapBuilder {
  private mats = new Map<string, PBRMaterial>();

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

  /** textured cuboid mesh (visual only) */
  mesh(x: number, y: number, z: number, w: number, h: number, d: number, set: PbrSet, tu: number, tv: number): Entity {
    const e = this.root.createChild("b");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCuboid(this.engine, w, h, d);
    r.setMaterial(this.mat(set, tu, tv));
    r.castShadows = true;
    r.receiveShadows = true;
    this.map.tris += 12;
    return e;
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
    return e;
  }

  /** instantiate a loaded glTF model (null-safe: returns null if it failed to load) */
  placeModel(id: ModelId, x: number, y: number, z: number, scale: number, rotY = 0): Entity | null {
    const e = instantiate(this.models[id]);
    if (!e) return null;
    e.transform.setPosition(x, y, z);
    e.transform.setScale(scale, scale, scale);
    e.transform.setRotation(0, rotY, 0);
    this.root.addChild(e);
    this.map.tris += 500; // approx, for stats overlay
    return e;
  }

  water(x: number, y: number, z: number, s: number): void {
    const e = this.root.createChild("water");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCuboid(this.engine, s, 0.08, s);
    const m = new PBRMaterial(this.engine);
    m.baseColor = new Color(0.05, 0.14, 0.19, 1);
    m.roughness = 0.16; m.metallic = 0.12;
    r.setMaterial(m);
    r.receiveShadows = true;
    this.map.tris += 12;
  }

  /** rising staircase (each step is a solid box); `at` = low-step start corner */
  stairs(at: readonly [number, number, number], axis: "x+" | "x-" | "z+" | "z-", rise: number, run: number, width: number, set: PbrSet, steps = 8): void {
    const sl = run / steps;
    for (let i = 0; i < steps; i++) {
      const sh = (rise / steps) * (i + 1);
      if (axis === "x+" || axis === "x-") {
        const cx = axis === "x+" ? at[0] + sl * i + sl / 2 : at[0] - sl * i - sl / 2;
        this.box(cx, sh / 2, at[2], sl, sh, width, set, 0.5, 0.5);
      } else {
        const cz = axis === "z+" ? at[2] + sl * i + sl / 2 : at[2] - sl * i - sl / 2;
        this.box(at[0], sh / 2, cz, width, sh, sl, set, 0.5, 0.5);
      }
    }
  }
}
