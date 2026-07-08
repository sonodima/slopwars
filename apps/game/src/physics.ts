// ─── PhysicsWorld: lightweight rigid-body simulation for dynamic props ────────
// Simulates the map's `DynBody` props (see map.ts / objects.ts `prop` with physics
// on): gravity, collision + resting against the static world, and impulses from
// bullets, explosions and the local player walking into them. Each body is an
// axis-aligned box collider (its authored shape only rounds how the player brushes
// past it) resolved axis-by-axis, the same scheme the player uses — cheap, stable,
// and good enough for shovable crates/barrels/cans.
//
// Simulation is client-local: every client integrates its own props, so it needs no
// network protocol. Props carry no damage and never gate gameplay, so small drift
// between clients is cosmetic. (A host-authoritative sync is the natural follow-up.)
import { GameMap, DynBody, rayAABB } from "./map";
import { PlayerBody } from "./player";
import { MOVE, Vec3 } from "./types";

const GRAVITY = 20;          // m/s² (matches the player's feel)
const REST_VEL = 0.25;       // below this speed a grounded body is "still"
const SLEEP_AFTER = 0.5;     // s of stillness → sleep (stops micro-jitter)
const LINEAR_DAMP = 0.35;    // air drag (per second)
const GROUND_FRICTION = 7;   // horizontal friction while resting on a surface
const RESTITUTION = 0.3;     // bounciness off static geometry
const SPIN_DAMP = 2.5;       // yaw-spin decay (per second)
const PLAYER_MASS = 82;      // reference mass the player pushes with

type Axis = "x" | "y" | "z";

export class PhysicsWorld {
  constructor(private map: GameMap) {}

  get count(): number { return this.map.dynBodies.length; }

  /** advance every dynamic body one frame. `player`, if given, can shove (and be
   *  blocked by) bodies it overlaps — the "walk into a crate to push it" case. */
  step(dt: number, player: PlayerBody | null): void {
    const bodies = this.map.dynBodies;
    if (!bodies.length) return;
    dt = Math.min(dt, 0.05);
    for (const b of bodies) {
      if (!b.entity || b.entity.destroyed) continue;
      const asleep = b.rest > SLEEP_AFTER && b.onGround;
      if (!asleep) {
        b.vel.y -= GRAVITY * dt;
        const damp = Math.exp(-LINEAR_DAMP * dt);
        b.vel.x *= damp; b.vel.z *= damp;
        this.integrate(b, dt);
        b.yaw += b.yawVel * dt;
        b.yawVel *= Math.exp(-SPIN_DAMP * dt);
      }
      if (player) this.playerPush(b, player);
      // rest / sleep bookkeeping
      const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      if (sp < REST_VEL && b.onGround) b.rest += dt; else b.rest = 0;
      if (b.rest > SLEEP_AFTER) { b.vel.x = b.vel.y = b.vel.z = 0; b.yawVel = 0; }
      this.sync(b);
    }
  }

  /** per-axis integration against the static world: fall/rest vertically on the
   *  nearest supporting surface, bounce off walls horizontally. */
  private integrate(b: DynBody, dt: number): void {
    // ── vertical: rest on the highest support beneath the footprint ──
    b.onGround = false;
    const ny = b.pos.y + b.vel.y * dt;
    if (b.vel.y <= 0) {
      const top = this.supportTop(b);
      const restY = top !== null ? top - b.off.y + b.half.y : null;   // pos.y so the collider bottom sits on `top`
      if (restY !== null && ny <= restY) {
        b.pos.y = restY;
        if (b.vel.y < -1.2) b.vel.y = -b.vel.y * RESTITUTION; else { b.vel.y = 0; b.onGround = true; }
      } else b.pos.y = ny;
    } else {
      const bot = this.ceilingBottom(b);
      const capY = bot !== null ? bot - b.off.y - b.half.y : null;
      if (capY !== null && ny >= capY) { b.pos.y = capY; b.vel.y = -b.vel.y * RESTITUTION; } else b.pos.y = ny;
    }
    if (b.onGround) { const f = Math.max(0, 1 - GROUND_FRICTION * dt); b.vel.x *= f; b.vel.z *= f; }

    // ── horizontal: attempt, and bounce back if it would tunnel into a wall ──
    this.moveHoriz(b, "x", dt);
    this.moveHoriz(b, "z", dt);
  }

