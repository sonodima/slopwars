// ─── Grenades: fixed-step bounce physics, explosion & fire FX ────────────────
import {
  Color, Engine, Entity, MeshRenderer, PointLight, PrimitiveMesh, UnlitMaterial,
} from "@galacean/engine";
import { GameMap } from "./map";
import { buildParticles } from "./particles";
import { Vec3, rand } from "./types";
import { GameModels, instantiate, modelMetaOf } from "./models";
import { MaterialLibrary, shadeModelSlots } from "./materials";

export type NadeKind = "he" | "mol";

/** the catalog model each thrown projectile is rendered as — the SAME models the
 *  player holds for that weapon, so the grenade you throw is the grenade in your hand.
 *  A missing model falls back to a plain coloured sphere so throwing never breaks. */
const NADE_MODEL: Record<NadeKind, string> = { he: "wep_frag", mol: "wep_molotov" };

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

interface Fire {
  center: Vec3;
  owner: string;
  local: boolean;
  until: number;
  nextDmg: number;
  light: PointLight;
  root: Entity;
}

interface Fx { e: Entity; ttl: number; max: number; vel?: Vec3; grow: number; base: number }

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

  // material library for the thrown-grenade models, handed over once weapon textures are
  // ready (the models themselves are passed at construction). A grenade thrown before the
  // library loads shows the model unshaded for its brief life; by match time it's ready.
  private matLib: MaterialLibrary | null = null;

  private mHe: UnlitMaterial;
  private mMol: UnlitMaterial;
  private mFlash: UnlitMaterial;
  private mSmoke: UnlitMaterial;
  private mFlame: UnlitMaterial;
  private mFlame2: UnlitMaterial;

  // one reusable blast light, toggled per explosion instead of created/destroyed —
  // a changing scene light count forces shader-variant recompiles (a real hitch), so
  // keeping one persistent light avoids that churn on every barrel/grenade blast.
  private boomLightE: Entity;
  private boomLight: PointLight;
  private boomToken = 0;

  constructor(private engine: Engine, parent: Entity, private map: GameMap, private models: GameModels) {
    this.root = parent.createChild("nades");
    this.mHe = this.unlit(0.12, 0.16, 0.1);
    this.mMol = this.unlit(0.7, 0.4, 0.12);
    this.mFlash = this.unlit(7, 3.6, 0.9);
    this.mSmoke = this.unlit(0.32, 0.3, 0.27);
    this.mFlame = this.unlit(4.5, 1.6, 0.25);
    this.mFlame2 = this.unlit(5, 3, 0.5);
    this.boomLightE = this.root.createChild("boom-l");
    this.boomLight = this.boomLightE.addComponent(PointLight);
    this.boomLight.color = new Color(1.5, 0.95, 0.45, 1);
    this.boomLight.distance = 18;
    this.boomLightE.isActive = false;
  }

  private unlit(r: number, g: number, b: number): UnlitMaterial {
    const m = new UnlitMaterial(this.engine);
    m.baseColor = new Color(r, g, b, 1);
    return m;
  }

  // One shared unit sphere per segment tier. Explosions/impacts used to build a
  // fresh sphere *mesh* per fragment (~24 for an explosion) — each a new GPU
  // buffer upload, which is exactly the brief freeze on a barrel/grenade blast.
  // Reusing a radius-1 mesh (sized via the entity's scale) makes a blast allocate
  // zero geometry.
  private sphereMeshes = new Map<number, ReturnType<typeof PrimitiveMesh.createSphere>>();
  private unitSphere(seg: number): ReturnType<typeof PrimitiveMesh.createSphere> {
    let m = this.sphereMeshes.get(seg);
    if (!m) { m = PrimitiveMesh.createSphere(this.engine, 1, seg); this.sphereMeshes.set(seg, m); }
    return m;
  }

  // Pool of short-lived FX sphere entities. A blast spawns ~24 of them; creating +
  // destroying that many entities/renderers every explosion is the remaining hitch
  // now the mesh upload is gone. We reuse deactivated ones, reconfiguring the mesh +
  // material on acquire, so a blast allocates (near) nothing after the first.
  private fxPool: Entity[] = [];
  private acquireSphere(mat: UnlitMaterial, radius: number, seg: number): Entity {
    const e = this.fxPool.pop() ?? this.root.createChild("fx");
    let mr = e.getComponent(MeshRenderer);
    if (!mr) mr = e.addComponent(MeshRenderer);
    mr.mesh = this.unitSphere(seg);
    mr.setMaterial(mat);
    e.isActive = true;
    e.transform.setScale(radius, radius, radius);
    return e;
  }
  private releaseSphere(e: Entity): void { e.isActive = false; this.fxPool.push(e); }

  /** supply the material library that shades the thrown-grenade models (loads async,
   *  after the models are already in hand). */
  setMaterialLibrary(lib: MaterialLibrary): void { this.matLib = lib; }

  /** the thrown projectile's visual: the weapon's actual model, scaled + shaded by its
   *  meta (shading applied once the material library is available). */
  private nadeVisual(kind: NadeKind): Entity {
    const folder = NADE_MODEL[kind];
    const m = instantiate(this.models[folder]);
    // a weapon model that failed to load leaves an empty carrier so physics still runs
    // (it just isn't visible) — never a stand-in sphere.
    if (!m) return this.root.createChild("nade");
    const meta = modelMetaOf(folder);
    const s = meta.scale ?? 1;
    m.transform.setScale(s, s, s);
    if (this.matLib) shadeModelSlots(m, meta, this.matLib);
    this.root.addChild(m);
    return m;
  }

  throw_(kind: NadeKind, o: Vec3, v: Vec3, owner: string, local: boolean): void {
    const entity = this.nadeVisual(kind);
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
    this.addFx(this.acquireSphere(this.mFlash, 1.2, 12), c, 0.20, 11);   // white-hot flash core
    this.addFx(this.acquireSphere(this.mFlame2, 0.7, 12), c, 0.34, 17);  // expanding fireball
    this.addFx(this.acquireSphere(this.mFlame, 0.5, 10), c, 0.44, 13);   // inner flame
    for (let k = 0; k < 12; k++) {                                       // smoke plume
      const e = this.acquireSphere(this.mSmoke, rand(0.3, 0.6), 6);
      this.addFx(e, c, rand(0.8, 1.7), 1.9, { x: rand(-3.5, 3.5), y: rand(1.2, 5), z: rand(-3.5, 3.5) });
    }
    for (let k = 0; k < 10; k++) {                                       // flying embers
      const e = this.acquireSphere(this.mFlame, rand(0.04, 0.09), 5);
      this.addFx(e, c, rand(0.5, 1.1), 0.4, { x: rand(-6, 6), y: rand(2, 7), z: rand(-6, 6) });
    }
    // reuse the single blast light (toggled, not created) — see constructor
    this.boomLightE.transform.setPosition(c.x, c.y + 0.5, c.z);
    this.boomLight.distance = 18;
    this.boomLightE.isActive = true;
    const tok = ++this.boomToken;
    window.setTimeout(() => { if (tok === this.boomToken) this.boomLightE.isActive = false; }, 140);
    this.onBoom?.(c);
  }

  /** Pre-compile every explosion / molotov FX shader + upload its sphere meshes during
   *  the loading screen, so the first blast doesn't stall on shader compilation and
   *  first-time GPU mesh uploads. Renders one of each (material, segment-tier) sphere
   *  plus an additive + a normal particle emitter far underground for a few frames,
   *  then tears them down. No sound / damage / physics — visuals only, unseen. The
   *  blast PointLight's shader permutation is warmed by the weapon flash prewarm (both
   *  are +1 point light), so it isn't toggled here. */
  prewarm(): void {
    const c = { x: 0, y: -120, z: 0 };
    const combos: [UnlitMaterial, number, number][] = [
      [this.mFlash, 1.2, 12], [this.mFlame2, 0.7, 12], [this.mFlame, 0.5, 10],
      [this.mSmoke, 0.5, 6], [this.mHe, 0.12, 8], [this.mMol, 0.12, 8],
    ];
    const spheres = combos.map(([m, r, seg]) => {
      const e = this.acquireSphere(m, r, seg);
      e.transform.setPosition(c.x, c.y, c.z);
      return e;
    });
    const fire = this.root.createChild("prewarm-fx");
    buildParticles(this.engine, fire, c.x, c.y, c.z, { rate: 6, lifetime: 0.4, additive: true });
    buildParticles(this.engine, fire, c.x, c.y, c.z, { rate: 6, lifetime: 0.4, additive: false });
    window.setTimeout(() => {
      for (const e of spheres) this.releaseSphere(e);
      fire.destroy();
    }, 400);
  }

  // ── molotov ──
  private breakMol(n: Nade, now: number): void {
    n.entity.destroy();
    const c = { x: n.pos.x, y: this.map.floorY(n.pos.x, n.pos.z) + 0.05, z: n.pos.z };
    this.onBreak?.(n.pos);
    this.onIgnite?.(c, MOL_DURATION);

    const root = this.root.createChild("fire");
    // fire + smoke via the shared particle emitters (particles.ts) — the same
    // ones the editor's `fire`/`smoke` objects use. Emission is spread across the
    // puddle (emitRadius) so it reads as a pool of flames, not a single jet, and
    // the cone points up by default.
    buildParticles(this.engine, root, c.x, c.y + 0.05, c.z, {
      rate: 64, lifetime: 0.85, speed: 1.9, size: 0.5, growth: 0.35, spread: 32,
      gravity: -0.55, color: [1.0, 0.5, 0.13], opacity: 0.9, additive: true, world: true,
      emitRadius: Math.max(0.2, MOL_RADIUS - 0.5),
    });
    buildParticles(this.engine, root, c.x, c.y + 0.35, c.z, {
      rate: 11, lifetime: 2.6, speed: 0.7, size: 0.7, growth: 2.4, spread: 26,
      gravity: -0.15, color: [0.22, 0.2, 0.2], opacity: 0.4, additive: false, world: true,
      emitRadius: Math.max(0.2, MOL_RADIUS - 0.7),
    });
    const le = root.createChild("l");
    le.transform.setPosition(c.x, c.y + 0.8, c.z);
    const light = le.addComponent(PointLight);
    light.color = new Color(1.2, 0.55, 0.15, 1);
    light.distance = 12;

    this.fires.push({ center: c, owner: n.owner, local: n.local, until: now + MOL_DURATION, nextDmg: now + 0.3, light, root });
  }

  private updateFires(now: number): void {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      const left = f.until - now;
      if (left <= 0) {
        f.root.destroy();
        this.fires.splice(i, 1);
        continue;
      }
      // flicker the light; the flames themselves are self-animating particles
      f.light.distance = 10 + Math.sin(now * 13) * 2;
      if (now >= f.nextDmg) {
        f.nextDmg = now + MOL_TICK;
        this.onFireTick?.(f.center, f.owner, f.local);
      }
    }
  }

  private addFx(e: Entity, p: Vec3, ttl: number, grow: number, vel?: Vec3): void {
    const base = e.transform.scale.x;   // radius baked in by sphere() (unit mesh)
    e.transform.setPosition(p.x, p.y, p.z);
    e.transform.setScale(base * 0.4, base * 0.4, base * 0.4);
    this.fx.push({ e, ttl, max: ttl, vel, grow, base });
  }

  private updateFx(dt: number): void {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { this.releaseSphere(f.e); this.fx.splice(i, 1); continue; }
      const k = 1 - f.ttl / f.max;
      const s = f.base * (0.4 + f.grow * k * (1 - k * 0.4));
      f.e.transform.setScale(s, s, s);
      if (f.vel) {
        const p = f.e.transform.position;
        f.e.transform.setPosition(p.x + f.vel.x * dt, p.y + f.vel.y * dt, p.z + f.vel.z * dt);
        f.vel.y += 1.2 * dt;
      }
    }
  }
}
