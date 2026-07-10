// ─── Weapon system: viewmodels, firing state, recoil, tracers, muzzle flash ──
import {
  BlinnPhongMaterial, Color, Engine, Entity, MeshRenderer, PointLight,
  PrimitiveMesh, Quaternion, UnlitMaterial,
} from "@galacean/engine";
import { sfx } from "./audio";
import { GameModels, instantiate } from "./models";
import { MaterialLibrary, shadeModelSlots } from "./materials";
import { Vec3, WEAPONS, WeaponDef, WeaponId, LOADOUT, clamp } from "./types";
import type { ModelMeta } from "@slopwars/shared";

interface Ammo { mag: number; reserve: number }

// first-person placement for the PH proxy meshes (scale + position + euler deg).
// Real-scale detailed meshes → tuned to sit in view. Adjust here to reframe.
const WEP_TUNE: Record<"ak47" | "usp" | "knife" | "awp" | "mol", { s: number; p: [number, number, number]; r: [number, number, number] }> = {
  ak47:  { s: 0.5,  p: [0.18, -0.22, -0.15], r: [0, 90, 0] },
  usp:   { s: 0.7,  p: [0.15, -0.16, -0.08], r: [0, 90, 0] },
  knife: { s: 0.6,  p: [0.12, -0.12, -0.12], r: [0, 90, 0] },
  awp:   { s: 0.55, p: [0.16, -0.20, -0.12], r: [0, 90, 0] },
  mol:   { s: 0.9,  p: [0.12, -0.16, -0.06], r: [0, 0, 0] },
};

export class WeaponSystem {
  current: WeaponId = "ak47";
  ammo: Record<WeaponId, Ammo> = {
    knife: { mag: -1, reserve: -1 },
    usp: { mag: 12, reserve: 48 },
    ak47: { mag: 30, reserve: 90 },
    awp: { mag: 5, reserve: 15 },
    he: { mag: 2, reserve: -1 },
    mol: { mag: 1, reserve: -1 },
  };
  reloading = 0; // time left
  cooldown = 0;
  scoped = false;
  fireRateMult = 1; // <1 = faster (rapid-fire powerup)
  recoilPitch = 0; // accumulated camera kick (rad), decays
  private kick = 0; // viewmodel z punch
  private drawTimer = 0;

  private vmVisible = true; // false in lobby (hide weapon from lobby camera)
  private vm!: Entity; // viewmodel root (child of camera)
  private models: Partial<Record<WeaponId, Entity>> = {};
  // model folder each viewmodel was instantiated from, for applying its meta materials
  // (models are geometry-only glTFs — surfaces come from the model's assigned materials)
  private modelFolders: Partial<Record<WeaponId, string>> = {};
  private flash!: Entity;
  private flashLight!: PointLight;
  private flashTtl = 0;
  private bobT = 0;
  private src!: GameModels;

  onShoot: ((def: WeaponDef, spread: number) => void) | null = null;
  onAmmoChange: (() => void) | null = null;

  constructor(private engine: Engine, cameraEntity: Entity, src: GameModels) {
    this.src = src;
    this.vm = cameraEntity.createChild("viewmodel");
    this.buildModels();
    this.buildFlash();
    this.select("ak47");
  }

  def(): WeaponDef { return WEAPONS[this.current]; }

