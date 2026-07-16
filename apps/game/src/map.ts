// ─── GameMap: live world state + spatial queries (geometry comes from a MapDef) ─
// The map is no longer hard-coded here — build() is replaced by load(), which
// runs a MapDef through the loader. This class now just holds the resulting
// solids/spawns/objects and answers ray/point queries the game logic needs.
import { DynamicCollider, Engine, Entity, Quaternion } from "@galacean/engine";
import { GameModels } from "./models";
import { MapTextures } from "./textures";
import { MapBuilder } from "./mapbuilder";
import { loadMapDef } from "./maps/loader";
import { MapDef, MapEnv, MapMeta, MaterialDef, ModelMeta } from "./maps/schema";
import { Vec3 } from "./types";

/** a collision primitive. Every solid keeps an axis-aligned `min`/`max` (the broad
 *  phase + the box case), and MAY carry a `shape` that refines the narrow phase: a
 *  "cylinder" is upright along Y (radius = half its x/z extent), a "sphere" is
 *  inscribed in the bounds. Omitted `shape` = a plain box (the classic behaviour),
 *  so every existing solid and query is unchanged. */
export type SolidShape = "cylinder" | "sphere";
export interface AABB { min: Vec3; max: Vec3; shape?: SolidShape }

/** does a vertical circle/segment proxy — radius `r` at (x,z), spanning y0..y1 (a
 *  player capsule or a point when r≈0, y0≈y1) — overlap solid `b`, honouring its
 *  shape? Broad-phases on the inflated AABB, then rounds off cylinders/spheres. */
export function solidOverlaps(b: AABB, x: number, z: number, r: number, y0: number, y1: number): boolean {
  if (!(x + r > b.min.x && x - r < b.max.x && y1 > b.min.y && y0 < b.max.y && z + r > b.min.z && z - r < b.max.z)) return false;
  if (!b.shape) return true;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  const R = (b.max.x - b.min.x) / 2;
  const dx = x - cx, dz = z - cz;
  if (b.shape === "cylinder") return dx * dx + dz * dz < (R + r) * (R + r);
  const cy = (b.min.y + b.max.y) / 2;                  // sphere: nearest point on the segment
  const dy = cy - (y0 > cy ? y0 : y1 < cy ? y1 : cy);
  return dx * dx + dz * dz + dy * dy < (R + r) * (R + r);
}
/** damageable explosive barrel (host tracks hp; explodes at 0) */
export interface Barrel { pos: Vec3; entity: Entity | null; solid: AABB; hp: number; dead: boolean }
/** a looping sound placed in the map. When `spatial`, volume falls off with the
 *  listener's distance; otherwise it plays at a constant `volume` everywhere (2D).
 *  `clip` is the source name, kept so a rebuild can re-adopt the still-playing
 *  element (the editor rebuilds on every edit — music/ambience must not restart). */
export interface MapSound { clip: string; pos: Vec3; el: HTMLAudioElement; radius: number; volume: number; spatial: boolean }
/** a live particle emitter placed in the map, keyed so a rebuild can re-adopt it
 *  (the editor rebuilds every edit — moving/tuning an emitter must not restart it). */
export interface MapParticle { key: string; entity: Entity }

/** a dynamic (physics-simulated) prop: a movable rigid body the PhysicsWorld
 *  integrates each frame (gravity, collisions, impulses from bullets/blasts/the
 *  player). Its collider is an axis-aligned box of `half`-extents offset by `off`
 *  from the entity origin `pos`; `shape` rounds the sides for how the player brushes
 *  past it. Only the game simulates these — the editor leaves the prop where placed. */
export interface DynBody {
  entity: Entity | null;
  mass: number;          // kg (heavy = barely shoved, light = easily pushed)
  /** per-body PhysX tuning (grip / bounce / damping); each falls back to a default in
   *  PhysxProps when omitted, so a body only stores what an author actually changed. */
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  half: Vec3;            // collider half-extents
  off: Vec3;             // collider centre offset from `pos`
  shape?: SolidShape;    // rounds player contact (cylinder/sphere); omit = box
  pos: Vec3;             // entity origin in world (written to the transform each frame)
  vel: Vec3;
  q: Quaternion;         // current orientation (world), integrated from angVel (fallback sim)
  angVel: Vec3;          // angular velocity (rad/s) about world x/y/z — full tumble/roll/tilt
  onGround: boolean;
  rest: number;          // seconds spent nearly still (→ sleeps to stop jitter)
  /** PhysX rigid body driving this prop when the PhysX backend is active (else the
   *  custom fallback sim integrates q/angVel manually). */
  collider?: DynamicCollider;
}

