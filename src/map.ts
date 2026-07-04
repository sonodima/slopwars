// ─── "Kasbah" — compact courtyard map: geometry, solid AABBs, ray queries ────
import {
  Color, Engine, Entity, GLTFResource, MeshRenderer, PBRMaterial,
  PointLight, PrimitiveMesh, Vector4,
} from "@galacean/engine";
import { GameModels, instantiate } from "./models";
import { MapTextures, PbrSet } from "./textures";
import { Vec3 } from "./types";

export interface AABB { min: Vec3; max: Vec3 }
/** damageable explosive barrel (host tracks hp; explodes at 0) */
export interface Barrel { pos: Vec3; entity: Entity | null; solid: AABB; hp: number; dead: boolean }

export const BARREL_HP = 120;

// per-model transform tuning (PH models are real-world scale; dial to fit map)
const MODEL = {
  barrelScale: 1.15,
  lanternScale: 1.0,
  planterScale: 1.0, planterTop: 0.5,
  succScale: 1.0, shrubScale: 1.0,
};

// bounds: x ∈ [-30,30], z ∈ [-22,22]. north = -z.
export class GameMap {
  solids: AABB[] = [];
  spawns: { p: Vec3; yaw: number }[] = [];
  pickupSpots: Vec3[] = [];
  powerupSpots: Vec3[] = [];
  barrels: Barrel[] = [];
  tris = 0;
  root!: Entity;

  private engine!: Engine;
  private tex!: MapTextures;
  private models!: GameModels;
  private mats = new Map<string, PBRMaterial>();