  select(w: WeaponId): void {
    this.current = w;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);
    this.drawTimer = 0.25;
    this.setScope(false);
    for (const id of LOADOUT) { const e = this.models[id]; if (e) e.isActive = id === w; }
    sfx.draw();
    this.onAmmoChange?.();
  }

  /** the distinct model folders the viewmodels were built from (for the host to
   *  resolve just those models' material textures) */
  weaponModelFolders(): string[] {
    return [...new Set(Object.values(this.modelFolders).filter((f): f is string => !!f))];
  }

  /** shade the glTF viewmodels with their models' assigned materials (models are
   *  geometry-only, so without this the guns render with the glTF's flat default
   *  material). Called once textures/materials are ready — the meshes are already in
   *  the scene, so the textured look simply pops in. */
  applyModelMaterials(metas: Map<string, ModelMeta>, lib: MaterialLibrary): void {
    for (const [id, folder] of Object.entries(this.modelFolders) as [WeaponId, string][]) {
      const e = this.models[id];
      if (e && folder) shadeModelSlots(e, metas.get(folder), lib);
    }
  }

  /** hide/show whole viewmodel (e.g. in the lobby camera) */
  showViewmodel(v: boolean): void {
    this.vmVisible = v;
    this.vm.isActive = v && !this.scoped;
  }

  cycle(dir: number): void {
    const i = LOADOUT.indexOf(this.current);
    this.select(LOADOUT[(i + dir + LOADOUT.length) % LOADOUT.length]);
  }

  reload(): void {
    const d = this.def();
    const a = this.ammo[this.current];
    if (d.melee || this.reloading > 0 || a.mag >= d.mag || a.reserve <= 0) return;
    this.reloading = d.reloadTime;
    this.setScope(false);
    sfx.reload(this.current);
  }

  setScope(on: boolean): void {
    if (!this.def().scope) on = false;
    this.scoped = on;
    this.vm.isActive = !on && this.vmVisible;
  }

  /** attempt fire. moveSpeed for spread. Returns true if a shot happened. */
  tryFire(moveSpeed: number, onGround: boolean): boolean {
    const d = this.def();
    const a = this.ammo[this.current];
    if (this.cooldown > 0 || this.reloading > 0 || this.drawTimer > 0) return false;
    if (!d.melee && a.mag <= 0) { if (!d.throwable) this.reload(); return false; }

    this.cooldown = (60 / d.rpm) * this.fireRateMult;
    if (!d.melee) { a.mag--; this.onAmmoChange?.(); }
    if (d.throwable) {
      sfx.nadeThrow();
      this.onShoot?.(d, 0);
      this.cooldown = Math.max(this.cooldown, 0.5);
      return true;
    }

    let spread = d.spread + d.spreadMove * clamp(moveSpeed / 7, 0, 1.6);
    if (!onGround) spread += 0.02;
    if (d.scope && !this.scoped) spread += 0.06; // noscope
    if (d.scope && this.scoped) spread = d.spread * 0.1;

    if (!d.melee) this.showFlash();
    sfx.shot(this.current);
    this.onShoot?.(d, spread);          // shot uses current view, THEN recoil kicks
    this.recoilPitch += (d.recoil * Math.PI) / 180;
    this.kick = 0.09;
    return true;
  }

  update(dt: number, moving: boolean, onGround: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.drawTimer = Math.max(0, this.drawTimer - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const d = this.def();
        const a = this.ammo[this.current];
        const need = d.mag - a.mag;
        const take = a.reserve < 0 ? need : Math.min(need, a.reserve);
        a.mag += take;
        if (a.reserve > 0) a.reserve -= take;
        this.onAmmoChange?.();
      }
    }
    // recoil recovery
    this.recoilPitch *= Math.exp(-9 * dt);
    this.kick *= Math.exp(-11 * dt);

    // viewmodel bob + punch + reload dip
    this.bobT += dt * (moving && onGround ? 9.5 : 2);
    const bobY = Math.abs(Math.sin(this.bobT)) * (moving && onGround ? 0.012 : 0.003);
    const bobX = Math.sin(this.bobT * 0.5) * (moving && onGround ? 0.008 : 0.002);
    const dip = this.reloading > 0 ? -0.09 : 0;
    const draw = this.drawTimer > 0 ? -this.drawTimer * 0.6 : 0;
    this.vm.transform.setPosition(0.24 + bobX, -0.22 + bobY + dip + draw, -0.45 + this.kick);
    this.vm.transform.setRotation(this.reloading > 0 ? -25 : 0, 0, 0);

    if (this.flashTtl > 0) {
      this.flashTtl -= dt;
      if (this.flashTtl <= 0) { this.flash.isActive = false; this.flashLight.enabled = false; }
    }
  }

  // ─── visuals ────────────────────────────────────────────────────────────────

  private matDark!: BlinnPhongMaterial;

  private buildModels(): void {
    const e = this.engine;
    this.matDark = new BlinnPhongMaterial(e); this.matDark.baseColor = new Color(0.08, 0.08, 0.09, 1);

    const box = (parent: Entity, x: number, y: number, z: number, w: number, h: number, d: number, m: BlinnPhongMaterial): void => {
      const c = parent.createChild("p");
      c.transform.setPosition(x, y, z);
      const r = c.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(e, w, h, d);
      r.setMaterial(m);
    };

    // ── proxy GLB viewmodels (Poly Haven CC0), referenced by model folder name.
    // Only 2 real firearms exist on Poly Haven → AWP reuses the bolt-action rifle.
    for (const [id, folder] of [
      ["ak47", "bolt_action_rifle_7_62"], ["usp", "service_pistol"],
      ["knife", "machete"], ["awp", "bolt_action_rifle_7_62"],
    ] as const) {
      const t = WEP_TUNE[id];
      const m = instantiate(this.src[folder]);
      if (!m) continue;
      m.transform.setPosition(t.p[0], t.p[1], t.p[2]);
      m.transform.setScale(t.s, t.s, t.s);
      m.transform.setRotation(t.r[0], t.r[1], t.r[2]);
      this.vm.addChild(m);
      this.models[id] = m;
      this.modelFolders[id] = folder;
    }

    // he grenade
    let g = this.vm.createChild("he");
    const olive = new BlinnPhongMaterial(e); olive.baseColor = new Color(0.14, 0.2, 0.12, 1);
    box(g, 0, -0.02, -0.05, 0.09, 0.11, 0.09, olive);
    box(g, 0, 0.055, -0.05, 0.03, 0.04, 0.03, this.matDark);      // fuse cap
    this.models.he = g;

    // molotov: bottle model if it loaded, else box
    if (this.src.bleach_bottle) {
      const t = WEP_TUNE.mol;
      const m = instantiate(this.src.bleach_bottle)!;
      m.transform.setPosition(t.p[0], t.p[1], t.p[2]);
      m.transform.setScale(t.s, t.s, t.s);
      m.transform.setRotation(t.r[0], t.r[1], t.r[2]);
      this.vm.addChild(m);
      this.models.mol = m;
      this.modelFolders.mol = "bleach_bottle";
    } else {
      g = this.vm.createChild("mol");
      const amber = new BlinnPhongMaterial(e); amber.baseColor = new Color(0.6, 0.32, 0.08, 1);
      const rag = new BlinnPhongMaterial(e); rag.baseColor = new Color(0.8, 0.76, 0.65, 1);
      box(g, 0, -0.03, -0.05, 0.09, 0.16, 0.09, amber);           // bottle
      box(g, 0, 0.075, -0.05, 0.04, 0.06, 0.04, amber);           // neck
      box(g, 0, 0.12, -0.05, 0.05, 0.04, 0.05, rag);              // rag
      this.models.mol = g;
    }
  }

  private buildFlash(): void {
    this.flash = this.vm.createChild("flash");
    this.flash.transform.setPosition(0, 0.01, -0.62);
    const r = this.flash.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createSphere(this.engine, 0.055, 8);
    const m = new UnlitMaterial(this.engine);
    m.baseColor = new Color(6, 4.2, 1.2, 1); // HDR → bloom
    r.setMaterial(m);
    const le = this.flash.createChild("l");
    this.flashLight = le.addComponent(PointLight);
    this.flashLight.color = new Color(1, 0.75, 0.35, 1);
    this.flashLight.distance = 9;
    this.flash.isActive = false;
  }

  private showFlash(): void {
    this.flash.isActive = true;
    this.flashLight.enabled = true;
    this.flash.transform.setRotation(0, 0, Math.random() * 360);
    this.flashTtl = 0.045;
  }
}

