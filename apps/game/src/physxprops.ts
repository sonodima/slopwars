// ─── PhysX prop simulation: real rigid bodies for dynamic props ───────────────
// The realistic backend for the game's movable props (crates, barrels, cans, and
// whole physics-groups). Instead of the custom axis-by-axis fallback, this hands
// each prop to Galacean's PhysX rigid-body engine: it falls, rests, stacks, and —
// crucially — ROLLS and TUMBLES with real friction and contact, so shooting the top
// of a barrel topples it and a blast sends it spinning across the floor.
//
// Only DYNAMIC props go through PhysX. The player keeps its bespoke quake-style
// controller; a kinematic capsule follows it so PhysX lets the player shove props.
// The static world is mirrored as StaticColliders (one box per map solid) so props
// have floors and walls to collide against. PhysX is stepped by the engine's own
// update loop (engine.run()), so `step()` here only drives the player capsule.
import {
  BoxColliderShape, CapsuleColliderShape, ColliderShape, DynamicCollider, Entity,
  PhysicsMaterial, SphereColliderShape, StaticCollider, Vector3, WebGLEngine,
} from "@galacean/engine";
import { DynBody, GameMap, rayAABB } from "./map";
import { PHYSICS_DEFAULTS } from "@slopwars/shared";
import type { PropSim } from "./physics";
import { PlayerBody } from "./player";
import { MOVE, Vec3 } from "./types";

const GRAVITY = 16;          // m/s² (a touch snappier than 9.81 for game feel)
const TORQUE_K = 4.5;        // off-centre impact → spin (per unit mass)

export class PhysxProps implements PropSim {
  private staticRoot: Entity | null = null;
  private playerE: Entity | null = null;
  private playerCol: DynamicCollider | null = null;
  private playerShape: CapsuleColliderShape | null = null;
  private mat: PhysicsMaterial;
  private tmp = new Vector3();

  constructor(private engine: WebGLEngine, private root: Entity, private map: GameMap) {
    this.mat = new PhysicsMaterial();
    this.mat.staticFriction = 0.7;
    this.mat.dynamicFriction = 0.55;   // enough grip to roll rather than slide
    this.mat.bounciness = 0.15;
    this.engine.sceneManager.activeScene.physics.gravity = new Vector3(0, -GRAVITY, 0);
  }

  get count(): number { return this.map.dynBodies.length; }