  build(engine: Engine, parent: Entity, tex: MapTextures, models: GameModels): void {
    this.engine = engine;
    this.tex = tex;
    this.models = models;
    this.root = parent.createChild("map");
    const T = tex;
    const H = 6;

    // ── ground + outer walls + cornice ledges ──
    this.slab(0, -0.5, 0, 64, 1, 48, T.floor, 16, 12);
    this.box(0, H / 2, -22.6, 62, H, 1.2, T.wall, 12, 1.2);
    this.box(0, H / 2, 22.6, 62, H, 1.2, T.wall, 12, 1.2);
    this.box(-30.6, H / 2, 0, 1.2, H, 46, T.wall, 9, 1.2);
    this.box(30.6, H / 2, 0, 1.2, H, 46, T.wall, 9, 1.2);
    this.box(0, 5.6, -21.85, 62, 0.35, 0.5, T.stone, 12, 0.2);   // cornices
    this.box(0, 5.6, 21.85, 62, 0.35, 0.5, T.stone, 12, 0.2);
    this.box(-29.85, 5.6, 0, 0.5, 0.35, 46, T.stone, 9, 0.2);
    this.box(29.85, 5.6, 0, 0.5, 0.35, 46, T.stone, 9, 0.2);

    // ═══ COURTYARD DIVIDERS (z = ±13) with framed double doorways at x = ±7 ═══
    // Wall segments tile the width leaving 2.4-wide openings; stone frames are PROUD
    // (depth 1.1 vs wall 0.9) and the capstone overlaps the segment tops (bottom 3.9 <
    // top 4.0) so no faces are coplanar → no z-fighting, and segments meet the jambs → no gaps.
    for (const zs of [-13, 13]) {
      this.box(-10.6, 2, zs, 4.8, 4, 0.9, T.wall, 1.4, 0.8);       // left segment  [-13,-8.2]
      this.box(0, 2, zs, 11.6, 4, 0.9, T.wall, 3.3, 0.8);         // middle segment [-5.8,5.8]
      this.box(10.6, 2, zs, 4.8, 4, 0.9, T.wall, 1.4, 0.8);        // right segment  [8.2,13]
      for (const xs of [-7, 7]) {                                   // proud jambs + lintel
        this.box(xs - 1.2, 1.35, zs, 0.3, 2.7, 1.1, T.stone, 0.25, 0.9);
        this.box(xs + 1.2, 1.35, zs, 0.3, 2.7, 1.1, T.stone, 0.25, 0.9);
        this.box(xs, 3.35, zs, 2.9, 1.3, 1.1, T.stone, 0.9, 0.45); // lintel above the 2.7 opening
      }
      this.box(0, 4.15, zs, 26, 0.5, 1.2, T.stone, 6, 0.25);       // capstone (overlaps tops)
    }

    // ═══ FOUNTAIN (courtyard center) — pickup on plinth ═══
    this.box(0, 0.3, -1.95, 4.2, 0.6, 0.5, T.stone, 1.4, 0.25);    // basin rim
    this.box(0, 0.3, 1.95, 4.2, 0.6, 0.5, T.stone, 1.4, 0.25);
    this.box(-1.95, 0.3, 0, 0.5, 0.6, 3.4, T.stone, 0.25, 1.2);
    this.box(1.95, 0.3, 0, 0.5, 0.6, 3.4, T.stone, 0.25, 1.2);
    this.water(0, 0.42, 0, 3.3);
    this.box(0, 0.7, 0, 0.9, 1.4, 0.9, T.stone, 0.4, 0.6);         // plinth
    this.pickupSpots.push({ x: 0, y: 1.75, z: 0 });

    // ═══ WEST BUILDING (arcade, x ∈ [-22,-13]) + rooftop route ═══
    this.box(-22.3, 1.7, -9.9, 0.9, 3.4, 6.2, T.wall, 1.8, 0.9);   // back wall segments (window holes)
    this.box(-22.3, 1.7, -1.0, 0.9, 3.4, 8.4, T.wall, 2.4, 0.9);
    this.box(-22.3, 1.7, 8.9, 0.9, 3.4, 8.2, T.wall, 2.4, 0.9);
    this.window(-22.3, -6); this.window(-22.3, 4);                  // overlook west alley
    this.box(-17.5, 1.7, -13, 8.6, 3.4, 0.9, T.wall, 2.5, 0.9);    // north cap (door via plaza gap x=-26 stays open in alley)
    this.box(-17.5, 1.7, 13, 8.6, 3.4, 0.9, T.wall, 2.5, 0.9);     // south cap
    for (const zc of [-10.5, -7, -3.5, 0, 3.5, 7, 10.5]) this.column(-13.2, zc); // colonnade
    this.box(-13.2, 3.15, 0, 0.7, 0.5, 26, T.stone, 0.2, 7);       // lintel beam
    this.slab(-17.75, 3.6, 0, 10, 0.4, 26, T.dark, 3, 7);          // roof (top 3.8)
    this.box(-13.05, 4.15, -4, 0.4, 0.7, 18.5, T.stone, 0.15, 5);  // roof railing (east edge)
    // stone stairs up (courtyard, along west colonnade) + landing
    this.stairsZ(-11.4, 12.2, 3.8, 6.2, "z-", 2.1);
    this.slab(-11.75, 3.6, 5.2, 3.5, 0.4, 1.8, T.dark, 1, 0.5);
    this.pickupSpots.push({ x: -17.5, y: 4.3, z: -1 });
    this.lamp(-13.6, 2.7, -7); this.lamp(-13.6, 2.7, 7);           // arcade lamps

    // ═══ EAST BUILDING: interior room (x ∈ [13,24], z ∈ [-11,1]) ═══
    this.box(13.3, 1.7, -8.25, 0.9, 3.4, 5.5, T.wall, 1.8, 0.9);   // west wall, door at z=-5..-3.4
    this.box(13.3, 1.7, -0.9, 0.9, 3.4, 3.8, T.wall, 1.2, 0.9);
    this.box(13.3, 3, -4.2, 1.02, 0.8, 2.8, T.stone, 0.9, 0.3);    // door header (proud)
    this.awning(12.4, -4.2, 2.6, 1.3, 2.6);                        // awning over door
    this.box(18.5, 1.7, -11.3, 11.3, 3.4, 0.9, T.wall, 3, 0.9);    // north wall
    this.box(24.3, 1.7, -8.55, 0.9, 3.4, 5.5, T.wall, 1.6, 0.9);   // east wall segments (window hole)
    this.box(24.3, 1.7, -1.75, 0.9, 3.4, 4.9, T.wall, 1.4, 0.9);
    this.window(24.3, -5, true);                                    // window → alley
    this.box(15.5, 1.7, 0.7, 5.3, 3.4, 0.9, T.wall, 1.6, 0.9);     // south wall, door at x=19..20.6
    this.box(22.5, 1.7, 0.7, 3.9, 3.4, 0.9, T.wall, 1.2, 0.9);
    this.box(19.8, 3, 0.7, 2.8, 0.8, 1.02, T.stone, 0.9, 0.3);     // door header (proud)
    this.slab(18.75, 3.6, -5.3, 11.9, 0.4, 12.9, T.dark, 3, 3);    // room roof (top 3.8, walkable)
    this.box(13.1, 3.95, -5.3, 0.4, 0.35, 12.9, T.stone, 0.15, 3); // roof parapet west
    this.box(18.75, 3.95, -11.55, 11.9, 0.35, 0.4, T.stone, 3, 0.15);
    this.box(18, 0.45, -8.5, 2.6, 0.9, 1.2, T.crate, 0.9, 0.4);    // table
    this.pallet(21.5, -2); this.pallet(15.5, -9.5);
    this.lamp(18.5, 2.9, -5);
    this.pickupSpots.push({ x: 18.5, y: 0.55, z: -5 });

    // ═══ EAST BALCONY over alley (y 3.0–3.4) + side-yard stairs ═══
    this.box(24.3, 1.5, 4.35, 0.9, 3, 6.1, T.wall, 1.8, 0.8);      // low walls side-yard/alley (gap for stairs)
    this.box(24.3, 1.5, 11.25, 0.9, 3, 2.9, T.wall, 0.9, 0.8);
    this.slab(27.35, 3.2, 3.5, 6.9, 0.4, 11, T.dark, 2, 3);        // balcony deck (top 3.4)
    this.box(24.3, 3.85, 2.7, 0.4, 0.9, 9.4, T.stone, 0.12, 3);    // balcony railing west (gap at stairs)
    this.box(27.35, 3.85, 9.2, 6.9, 0.9, 0.4, T.stone, 2, 0.12);   // railing south
    this.stairsX(17.6, 8.6, 3.4, 6.4, "x+", 2.4);                  // side-yard stairs
    this.pickupSpots.push({ x: 27.3, y: 3.95, z: 0 });
    this.lamp(27.3, 2.5, -6);                                       // under-balcony alley lamp

    // ═══ MARKET STALLS (courtyard east) ═══
    this.stall(8.5, -6.5); this.stall(8.5, 5.5);

    // ═══ SANDBAGS (courtyard west) ═══
    this.sandbags(-7.5, -1.5, 0); this.sandbags(-7.9, 0, 1); this.sandbags(-7.5, 1.5, 0);
    this.sandbags(-6.2, -0.8, 1);

    // ═══ PLAZA PROPS ═══
    this.crate(-3, -17); this.crate(-3, -17, 1.1, 1.6); this.crate(-4.7, -16.2);
    this.crate(4, 17.5); this.crate(4, 17.5, 1.1, 1.6); this.crate(5.8, 16.8);
    this.crate(26.5, -17); this.crate(-26.5, 17);
    this.barrel(-27.5, -15); this.barrel(-26.3, -15.4); this.barrel(27.6, 15.2);
    this.barrel(11.8, -1); this.barrel(11.8, 0.4);
    this.planter(-26, -20); this.planter(26, 20); this.planter(-3.5, 10.5); this.planter(3.5, -10.5);
    this.pallet(-15, -16); this.pallet(14, 18.5);

    // ═══ VEGETATION ═══
    this.vegetate();

    // ═══ POWERUP SPOTS (open floor / rooftops) ═══
    this.powerupSpots = [
      { x: 0, y: 0.8, z: -8 },
      { x: 0, y: 0.8, z: 8 },
      { x: -17.75, y: 4.1, z: 5 },
      { x: 18.75, y: 4.1, z: -8 },
    ];

    // ═══ SPAWNS ═══
    const S: [number, number, number][] = [
      [0, -18, 180], [-13, -17.5, 150], [13, -17.5, 210], [-24, -18, 135], [24, -18, 225],
      [0, 18, 0], [-13, 17.5, 30], [13, 17.5, -30], [-24, 18, 45], [24, 18, -45],
      [-26.5, 0, 180], [27.3, -8, 0],
    ];
    for (const [x, z, yaw] of S) this.spawns.push({ p: { x, y: this.floorY(x, z) + 0.05, z }, yaw });
  }

