// ─── Grenades: fixed-step bounce physics, explosion & fire FX ────────────────
import {
  Color, Engine, Entity, MeshRenderer, PointLight, PrimitiveMesh, UnlitMaterial,
} from "@galacean/engine";
import { GameMap } from "./map";
import { Vec3, rand } from "./types";

export type NadeKind = "he" | "mol";

export const HE_RADIUS = 7;
export const HE_DAMAGE = 92;
export const HE_FUSE = 1.7;
export const MOL_RADIUS = 3.2;
export const MOL_DURATION = 6.5;
export const MOL_TICK = 0.5;
export const MOL_TICK_DMG = 12;

const R = 0.12; // projectile radius
const STEP = 1 / 60;

interface Nade {
  kind: NadeKind;
  owner: string;
  local: boolean; // this client owns damage
  pos: Vec3;
  vel: Vec3;
  fuse: number;
  life: number;
  entity: Entity;
  spin: number;
}

interface Flame { e: Entity; base: number; ox: number; oz: number }

interface Fire {
  center: Vec3;
  owner: string;
  local: boolean;
  until: number;
  nextDmg: number;
  flames: Flame[];
  light: PointLight;
  root: Entity;
}

interface Fx { e: Entity; ttl: number; max: number; vel?: Vec3; grow: number }

export class Projectiles {
  onExplode: ((center: Vec3, owner: string, local: boolean) => void) | null = null;
  onFireTick: ((center: Vec3, owner: string, local: boolean) => void) | null = null;
  onBounce: ((p: Vec3) => void) | null = null;
  onBreak: ((p: Vec3) => void) | null = null;
  onBoom: ((p: Vec3) => void) | null = null;
  onIgnite: ((p: Vec3, dur: number) => void) | null = null;

  private nades: Nade[] = [];
  private fires: Fire[] = [];
  private fx: Fx[] = [];
  private root: Entity;
  private acc = 0;

  private mHe: UnlitMaterial;
  private mMol: UnlitMaterial;
  private mFlash: UnlitMaterial;
  private mSmoke: UnlitMaterial;
  private mFlame: UnlitMaterial;
  private mFlame2: UnlitMaterial;

  constructor(private engine: Engine, parent: Entity, private map: GameMap) {
    this.root = parent.createChild("nades");
    this.mHe = this.unlit(0.12, 0.16, 0.1);
    this.mMol = this.unlit(0.7, 0.4, 0.12);
    this.mFlash = this.unlit(7, 3.6, 0.9);
    this.mSmoke = this.unlit(0.32, 0.3, 0.27);
    this.mFlame = this.unlit(4.5, 1.6, 0.25);
    this.mFlame2 = this.unlit(5, 3, 0.5);
  }

  private unlit(r: number, g: number, b: number): UnlitMaterial {
    const m = new UnlitMaterial(this.engine);
    m.baseColor = new Color(r, g, b, 1);
    return m;
  }

  private sphere(mat: UnlitMaterial, radius: number, seg = 8): Entity {
    const e = this.root.createChild("s");
    const mr = e.addComponent(MeshRenderer);
    mr.mesh = PrimitiveMesh.createSphere(this.engine, radius, seg);
    mr.setMaterial(mat);
    return e;
  }

  throw_(kind: NadeKind, o: Vec3, v: Vec3, owner: string, local: boolean): void {
    const entity = this.sphere(kind === "he" ? this.mHe : this.mMol, kind === "he" ? 0.11 : 0.13);
    entity.transform.setPosition(o.x, o.y, o.z);
    this.nades.push({
      kind, owner, local,
      pos: { ...o }, vel: { ...v },
      fuse: kind === "he" ? HE_FUSE : 5, life: 0,
      entity, spin: rand(0, 6),
    });
  }