// ─── tracers + impact puffs (pooled) ─────────────────────────────────────────
export class TracerPool {
  private pool: { e: Entity; ttl: number }[] = [];
  private puffs: { e: Entity; ttl: number }[] = [];
  private root: Entity;
  private mat: UnlitMaterial;
  private puffMat: UnlitMaterial;
  private q = new Quaternion();

  constructor(private engine: Engine, parent: Entity) {
    this.root = parent.createChild("fx");
    this.mat = new UnlitMaterial(engine);
    this.mat.baseColor = new Color(4, 3.2, 1.6, 1);
    this.puffMat = new UnlitMaterial(engine);
    this.puffMat.baseColor = new Color(0.85, 0.8, 0.7, 1);
  }

  spawn(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    let slot = this.pool.find((s) => s.ttl <= 0);
    if (!slot) {
      const e = this.root.createChild("tracer");
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(this.engine, 0.02, 0.02, 1);
      r.setMaterial(this.mat);
      slot = { e, ttl: 0 };
      this.pool.push(slot);
    }
    const e = slot.e;
    e.isActive = true;
    e.transform.setPosition(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    e.transform.setScale(1, 1, len);
    // orient -Z along dir
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(clamp(dy / len, -1, 1));
    Quaternion.rotationYawPitchRoll(yaw, pitch, 0, this.q);
    e.transform.rotationQuaternion = this.q;
    slot.ttl = 0.06;
  }

  impact(p: Vec3): void {
    let slot = this.puffs.find((s) => s.ttl <= 0);
    if (!slot) {
      const e = this.root.createChild("puff");
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createSphere(this.engine, 0.06, 6);
      r.setMaterial(this.puffMat);
      slot = { e, ttl: 0 };
      this.puffs.push(slot);
    }
    slot.e.isActive = true;
    slot.e.transform.setPosition(p.x, p.y, p.z);
    slot.ttl = 0.1;
  }

  update(dt: number): void {
    for (const s of this.pool) if (s.ttl > 0) { s.ttl -= dt; if (s.ttl <= 0) s.e.isActive = false; }
    for (const s of this.puffs) if (s.ttl > 0) { s.ttl -= dt; if (s.ttl <= 0) s.e.isActive = false; }
  }
}
