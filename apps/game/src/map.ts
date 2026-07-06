// ─── GameMap: live world state + spatial queries (geometry comes from a MapDef) ─
// The map is no longer hard-coded here — build() is replaced by load(), which
// runs a MapDef through the loader. This class now just holds the resulting
// solids/spawns/objects and answers ray/point queries the game logic needs.
import { Engine, Entity } from "@galacean/engine";
import { GameModels } from "./models";
import { MapTextures } from "./textures";
import { MapBuilder } from "./mapbuilder";
import { loadMapDef } from "./maps/loader";
import { MapDef, MapEnv, MapMeta } from "./maps/schema";
import { Vec3 } from "./types";

export interface AABB { min: Vec3; max: Vec3 }
/** damageable explosive barrel (host tracks hp; explodes at 0) */
export interface Barrel { pos: Vec3; entity: Entity | null; solid: AABB; hp: number; dead: boolean }
/** a positional looping sound placed in the map (volume falls off with distance) */
export interface MapSound { pos: Vec3; el: HTMLAudioElement; radius: number; volume: number }

export class GameMap {
  solids: AABB[] = [];
  spawns: { p: Vec3; yaw: number }[] = [];
  pickupSpots: Vec3[] = [];
  powerupSpots: Vec3[] = [];
  barrels: Barrel[] = [];
  sounds: MapSound[] = [];
  tris = 0;
  root!: Entity;
  meta!: MapMeta;
  env!: MapEnv;
  /** editor-only hook: called for every entity created during a build, tagged
   *  with the index of the placement (in def.objects) that produced it. Lets the
   *  editor map rendered geometry back to objects for picking + highlighting. */
  onBuildEntity: ((index: number, entity: Entity) => void) | null = null;

  /** build (or rebuild) the world from a MapDef under `parent`. Safe to call
   *  repeatedly — the previous map's entities are torn down first. */
  load(engine: Engine, parent: Entity, tex: MapTextures, models: GameModels, def: MapDef): void {
    if (this.root) this.root.destroy();
    for (const s of this.sounds) { try { s.el.pause(); } catch { /* ignore */ } }
    this.solids = [];
    this.spawns = [];
    this.pickupSpots = [];
    this.powerupSpots = [];
    this.barrels = [];
    this.sounds = [];
    this.tris = 0;
    this.root = parent.createChild("map");
    this.meta = def.meta;
    this.env = def.env;
    loadMapDef(new MapBuilder(engine, this.root, tex, models, this), def);
  }

  /** per-frame: fade each positional sound by the listener's distance to it */
  tickSounds(listener: Vec3): void {
    for (const s of this.sounds) {
      const dx = s.pos.x - listener.x, dy = s.pos.y - listener.y, dz = s.pos.z - listener.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const v = Math.min(1, Math.max(0, 1 - d / s.radius) * s.volume);
      if (Math.abs(s.el.volume - v) > 0.01) s.el.volume = v;
    }
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

  // ── explosive barrels ──────────────────────────────────────────────────────
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