  private moveHoriz(b: DynBody, axis: Axis, dt: number): void {
    const v = axis === "x" ? b.vel.x : b.vel.z;
    if (Math.abs(v) < 1e-6) return;
    const prev = b.pos[axis];
    b.pos[axis] = prev + v * dt;
    if (this.overlapsWorld(b)) {
      b.pos[axis] = prev;                       // reject the move
      if (axis === "x") b.vel.x = -b.vel.x * RESTITUTION; else b.vel.z = -b.vel.z * RESTITUTION;
    }
  }

  /** highest solid top at or below the body's footprint (its potential support). No
   *  distance window, so a body only lands when a single frame's fall actually crosses
   *  the surface — fast drops can't tunnel through thin floors. */
  private supportTop(b: DynBody): number | null {
    const cx = b.pos.x + b.off.x, cz = b.pos.z + b.off.z;
    const bottom = b.pos.y + b.off.y - b.half.y;
    let top: number | null = null;
    for (const s of this.map.solids) {
      if (cx + b.half.x > s.min.x && cx - b.half.x < s.max.x && cz + b.half.z > s.min.z && cz - b.half.z < s.max.z) {
        if (s.max.y <= bottom + 0.05 && (top === null || s.max.y > top)) top = s.max.y;
      }
    }
    return top;
  }

  /** lowest solid bottom at or above the body's top (its potential ceiling) */
  private ceilingBottom(b: DynBody): number | null {
    const cx = b.pos.x + b.off.x, cz = b.pos.z + b.off.z;
    const topY = b.pos.y + b.off.y + b.half.y;
    let bot: number | null = null;
    for (const s of this.map.solids) {
      if (cx + b.half.x > s.min.x && cx - b.half.x < s.max.x && cz + b.half.z > s.min.z && cz - b.half.z < s.max.z) {
        if (s.min.y >= topY - 0.05 && (bot === null || s.min.y < bot)) bot = s.min.y;
      }
    }
    return bot;
  }

  /** does the body's collider box currently overlap any static solid? (AABB — a
   *  shaped solid uses its bounds here; the rounding matters for the player, not for
   *  body-vs-wall.) A little vertical inset avoids catching the floor it rests on. */
  private overlapsWorld(b: DynBody): boolean {
    const cx = b.pos.x + b.off.x, cy = b.pos.y + b.off.y, cz = b.pos.z + b.off.z;
    for (const s of this.map.solids) {
      if (cx + b.half.x > s.min.x && cx - b.half.x < s.max.x &&
          cy + b.half.y > s.min.y + 0.05 && cy - b.half.y < s.max.y - 0.05 &&
          cz + b.half.z > s.min.z && cz - b.half.z < s.max.z) return true;
    }
    return false;
  }