  // ── queries ──────────────────────────────────────────────────────────────
  raycast(o: Vec3, d: Vec3, maxDist: number): { dist: number; normal: Vec3 } | null {
    let best = maxDist;
    let bn: Vec3 | null = null;
    for (const b of this.solids) {
      const h = rayAABB(o, d, b, best);
      if (h) { best = h.dist; bn = h.normal; }
    }
    return bn ? { dist: best, normal: bn } : null;
  }

  thicknessAt(entry: Vec3, d: Vec3, maxPen: number): number {
    const step = 0.05;
    let t = step;
    const p = { x: 0, y: 0, z: 0 };
    while (t <= maxPen + step) {
      p.x = entry.x + d.x * t; p.y = entry.y + d.y * t; p.z = entry.z + d.z * t;
      if (!this.pointInSolid(p)) return t;
      t += step;
    }
    return Infinity;
  }

  pointInSolid(p: Vec3): boolean {
    for (const b of this.solids) {
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return true;
    }
    return false;
  }

  floorY(x: number, z: number): number {
    let y = 0;
    for (const b of this.solids) {
      if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z && b.max.y > y && b.max.y < 3.5) y = b.max.y;
    }
    return y;
  }

  // ── builders ─────────────────────────────────────────────────────────────
  private mat(set: PbrSet, tu: number, tv: number): PBRMaterial {
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

  /** instantiate a loaded model at a transform (visual only — collision is pushed by caller).
   *  null-safe: returns null if the model failed to load. */
  private placeModel(res: GLTFResource | null, x: number, y: number, z: number, scale: number, rotY = 0): Entity | null {
    const e = instantiate(res);
    if (!e) return null;
    e.transform.setPosition(x, y, z);
    e.transform.setScale(scale, scale, scale);
    e.transform.setRotation(0, rotY, 0);
    this.root.addChild(e);
    this.tris += 500; // approx, for stats overlay
    return e;
  }

  private mesh(x: number, y: number, z: number, w: number, h: number, d: number, tex: PbrSet, tu: number, tv: number): Entity {
    const e = this.root.createChild("b");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCuboid(this.engine, w, h, d);
    r.setMaterial(this.mat(tex, tu, tv));
    r.castShadows = true;
    r.receiveShadows = true;
    this.tris += 12;
    return e;
  }

  private box(x: number, y: number, z: number, w: number, h: number, d: number, tex: PbrSet, tu = 1, tv = 1): void {
    this.mesh(x, y, z, w, h, d, tex, tu, tv);
    this.solids.push({ min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 }, max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 } });
  }

  private slab(x: number, y: number, z: number, w: number, h: number, d: number, tex: PbrSet, tu: number, tv: number): void {
    this.box(x, y, z, w, h, d, tex, tu, tv);
  }

  private crate(x: number, z: number, s = 1.6, baseY = 0): void {
    this.box(x, baseY + s / 2, z, s, s, s, this.tex.crate, 1, 1);
  }

  private column(x: number, z: number): void {
    const e = this.root.createChild("col");
    e.transform.setPosition(x, 1.45, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCylinder(this.engine, 0.32, 0.32, 2.9, 10);
    r.setMaterial(this.mat(this.tex.stone, 0.6, 1.4));
    r.castShadows = true; r.receiveShadows = true;
    this.tris += 60;
    this.box(x, 3.05, z, 0.85, 0.3, 0.85, this.tex.stone, 0.3, 0.15); // capital
    this.box(x, 0.15, z, 0.85, 0.3, 0.85, this.tex.stone, 0.3, 0.15); // base
    this.solids.push({ min: { x: x - 0.32, y: 0, z: z - 0.32 }, max: { x: x + 0.32, y: 2.9, z: z + 0.32 } });
  }

  /** window opening in an x-facing wall: sill 1.1, head 2.3, width 1.6 (wall base h3.4 handled by caller leaving hole implicitly — here we add sill+header+jambs filling around a hole in a 3.4-high wall segment) */
  private window(x: number, z: number, _east = false): void {
    this.box(x, 0.55, z, 0.9, 1.1, 1.6, this.tex.wall, 0.5, 0.4);   // sill fill
    this.box(x, 2.85, z, 0.9, 1.1, 1.6, this.tex.wall, 0.5, 0.4);   // header fill
    this.box(x, 1.12, z, 1.1, 0.14, 1.9, this.tex.stone, 0.6, 0.08); // sill ledge
  }

  private barrel(x: number, z: number): void {
    const e = this.placeModel(this.models.barrel, x, 0, z, MODEL.barrelScale);
    const solid: AABB = { min: { x: x - 0.45, y: 0, z: z - 0.45 }, max: { x: x + 0.45, y: 1.1, z: z + 0.45 } };
    this.solids.push(solid);
    this.barrels.push({ pos: { x, y: 0.55, z }, entity: e, solid, hp: BARREL_HP, dead: false });
  }

  /** nearest non-dead barrel hit by a ray, within maxDist */
  raycastBarrel(o: Vec3, d: Vec3, maxDist: number): { index: number; dist: number } | null {
    let best = maxDist, idx = -1;
    for (let i = 0; i < this.barrels.length; i++) {
      const b = this.barrels[i];
      if (b.dead) continue;
      const h = rayAABB(o, d, b.solid, best);
      if (h) { best = h.dist; idx = i; }
    }
    return idx >= 0 ? { index: idx, dist: best } : null;
  }

  /** remove a barrel's visual + collision (called on explode, host + guests) */
  killBarrel(i: number): Barrel | null {
    const b = this.barrels[i];
    if (!b || b.dead) return null;
    b.dead = true;
    if (b.entity) b.entity.isActive = false;
    const k = this.solids.indexOf(b.solid);
    if (k >= 0) this.solids.splice(k, 1);
    return b;
  }

  /** scatter desert vegetation at sensible ground spots */
  private vegetate(): void {
    const spots: [number, number, "shrub" | "succulent"][] = [
      [-8.6, -2.2, "shrub"], [-6.4, 2.1, "succulent"], [9.2, -9.3, "succulent"], [9.4, 9.1, "shrub"],
      [-27.2, -19, "shrub"], [27.2, 19, "shrub"], [-3.6, 10.6, "succulent"], [3.6, -10.6, "succulent"],
      [11.6, 1.1, "shrub"], [-24.2, 15.3, "succulent"], [26.6, -17.4, "succulent"], [-15.4, -15.8, "shrub"],
    ];
    for (const [x, z, which] of spots) {
      const scale = which === "shrub" ? MODEL.shrubScale : MODEL.succScale;
      this.placeModel(this.models[which], x, this.floorY(x, z), z, scale, Math.random() * 360);
    }
  }

  private planter(x: number, z: number): void {
    this.placeModel(this.models.planter, x, 0, z, MODEL.planterScale);
    this.placeModel(this.models.succulent, x, MODEL.planterTop, z, MODEL.succScale, Math.random() * 360);
    this.solids.push({ min: { x: x - 0.8, y: 0, z: z - 0.8 }, max: { x: x + 0.8, y: 0.7, z: z + 0.8 } });
  }

  private pallet(x: number, z: number): void {
    this.box(x, 0.08, z, 1.3, 0.16, 1.1, this.tex.crate, 0.8, 0.7);
  }

  private sandbags(x: number, z: number, rot: 0 | 1): void {
    const w = rot ? 0.65 : 1.5, d = rot ? 1.5 : 0.65;
    this.box(x, 0.28, z, w, 0.56, d, this.tex.wall, 0.6, 0.3);
    this.box(x + (rot ? 0 : 0.1), 0.72, z + (rot ? 0.1 : 0), w * 0.8, 0.34, d * 0.8, this.tex.wall, 0.5, 0.2);
  }

  private stall(x: number, z: number): void {
    this.box(x, 0.5, z, 2.6, 1.0, 1.1, this.tex.crate, 1.4, 0.6);          // counter
    for (const [dx, dz] of [[-1.2, -0.9], [1.2, -0.9], [-1.2, 0.9], [1.2, 0.9]]) {
      this.box(x + dx, 1.2, z + dz, 0.14, 2.4, 0.14, this.tex.crate, 0.1, 1.4); // poles
    }
    this.slab(x, 2.45, z, 3.1, 0.14, 2.4, this.tex.metal, 1.4, 1);          // canopy (jumpable)
    this.pallet(x - 0.5, z + 1.7);
  }

  private water(x: number, y: number, z: number, s: number): void {
    const e = this.root.createChild("water");
    e.transform.setPosition(x, y, z);
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCuboid(this.engine, s, 0.08, s);
    const m = new PBRMaterial(this.engine);
    m.baseColor = new Color(0.05, 0.14, 0.19, 1); // deeper, less plastic-cyan
    m.roughness = 0.16; m.metallic = 0.12;
    r.setMaterial(m);
    r.receiveShadows = true;
    this.tris += 12;
  }

  private awning(x: number, z: number, w: number, d: number, y: number): void {
    this.slab(x, y + 0.06, z, d, 0.12, w, this.tex.metal, 0.6, 1);
  }

  private lamp(x: number, y: number, z: number): void {
    const e = this.placeModel(this.models.lantern, x, y, z, MODEL.lanternScale) ?? this.root.createChild("lamp");
    e.transform.setPosition(x, y, z);
    const l = e.addComponent(PointLight);
    l.color = new Color(0.9, 0.62, 0.32, 1);
    l.distance = 8;
  }

  /** steps rising along x */
  private stairsX(x0: number, z: number, h: number, len: number, dir: "x+" | "x-", depth: number): void {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const sh = (h / steps) * (i + 1);
      const sl = len / steps;
      const cx = dir === "x+" ? x0 + sl * i + sl / 2 : x0 - sl * i - sl / 2;
      this.box(cx, sh / 2, z, sl, sh, depth, this.tex.dark, 0.5, 0.5);
    }
  }

  /** steps rising along z */
  private stairsZ(x: number, z0: number, h: number, len: number, dir: "z+" | "z-", depth: number): void {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const sh = (h / steps) * (i + 1);
      const sl = len / steps;
      const cz = dir === "z+" ? z0 + sl * i + sl / 2 : z0 - sl * i - sl / 2;
      this.box(x, sh / 2, cz, depth, sh, sl, this.tex.dark, 0.5, 0.5);
    }
  }
}

// ─── ray/AABB slab intersection ──────────────────────────────────────────────
export function rayAABB(o: Vec3, d: Vec3, b: AABB, maxDist: number): { dist: number; normal: Vec3 } | null {
  let tmin = 0, tmax = maxDist;
  let axis = -1, sign = 0;
  const od = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  const mn = [b.min.x, b.min.y, b.min.z], mx = [b.max.x, b.max.y, b.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-9) {
      if (od[i] < mn[i] || od[i] > mx[i]) return null;
    } else {
      const inv = 1 / dd[i];
      let t1 = (mn[i] - od[i]) * inv;
      let t2 = (mx[i] - od[i]) * inv;
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (axis < 0 || tmin <= 0) return null;
  const n = { x: 0, y: 0, z: 0 };
  if (axis === 0) n.x = sign; else if (axis === 1) n.y = sign; else n.z = sign;
  return { dist: tmin, normal: n };
}