export class GameMap {
  solids: AABB[] = [];
  spawns: { p: Vec3; yaw: number }[] = [];
  pickupSpots: Vec3[] = [];
  powerupSpots: Vec3[] = [];
  barrels: Barrel[] = [];
  sounds: MapSound[] = [];
  /** sounds from the previous build, kept alive so a rebuild can re-adopt a matching
   *  still-playing element instead of restarting it (see load()/claimSound). */
  private reusableSounds: MapSound[] = [];
  /** live particle emitters, and the previous build's kept for re-adoption. They live
   *  under `fxRoot` (which survives a rebuild) so a moved/tuned emitter keeps flowing. */
  particles: MapParticle[] = [];
  private reusableParticles: MapParticle[] = [];
  /** persistent parent for pooled particle emitters — created once and NOT torn down
   *  on rebuild (the map root is), so re-adopted emitters keep their live particles. */
  fxRoot!: Entity;
  /** dynamic physics props (simulated by the game's PhysicsWorld; ignored by the editor) */
  dynBodies: DynBody[] = [];
  /** top planes of every water box, registered during build — WaterFX mirrors the
   *  scene about the biggest one (maps virtually always have a single water level). */
  waterPlanes: { y: number; area: number }[] = [];
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
  load(engine: Engine, parent: Entity, tex: MapTextures, models: GameModels, def: MapDef, matDefs?: Map<string, MaterialDef>, modelMeta?: Map<string, ModelMeta>): void {
    if (this.root) this.root.destroy();
    // keep the previous build's sounds + particle emitters alive so the new build can
    // re-adopt matching ones (continuous ambience/music + particle streams survive an
    // editor rebuild instead of restarting from scratch).
    this.reusableSounds = this.sounds;
    this.reusableParticles = this.particles;
    this.solids = [];
    this.spawns = [];
    this.pickupSpots = [];
    this.powerupSpots = [];
    this.barrels = [];
    this.sounds = [];
    this.particles = [];
    this.dynBodies = [];
    this.waterPlanes = [];
    this.tris = 0;
    this.root = parent.createChild("map");
    // the fx root persists across rebuilds (unlike the map root), so pooled emitters
    // keep their live particles when re-adopted; create it once under the same parent.
    if (!this.fxRoot || this.fxRoot.destroyed) this.fxRoot = parent.createChild("map-fx");
    this.meta = def.meta;
    this.env = def.env;
    loadMapDef(new MapBuilder(engine, this.root, tex, models, this, matDefs, modelMeta), def);
    // any leftover (un-readopted) sounds/particles belonged to placements that are gone
    for (const s of this.reusableSounds) { try { s.el.pause(); } catch { /* ignore */ } }
    this.reusableSounds = [];
    for (const p of this.reusableParticles) { try { p.entity.destroy(); } catch { /* ignore */ } }
    this.reusableParticles = [];
  }

  /** the reflection plane for this map: the largest water surface's top Y (or null
   *  when the map has no water — WaterFX then turns the whole system off). */
  primaryWaterY(): number | null {
    let best: { y: number; area: number } | null = null;
    for (const p of this.waterPlanes) if (!best || p.area > best.area) best = p;
    return best ? best.y : null;
  }

  /** claim a live emitter from the previous build matching `key`, so a rebuild reuses
   *  it (keeping its in-flight particles) instead of spawning a fresh one. */
  claimParticle(key: string): Entity | null {
    const i = this.reusableParticles.findIndex((p) => p.key === key);
    if (i < 0) return null;
    const e = this.reusableParticles[i].entity;
    this.reusableParticles.splice(i, 1);
    return e;
  }

  /** claim a still-alive audio element from the previous build matching `clip`, so a
   *  rebuild reuses it (keeping its playback position) instead of starting a new one.
   *  Returns null when there's no match — the caller then creates a fresh element. */
  claimSound(clip: string): HTMLAudioElement | null {
    const i = this.reusableSounds.findIndex((s) => s.clip === clip);
    if (i < 0) return null;
    const el = this.reusableSounds[i].el;
    this.reusableSounds.splice(i, 1);
    return el;
  }

  /** pause or resume every map sound — used when the editor hides the map viewport
   *  behind a preview tab so its ambience/music doesn't keep playing off-screen. */
  setSoundsPlaying(play: boolean): void {
    for (const s of this.sounds) {
      try { if (play) void s.el.play().catch(() => { /* awaits gesture */ }); else s.el.pause(); } catch { /* ignore */ }
    }
  }

  /** per-frame: fade each spatial sound by the listener's distance to it.
   *  Non-spatial (2D) sources keep the constant volume set at build time. */
  tickSounds(listener: Vec3): void {
    for (const s of this.sounds) {
      if (!s.spatial) continue;
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
      if (p.y <= b.min.y || p.y >= b.max.y) continue;
      if (!b.shape) { if (p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z) return true; continue; }
      if (solidOverlaps(b, p.x, p.z, 0, p.y, p.y)) return true;
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