  /** resolve overlap between the local player's capsule and a body: shove the body
   *  (more if it's light), push the player out (more if it's heavy), and hand the
   *  player's approach speed to the body. Momentum-weighted so a 5 kg crate slides
   *  away while a 200 kg block feels like a wall. */
  private playerPush(b: DynBody, player: PlayerBody): void {
    const cx = b.pos.x + b.off.x, cy = b.pos.y + b.off.y, cz = b.pos.z + b.off.z;
    const py = player.pos.y, ph = player.height;
    if (py > cy + b.half.y || py + ph < cy - b.half.y) return;   // no vertical overlap
    const bodyR = Math.max(b.half.x, b.half.z);
    const r = MOVE.radius;
    let dx = cx - player.pos.x, dz = cz - player.pos.z;
    let dist = Math.hypot(dx, dz);
    const minDist = r + bodyR;
    if (dist >= minDist) return;
    if (dist < 1e-4) { dx = -Math.sin(player.yaw); dz = -Math.cos(player.yaw); dist = 1e-4; }
    const nx = dx / dist, nz = dz / dist;         // player → body
    const pen = minDist - dist;
    const fb = PLAYER_MASS / (PLAYER_MASS + b.mass);   // body's share of the correction
    const fp = b.mass / (PLAYER_MASS + b.mass);        // player's share
    b.pos.x += nx * pen * fb; b.pos.z += nz * pen * fb;
    player.pos.x -= nx * pen * fp; player.pos.z -= nz * pen * fp;
    const approach = player.vel.x * nx + player.vel.z * nz;   // player speed toward the body
    if (approach > 0) { b.vel.x += nx * approach * fb; b.vel.z += nz * approach * fb; }
    b.rest = 0; b.onGround = b.onGround && b.mass > PLAYER_MASS;
  }

  /** an area blast (grenade / barrel): shove every body within `radius` outward and
   *  up, scaled by falloff and inverse mass, with a bit of random tumble. */
  applyExplosion(c: Vec3, radius: number, power: number): void {
    for (const b of this.map.dynBodies) {
      const cx = b.pos.x + b.off.x, cy = b.pos.y + b.off.y, cz = b.pos.z + b.off.z;
      const dx = cx - c.x, dy = cy - c.y, dz = cz - c.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      const fall = 1 - dist / radius;
      const inv = 1 / (dist || 1);
      let ux = dx * inv, uy = dy * inv + 0.65, uz = dz * inv;   // upward bias so props pop
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const j = (power * fall) / b.mass;
      b.vel.x += ux * j; b.vel.y += uy * j; b.vel.z += uz * j;
      b.yawVel += (Math.random() * 2 - 1) * fall * 5;
      b.rest = 0; b.onGround = false;
    }
  }

  /** a bullet impact at `point` travelling `dir`: nudge the body along the shot with
   *  a small lift + off-centre spin. */
  applyImpulseAt(b: DynBody, point: Vec3, dir: Vec3, power: number): void {
    const j = power / b.mass;
    b.vel.x += dir.x * j; b.vel.y += Math.max(0, dir.y) * j + 0.35; b.vel.z += dir.z * j;
    const cx = b.pos.x + b.off.x, cz = b.pos.z + b.off.z;
    b.yawVel += ((point.x - cx) * dir.z - (point.z - cz) * dir.x) * 2.2;
    b.rest = 0; b.onGround = false;
  }

  /** nearest dynamic body a ray hits within `maxDist` (its collider box), or null */
  raycast(o: Vec3, d: Vec3, maxDist: number): { body: DynBody; dist: number } | null {
    let best = maxDist; let hit: DynBody | null = null;
    for (const b of this.map.dynBodies) {
      if (!b.entity || b.entity.destroyed) continue;
      const box = {
        min: { x: b.pos.x + b.off.x - b.half.x, y: b.pos.y + b.off.y - b.half.y, z: b.pos.z + b.off.z - b.half.z },
        max: { x: b.pos.x + b.off.x + b.half.x, y: b.pos.y + b.off.y + b.half.y, z: b.pos.z + b.off.z + b.half.z },
      };
      const h = rayAABB(o, d, box, best);
      if (h) { best = h.dist; hit = b; }
    }
    return hit ? { body: hit, dist: best } : null;
  }

  /** write a body's simulated transform back onto its entity (yaw-only visual) */
  private sync(b: DynBody): void {
    if (!b.entity || b.entity.destroyed) return;
    b.entity.transform.setPosition(b.pos.x, b.pos.y, b.pos.z);
    b.entity.transform.setRotation(0, b.baseYaw + (b.yaw * 180) / Math.PI, 0);
  }
}