  update(dt: number, now: number): void {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.stepNades(now);
    }
    for (const n of this.nades) {
      n.spin += dt * 9;
      n.entity.transform.setPosition(n.pos.x, n.pos.y, n.pos.z);
      n.entity.transform.setRotation(n.spin * 57, n.spin * 40, 0);
    }
    this.updateFires(now);
    this.updateFx(dt);
  }

  private stepNades(now: number): void {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      n.life += STEP;
      n.fuse -= STEP;
      n.vel.y -= 14 * STEP;

      let bounced = false;
      // per-axis move + reflect
      for (const ax of ["x", "y", "z"] as const) {
        const next = n.pos[ax] + n.vel[ax] * STEP;
        const test = { ...n.pos, [ax]: next };
        if (this.hitSolid(test) || (ax === "y" && next < R)) {
          n.vel[ax] *= -0.42;
          if (ax !== "y") n.vel[ax] *= 0.9;
          else { n.vel.x *= 0.72; n.vel.z *= 0.72; } // ground friction
          bounced = true;
        } else n.pos[ax] = next;
      }
      if (n.pos.y < R) n.pos.y = R;

      const speed = Math.hypot(n.vel.x, n.vel.y, n.vel.z);
      if (bounced) {
        if (n.kind === "mol") { this.breakMol(n, now); this.nades.splice(i, 1); continue; }
        if (speed > 2.5) this.onBounce?.(n.pos);
      }
      if (n.fuse <= 0 || n.life > 8) {
        if (n.kind === "he") this.explodeHE(n);
        else this.breakMol(n, now);
        this.nades.splice(i, 1);
      }
    }
  }

  private hitSolid(p: Vec3): boolean {
    for (const b of this.map.solids) {
      if (
        p.x + R > b.min.x && p.x - R < b.max.x &&
        p.y + R > b.min.y && p.y - R < b.max.y &&
        p.z + R > b.min.z && p.z - R < b.max.z
      ) return true;
    }
    return false;
  }

  // ── HE ──
  private explodeHE(n: Nade): void {
    n.entity.destroy();
    this.explodeFx(n.pos);
    this.onExplode?.(n.pos, n.owner, n.local);
  }

  /** explosion visuals + boom at a point (grenade or barrel); no damage/authority */
  explodeFx(c: Vec3): void {
    this.addFx(this.sphere(this.mFlash, 1.2, 12), c, 0.20, 11);     // white-hot flash core
    this.addFx(this.sphere(this.mFlame2, 0.7, 12), c, 0.34, 17);    // expanding fireball
    this.addFx(this.sphere(this.mFlame, 0.5, 10), c, 0.44, 13);     // inner flame
    for (let k = 0; k < 12; k++) {                                  // smoke plume
      const e = this.sphere(this.mSmoke, rand(0.3, 0.6), 6);
      this.addFx(e, c, rand(0.8, 1.7), 1.9, { x: rand(-3.5, 3.5), y: rand(1.2, 5), z: rand(-3.5, 3.5) });
    }
    for (let k = 0; k < 10; k++) {                                  // flying embers
      const e = this.sphere(this.mFlame, rand(0.04, 0.09), 5);
      this.addFx(e, c, rand(0.5, 1.1), 0.4, { x: rand(-6, 6), y: rand(2, 7), z: rand(-6, 6) });
    }
    const le = this.root.createChild("boom-l");                    // light pop
    le.transform.setPosition(c.x, c.y + 0.5, c.z);
    const l = le.addComponent(PointLight);
    l.color = new Color(1.5, 0.95, 0.45, 1);
    l.distance = 18;
    window.setTimeout(() => le.destroy(), 140);
    this.onBoom?.(c);
  }

  // ── molotov ──
  private breakMol(n: Nade, now: number): void {
    n.entity.destroy();
    const c = { x: n.pos.x, y: this.map.floorY(n.pos.x, n.pos.z) + 0.05, z: n.pos.z };
    this.onBreak?.(n.pos);
    this.onIgnite?.(c, MOL_DURATION);

    const root = this.root.createChild("fire");
    const flames: Flame[] = [];
    for (let k = 0; k < 12; k++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * (MOL_RADIUS - 0.4);
      const e = this.sphere(k % 3 ? this.mFlame : this.mFlame2, rand(0.16, 0.34), 6);
      flames.push({ e, base: rand(0.6, 1.3), ox: c.x + Math.cos(a) * r, oz: c.z + Math.sin(a) * r });
    }
    const le = root.createChild("l");
    le.transform.setPosition(c.x, c.y + 0.8, c.z);
    const light = le.addComponent(PointLight);
    light.color = new Color(1.2, 0.55, 0.15, 1);
    light.distance = 12;

    this.fires.push({ center: c, owner: n.owner, local: n.local, until: now + MOL_DURATION, nextDmg: now + 0.3, flames, light, root });
  }

  private updateFires(now: number): void {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      const left = f.until - now;
      if (left <= 0) {
        for (const fl of f.flames) fl.e.destroy();
        f.root.destroy();
        this.fires.splice(i, 1);
        continue;
      }
      const dampen = Math.min(1, left / 1.5);
      const t = now * 13;
      for (let k = 0; k < f.flames.length; k++) {
        const fl = f.flames[k];
        const s = fl.base * dampen * (0.65 + 0.4 * Math.abs(Math.sin(t + k * 1.7)));
        fl.e.transform.setScale(s, s * rand(1.2, 1.7), s);
        fl.e.transform.setPosition(fl.ox + Math.sin(t * 0.4 + k) * 0.07, f.center.y + 0.25 + s * 0.3, fl.oz + Math.cos(t * 0.5 + k * 2) * 0.07);
      }
      f.light.distance = 10 + Math.sin(t) * 2;
      if (now >= f.nextDmg) {
        f.nextDmg = now + MOL_TICK;
        this.onFireTick?.(f.center, f.owner, f.local);
      }
    }
  }

  private addFx(e: Entity, p: Vec3, ttl: number, grow: number, vel?: Vec3): void {
    e.transform.setPosition(p.x, p.y, p.z);
    e.transform.setScale(0.4, 0.4, 0.4);
    this.fx.push({ e, ttl, max: ttl, vel, grow });
  }

  private updateFx(dt: number): void {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { f.e.destroy(); this.fx.splice(i, 1); continue; }
      const k = 1 - f.ttl / f.max;
      const s = 0.4 + f.grow * k * (1 - k * 0.4);
      f.e.transform.setScale(s, s, s);
      if (f.vel) {
        const p = f.e.transform.position;
        f.e.transform.setPosition(p.x + f.vel.x * dt, p.y + f.vel.y * dt, p.z + f.vel.z * dt);
        f.vel.y += 1.2 * dt;
      }
    }
  }
}
