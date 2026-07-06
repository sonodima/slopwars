// ─── Local player: quake-style movement, bhop, AABB collision, stairs ───────
import { GameMap } from "./map";
import { MOVE, Vec3, clamp } from "./types";

export interface Input {
  fwd: number; // -1..1
  right: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
}

export class PlayerBody {
  pos: Vec3 = { x: 0, y: 0, z: 0 }; // feet
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0; // rad
  pitch = 0;
  onGround = false;
  crouched = false;
  private wasOnGround = false;
  landed = false; // set true for one frame on landing
  jumped = false;
  gravityScale = 1; // host match-rule gravity multiplier

  constructor(private map: GameMap) {}

  get eyeY(): number { return this.pos.y + (this.crouched ? MOVE.eyeCrouch : MOVE.eyeHeight); }
  get height(): number { return this.crouched ? MOVE.crouchHeight : MOVE.height; }

  teleport(p: Vec3, yaw: number): void {
    this.pos = { ...p };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = (yaw * Math.PI) / 180;
    this.pitch = 0;
  }

  update(dt: number, inp: Input, speedFactor: number): void {
    dt = Math.min(dt, 0.05);
    this.landed = false;
    this.jumped = false;

    // crouch (only stand up if room)
    if (inp.crouch) this.crouched = true;
    else if (this.crouched && !this.collides(this.pos, MOVE.height)) this.crouched = false;

    // wish direction in world space
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let wx = -s * inp.fwd + c * inp.right;
    let wz = -c * inp.fwd - s * inp.right;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-5) { wx /= wl; wz /= wl; }

    const sprint = inp.sprint && !this.crouched ? MOVE.sprintFactor : 1;
    const maxSpeed = MOVE.groundSpeed * speedFactor * (this.crouched ? MOVE.crouchFactor : 1) * sprint;

    if (this.onGround) {
      if (inp.jump) {
        // bhop: no friction on jump frame
        this.vel.y = MOVE.jumpVel;
        this.onGround = false;
        this.jumped = true;
        this.airAccel(wx, wz, maxSpeed, dt);
      } else {
        this.friction(dt);
        this.groundAccel(wx, wz, wl > 0 ? maxSpeed : 0, dt);
      }
    } else {
      this.airAccel(wx, wz, maxSpeed, dt);
    }

    this.vel.y -= MOVE.gravity * this.gravityScale * dt;

    this.move(dt);

    if (!this.wasOnGround && this.onGround) this.landed = true;
    this.wasOnGround = this.onGround;

    if (this.pos.y < -30) this.pos.y = 20; // failsafe
  }

  horizontalSpeed(): number { return Math.hypot(this.vel.x, this.vel.z); }

  private friction(dt: number): void {
    const sp = this.horizontalSpeed();
    if (sp < 1e-4) { this.vel.x = 0; this.vel.z = 0; return; }
    const control = Math.max(sp, MOVE.stopSpeed);
    const drop = control * MOVE.friction * dt;
    const ns = Math.max(0, sp - drop) / sp;
    this.vel.x *= ns; this.vel.z *= ns;
  }

  private groundAccel(wx: number, wz: number, wishSpeed: number, dt: number): void {
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const acc = Math.min(MOVE.groundAccel * wishSpeed * dt, add);
    this.vel.x += wx * acc; this.vel.z += wz * acc;
  }

  private airAccel(wx: number, wz: number, wishSpeed: number, dt: number): void {
    const capped = Math.min(wishSpeed, MOVE.airWishCap);
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = capped - cur;
    if (add <= 0) return;
    const acc = Math.min(MOVE.airAccel * wishSpeed * dt, add);
    this.vel.x += wx * acc; this.vel.z += wz * acc;
  }

  // ── collision: axis-separated AABB sweep with step-up ──
  private move(dt: number): void {
    const h = this.height;
    const p = this.pos;

    // Y
    const oldY = p.y;
    p.y += this.vel.y * dt;
    if (this.vel.y <= 0) {
      const gy = this.groundHeight(p, h, oldY);
      if (gy !== null && p.y <= gy) { p.y = gy; this.vel.y = 0; this.onGround = true; }
      else this.onGround = false;
    } else {
      const cy = this.ceilY(p, h);
      if (cy !== null && p.y + h >= cy) { p.y = cy - h; this.vel.y = 0; }
      this.onGround = false;
    }

    // X then Z with step-up
    this.moveAxis(p, "x", this.vel.x * dt, h);
    this.moveAxis(p, "z", this.vel.z * dt, h);
  }

  private moveAxis(p: Vec3, axis: "x" | "z", delta: number, h: number): void {
    if (Math.abs(delta) < 1e-8) return;
    const next = { ...p };
    next[axis] += delta;
    if (!this.collides(next, h)) { p[axis] = next[axis]; return; }
    // try step up
    if (this.onGround) {
      const stepped = { ...next, y: next.y + MOVE.stepHeight };
      if (!this.collides(stepped, h)) {
        // snap down onto the step: highest top in (y, y+step]
        const r = MOVE.radius;
        let gy: number | null = null;
        for (const b of this.map.solids) {
          if (next.x + r > b.min.x && next.x - r < b.max.x && next.z + r > b.min.z && next.z - r < b.max.z) {
            const top = b.max.y;
            if (top > next.y && top <= next.y + MOVE.stepHeight + 0.001 && (gy === null || top > gy)) gy = top;
          }
        }
        if (gy !== null) { p[axis] = next[axis]; p.y = gy; return; }
      }
    }
    // slide: kill velocity on this axis
    if (axis === "x") this.vel.x = 0; else this.vel.z = 0;
  }

  private collides(p: Vec3, h: number): boolean {
    const r = MOVE.radius;
    for (const b of this.map.solids) {
      if (
        p.x + r > b.min.x && p.x - r < b.max.x &&
        p.y + h > b.min.y + 0.001 && p.y < b.max.y - 0.001 &&
        p.z + r > b.min.z && p.z - r < b.max.z
      ) return true;
    }
    return false;
  }

  /** highest solid top under/at the player within snap range */
  private groundHeight(p: Vec3, h: number, fromY?: number): number | null {
    const r = MOVE.radius;
    const hi = (fromY ?? p.y) + 0.35;
    let best: number | null = null;
    for (const b of this.map.solids) {
      if (p.x + r > b.min.x && p.x - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z) {
        const top = b.max.y;
        if (top <= hi && top >= p.y - 0.001 && b.min.y < p.y + h) {
          if (best === null || top > best) best = top;
        }
      }
    }
    return best;
  }

  private ceilY(p: Vec3, h: number): number | null {
    const r = MOVE.radius;
    let best: number | null = null;
    for (const b of this.map.solids) {
      if (p.x + r > b.min.x && p.x - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z) {
        const bot = b.min.y;
        if (bot >= p.y + h - 0.3 && (best === null || bot < best)) best = bot;
      }
    }
    return best;
  }

  look(dx: number, dy: number, sens: number): void {
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.55, 1.55);
  }

  aimDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }
}