  /** rebuild the static world colliders and attach a rigid body to every prop. Called
   *  after each map (re)load (the previous map's entities — and their colliders — were
   *  destroyed with the old map root). */
  syncFromMap(): void {
    if (this.staticRoot && !this.staticRoot.destroyed) this.staticRoot.destroy();
    this.staticRoot = this.root.createChild("phys-static");
    for (const s of this.map.solids) {
      const e = this.staticRoot.createChild("s");
      e.transform.setPosition((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
      const col = e.addComponent(StaticCollider);
      const shape = new BoxColliderShape();
      shape.size = new Vector3(Math.max(0.02, s.max.x - s.min.x), Math.max(0.02, s.max.y - s.min.y), Math.max(0.02, s.max.z - s.min.z));
      shape.material = this.mat;
      col.addShape(shape);
    }
    for (const b of this.map.dynBodies) this.attach(b);
    this.ensurePlayer();
  }

  /** give a prop body a PhysX dynamic collider matching its authored shape + its
   *  per-body physical tuning (grip / bounce / damping); each field falls back to the
   *  shared default when the author left it untouched. */
  private attach(b: DynBody): void {
    if (!b.entity || b.entity.destroyed) return;
    const col = b.entity.addComponent(DynamicCollider);
    let shape: ColliderShape;
    if (b.shape === "sphere") {
      const s = new SphereColliderShape();
      s.radius = Math.max(b.half.x, b.half.y, b.half.z);
      shape = s;
    } else if (b.shape === "cylinder") {
      const s = new CapsuleColliderShape();          // capsule ≈ an upright barrel that rolls
      s.radius = Math.max(0.02, Math.max(b.half.x, b.half.z));
      s.height = Math.max(0.02, b.half.y * 2 - s.radius * 2);
      shape = s;
    } else {
      const s = new BoxColliderShape();
      s.size = new Vector3(b.half.x * 2, b.half.y * 2, b.half.z * 2);
      shape = s;
    }
    shape.position = new Vector3(b.off.x, b.off.y, b.off.z);
    // a body only needs its own PhysicsMaterial when it overrides friction/bounce;
    // otherwise it shares the default one (fewer allocations, same behaviour).
    shape.material = (b.friction != null || b.restitution != null) ? this.bodyMaterial(b) : this.mat;
    col.addShape(shape);
    col.mass = Math.max(0.05, b.mass);
    col.linearDamping = b.linearDamping ?? PHYSICS_DEFAULTS.linearDamping;
    col.angularDamping = b.angularDamping ?? PHYSICS_DEFAULTS.angularDamping;   // let it roll but not spin forever
    b.collider = col;
  }

  /** a PhysicsMaterial carrying a body's authored friction / restitution (defaults for
   *  whichever field it left alone). Friction feeds both static + dynamic PhysX friction. */
  private bodyMaterial(b: DynBody): PhysicsMaterial {
    const m = new PhysicsMaterial();
    const f = b.friction ?? PHYSICS_DEFAULTS.friction;
    m.staticFriction = f;
    m.dynamicFriction = f;
    m.bounciness = b.restitution ?? PHYSICS_DEFAULTS.restitution;
    return m;
  }

  /** a kinematic capsule that tracks the local player so PhysX lets them shove props */
  private ensurePlayer(): void {
    if (this.playerE && !this.playerE.destroyed) return;
    const e = this.root.createChild("phys-player");
    const col = e.addComponent(DynamicCollider);
    col.isKinematic = true;
    const shape = new CapsuleColliderShape();
    shape.radius = MOVE.radius;
    shape.height = MOVE.height;
    shape.material = this.mat;
    col.addShape(shape);
    e.isActive = false;
    this.playerE = e; this.playerCol = col; this.playerShape = shape;
  }

  /** PhysX integrates in the engine loop; we only move the kinematic player capsule */
  step(_dt: number, player: PlayerBody | null): void {
    const e = this.playerE, col = this.playerCol, shape = this.playerShape;
    if (!e || !col || !shape) return;
    if (!player) { if (e.isActive) e.isActive = false; return; }
    if (!e.isActive) e.isActive = true;
    const h = player.height;
    shape.height = Math.max(0.3, h);
    this.tmp.set(player.pos.x, player.pos.y + h / 2, player.pos.z);
    col.move(this.tmp);   // kinematic follow (interpolated by PhysX)
  }

  applyImpulseAt(b: DynBody, point: Vec3, dir: Vec3, power: number): void {
    const c = b.collider; if (!c || !b.entity || b.entity.destroyed) return;
    c.wakeUp();
    const imp = power / Math.max(0.1, b.mass);
    const lv = c.linearVelocity;
    lv.x += dir.x * imp; lv.y += Math.max(0, dir.y) * imp + 0.3; lv.z += dir.z * imp;
    c.linearVelocity = lv;
    // torque = r × dir (r = impact point relative to the body centre) → topple/roll
    const wp = b.entity.transform.worldPosition;
    const rx = point.x - wp.x, ry = point.y - wp.y, rz = point.z - wp.z;
    const k = TORQUE_K / Math.max(0.1, b.mass);
    const av = c.angularVelocity;
    av.x += (ry * dir.z - rz * dir.y) * k;
    av.y += (rz * dir.x - rx * dir.z) * k;
    av.z += (rx * dir.y - ry * dir.x) * k;
    c.angularVelocity = av;
  }

  applyExplosion(center: Vec3, radius: number, power: number): void {
    for (const b of this.map.dynBodies) {
      const c = b.collider; if (!c || !b.entity || b.entity.destroyed) continue;
      const wp = b.entity.transform.worldPosition;
      const dx = wp.x - center.x, dy = wp.y - center.y, dz = wp.z - center.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      c.wakeUp();
      const fall = 1 - dist / radius;
      const inv = 1 / (dist || 1);
      let ux = dx * inv, uy = dy * inv + 0.6, uz = dz * inv;
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const j = (power * fall) / Math.max(0.1, b.mass);
      const lv = c.linearVelocity; lv.x += ux * j; lv.y += uy * j; lv.z += uz * j; c.linearVelocity = lv;
      const av = c.angularVelocity;
      av.x += (Math.random() * 2 - 1) * fall * 6;
      av.y += (Math.random() * 2 - 1) * fall * 6;
      av.z += (Math.random() * 2 - 1) * fall * 6;
      c.angularVelocity = av;
    }
  }

  /** nearest prop a ray hits (AABB around its live world pose — good enough for a
   *  bullet test; PhysX owns the real contact simulation). */
  raycast(o: Vec3, d: Vec3, maxDist: number): { body: DynBody; dist: number } | null {
    let best = maxDist; let hit: DynBody | null = null;
    for (const b of this.map.dynBodies) {
      if (!b.entity || b.entity.destroyed) continue;
      const wp = b.entity.transform.worldPosition;
      const cx = wp.x + b.off.x, cy = wp.y + b.off.y, cz = wp.z + b.off.z;
      const box = {
        min: { x: cx - b.half.x, y: cy - b.half.y, z: cz - b.half.z },
        max: { x: cx + b.half.x, y: cy + b.half.y, z: cz + b.half.z },
      };
      const h = rayAABB(o, d, box, best);
      if (h) { best = h.dist; hit = b; }
    }
    return hit ? { body: hit, dist: best } : null;
  }
}

/** try to create a PhysX-backed engine (self-hosted runtime, no CDN). Returns the
 *  engine + true on success; on any failure (WASM blocked, unsupported) it falls back
 *  to a plain engine + false, so the game always runs — just with the custom sim. */
export async function createGameEngine(canvasId: string): Promise<{ engine: WebGLEngine; physx: boolean }> {
  const base = import.meta.env.BASE_URL;
  try {
    const { PhysXPhysics, PhysXRuntimeMode } = await import("@galacean/engine-physics-physx");
    const physics = new PhysXPhysics(PhysXRuntimeMode.Auto, {
      wasmModeUrl: `${base}physx/physx.release.js`,
      javaScriptModeUrl: `${base}physx/physx.release.downgrade.js`,
    });
    const engine = await WebGLEngine.create({ canvas: canvasId, physics });
    return { engine, physx: true };
  } catch (e) {
    console.warn("[physics] PhysX unavailable — using the lightweight fallback sim", e);
    const engine = await WebGLEngine.create({ canvas: canvasId });
    return { engine, physx: false };
  }
}
