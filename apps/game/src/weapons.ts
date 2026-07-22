// ─── Weapon system: viewmodels, firing state, recoil, tracers, muzzle flash ──
import {
  Color, Engine, Entity, MeshRenderer, PointLight,
  PrimitiveMesh, Quaternion, UnlitMaterial, Vector3,
} from "@galacean/engine";
import { sfx } from "./audio";
import { AmmoTag } from "./ammotag";
import { GameModels, instantiate, modelId, modelMetaOf } from "./models";
import { MaterialLibrary, shadeModelSlots } from "./materials";
import { Vec3, WEAPONS, WeaponDef, WeaponId, ALL_WEAPONS, LOADOUT, clamp } from "./types";
import { modelAnchor, type ModelMeta } from "@slopwars/shared";
import { NO_REFLECT_LAYER } from "./water";

/** move an entity subtree to the no-reflect layer — the first-person viewmodel
 *  must not show up in water reflections (it would float above the mirrored eye). */
function layerNoReflect(e: Entity): void {
  e.layer = NO_REFLECT_LAYER;
  for (const c of e.children) layerNoReflect(c);
}

interface Ammo { mag: number; reserve: number }

// The model each weapon is held as — the ONLY weapon-specific model data in code.
// These are ordinary geometry-only models (CC0 "Guns & Explosives" + "Melee Weapons"
// packs, 3dmodelscc0): they carry their own library materials (meta.materials) and
// their held pose (meta.scale), authored in the editor exactly like any other model —
// so there are no per-weapon offsets/rotations here. The muzzle flash + shot origin come
// from each model's `muzzle` anchor (also authored in the editor).
const WEAPON_MODEL: Record<WeaponId, string> = {
  knife: "wep_knife",
  usp: "wep_makarov",
  luger: "wep_luger",
  ak47: "wep_ak47",
  m4a1: "wep_m4a1",
  suomi: "wep_suomi",
  grease: "wep_grease",
  shotgun: "wep_shotgun",
  awp: "wep_sniper",
  he: "wep_frag",
  mol: "wep_molotov",
  flash: "wep_flashbang",
  smoke: "wep_smoke",
  portalgun: "wep_portalgun", // Portal 2 ASHPD device (CC OBJ, converted to geometry-only glTF)
};

/** a full ammo table for every weapon, seeded from each def's mag/reserve. Throwables
 *  start at their `mag` count with no reserve; melee is the sentinel -1/-1. */
function ammoFromDefs(): Record<WeaponId, Ammo> {
  const out = {} as Record<WeaponId, Ammo>;
  for (const id of ALL_WEAPONS) {
    const d = WEAPONS[id];
    out[id] = d.melee
      ? { mag: -1, reserve: -1 }
      : { mag: d.mag, reserve: d.reserve < 0 ? -1 : d.reserve };
  }
  return out;
}

export class WeaponSystem {
  current: WeaponId = "ak47";
  /** the player's active inventory (a class subset of ALL_WEAPONS). Weapon-slot keys and
   *  the weapon wheel operate over this, not the global weapon list — see setLoadout. */
  loadout: WeaponId[] = [...LOADOUT];
  ammo: Record<WeaponId, Ammo> = ammoFromDefs();
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
  // per-weapon muzzle point in viewmodel space (from the model's `muzzle` anchor), so
  // the flash + shot origin sit at the barrel tip. Absent → the default flash position.
  private muzzles: Partial<Record<WeaponId, Vector3>> = {};
  // per-weapon ammo-readout mount (from the model's `ammo` anchor, scaled into viewmodel
  // space). A weapon without one shows NO weapon-mounted ammo readout.
  private ammoMounts: Partial<Record<WeaponId, { at: Vector3; rot?: [number, number, number] }>> = {};
  private bobT = 0;
  private src!: GameModels;
  private ammoTag!: AmmoTag; // diegetic weapon-mounted ammo counter (child of the viewmodel)

  onShoot: ((def: WeaponDef, spread: number) => void) | null = null;
  onAmmoChange: (() => void) | null = null;

  constructor(private engine: Engine, cameraEntity: Entity, src: GameModels) {
    this.src = src;
    this.vm = cameraEntity.createChild("viewmodel");
    this.buildModels();
    this.buildFlash();
    this.ammoTag = new AmmoTag(engine, this.vm);
    layerNoReflect(this.vm);   // keep the whole viewmodel out of water reflections
    this.select("ak47");
  }

  def(): WeaponDef { return WEAPONS[this.current]; }

  /** is this weapon actually in the inventory right now? A throwable leaves the loadout
   *  once its last one is gone (mag 0) — it's no longer shown or selectable until refilled. */
  available(w: WeaponId): boolean {
    return WEAPONS[w].throwable ? this.ammo[w].mag > 0 : true;
  }

  /** swap the active inventory to a class kit (or any weapon subset). Ammo for the new
   *  weapons is topped up, the first entry is drawn, and any weapon not in the kit is
   *  simply inactive. Order defines the weapon-slot key mapping + wheel order. */
  setLoadout(ids: WeaponId[]): void {
    this.loadout = ids.filter((id) => WEAPONS[id]);
    if (!this.loadout.length) this.loadout = [...LOADOUT];
    for (const id of this.loadout) {
      const d = WEAPONS[id];
      if (!d.melee) this.ammo[id] = { mag: d.mag, reserve: d.reserve < 0 ? -1 : d.reserve };
    }
    this.select(this.loadout[0]);
  }

  /** select the weapon in loadout slot `i` (0-based), if it exists + is available */
  slot(i: number): void {
    const w = this.loadout[i];
    if (w) this.select(w);
  }

  select(w: WeaponId): void {
    if (!this.available(w)) return; // can't equip a spent throwable
    this.current = w;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);
    this.drawTimer = 0.25;
    this.setScope(false);
    for (const id of ALL_WEAPONS) { const e = this.models[id]; if (e) e.isActive = id === w; }
    // seat the muzzle flash at this weapon's barrel tip (its `muzzle` anchor)
    const mz = this.muzzles[w];
    if (mz) this.flash.transform.setPosition(mz.x, mz.y, mz.z);
    // seat the ammo readout at this weapon's `ammo` anchor — or hide it entirely for a
    // weapon that doesn't carry one (knife, throwables, uncalibrated models)
    const am = this.ammoMounts[w];
    this.ammoTag.mount(am ? am.at : null, am?.rot);
    sfx.draw();
    this.onAmmoChange?.();
  }

  /** the current weapon's muzzle point in WORLD space (the tip of the barrel, following
   *  the animated viewmodel) — the origin a shot's tracer starts from. Null when the
   *  weapon carries no `muzzle` anchor. */
  muzzleWorld(): Vec3 | null {
    if (!this.muzzles[this.current]) return null;
    const p = this.flash.transform.worldPosition;
    return { x: p.x, y: p.y, z: p.z };
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
    this.prewarmModels();
  }

  /** Render every weapon's viewmodel for a few frames once its library materials
   *  land: only the selected weapon's model is ever active, so each remaining
   *  mesh+material pipeline otherwise compiles on the FIRST switch to that weapon —
   *  a measured ~125ms GPU-side stall on a cold shader cache when first pulling the
   *  grenade. Same idiom as TracerPool.prewarm: parked far below the camera (out of
   *  frustum — compilation still happens for active renderers), restored after a few
   *  rendered frames. Runs at boot-menu time, before ws.update() can touch the vm. */
  private prewarmModels(): void {
    this.vm.isActive = true;
    this.vm.transform.setPosition(0, -120, 0);
    for (const id of ALL_WEAPONS) { const e = this.models[id]; if (e) e.isActive = true; }
    window.setTimeout(() => {
      this.vm.transform.setPosition(0, 0, 0);
      for (const id of ALL_WEAPONS) { const e = this.models[id]; if (e) e.isActive = id === this.current; }
      this.vm.isActive = this.vmVisible && !this.scoped; // showViewmodel()'s invariant
    }, 350);
  }

  /** hide/show whole viewmodel (e.g. in the lobby camera) */
  showViewmodel(v: boolean): void {
    this.vmVisible = v;
    this.vm.isActive = v && !this.scoped;
  }

  cycle(dir: number): void {
    const n = this.loadout.length;
    if (!n) return;
    let i = this.loadout.indexOf(this.current);
    for (let k = 0; k < n; k++) { // skip spent throwables so scroll never lands on an empty slot
      i = (i + dir + n) % n;
      if (this.available(this.loadout[i])) { this.select(this.loadout[i]); return; }
    }
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
    if (d.portal) {
      // portal gun: never dry, no flash/recoil — the shot itself (placement raycast,
      // blue/orange alternation, fire vs fail cue) is resolved by main.firePortal.
      this.cooldown = (60 / d.rpm) * this.fireRateMult;
      this.kick = 0.07;
      this.onShoot?.(d, 0);
      return true;
    }
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

    // keep the weapon-mounted ammo counter in step (it redraws only when the readout changes)
    const d = this.def(), a = this.ammo[this.current];
    // the portal gun reads as melee here (∞ readout) — it has no magazine to count
    this.ammoTag.set(a.mag, a.reserve, this.reloading > 0, !!d.melee || !!d.portal, !!d.throwable, d.mag);
  }

  // ─── visuals ────────────────────────────────────────────────────────────────

  private buildModels(): void {
    // Each weapon is an ordinary model, seated at the hand by its own meta scale (the
    // model's authored orientation already faces forward). Setting modelFolders lets
    // applyModelMaterials shade them with their library materials, like a placed prop.
    for (const id of ALL_WEAPONS) {
      const folder = WEAPON_MODEL[id];
      const m = instantiate(this.src[modelId(folder)]);
      if (!m) { console.warn("[weapon] model missing:", folder); continue; }
      // The Luger's glTF ships with a magazine ("Clip") node we don't want on the viewmodel.
      if (id === "luger") m.findByName("Clip")?.destroy();
      const meta = modelMetaOf(folder);
      const s = meta.scale ?? 1;
      m.transform.setScale(s, s, s);
      // honour a meta-authored default orientation (baseRot), so a weapon whose glTF
      // ships tilted can be re-posed in its meta.json without touching the mesh.
      // (Anchors are mapped by scale only — fine while no rotated model carries one.)
      const br = meta.baseRot;
      if (br && (br[0] || br[1] || br[2])) m.transform.setRotation(br[0], br[1], br[2]);
      this.vm.addChild(m);
      this.models[id] = m;
      this.modelFolders[id] = folder;
      const mz = this.muzzlePoint(meta);
      if (mz) this.muzzles[id] = mz;
      // the model's `ammo` anchor, scaled into viewmodel space like the muzzle. The
      // anchor's rot (if authored) orients the readout; AmmoTag falls back to a default.
      const am = modelAnchor(meta, "ammo");
      if (am) {
        const s = meta.scale ?? 1;
        this.ammoMounts[id] = {
          at: new Vector3(am.at[0] * s, am.at[1] * s, am.at[2] * s),
          rot: am.rot ? [am.rot[0], am.rot[1], am.rot[2]] : undefined,
        };
      }
    }
  }

  /** the model's `muzzle` anchor mapped into viewmodel space (the model is seated at the
   *  viewmodel origin by scale only). Null when the model carries no muzzle anchor. */
  private muzzlePoint(meta: ModelMeta): Vector3 | null {
    const muzzle = modelAnchor(meta, "muzzle");
    if (!muzzle) return null;
    const s = meta.scale ?? 1;
    return new Vector3(muzzle.at[0] * s, muzzle.at[1] * s, muzzle.at[2] * s);
  }

  private buildFlash(): void {
    this.flash = this.vm.createChild("flash");
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
    // no muzzle anchor authored → no flash to place (author it in the editor's Model view)
    if (!this.muzzles[this.current]) return;
    this.flash.isActive = true;
    this.flashLight.enabled = true;
    this.flash.transform.setRotation(0, 0, Math.random() * 360);
    this.flashTtl = 0.045;
  }

  /** Warm up the muzzle-flash shaders during the loading screen. The first shot
   *  otherwise stalls ~800ms: Galacean compiles the flash's unlit shader on first
   *  render, and — worse — enabling its PointLight bumps the scene's point-light-count
   *  macro, forcing every lit material in view to recompile. Enabling it now compiles
   *  that "+1 point light" permutation up front; because a grenade blast and molotov
   *  light are also just +1, this single prewarm covers those first-explosion stalls
   *  too. Hidden again after a few rendered frames (independent of the in-game loop). */
  prewarm(): void {
    // park the flash a few metres ahead purely for the shader warmup (its real position
    // comes from the current weapon's muzzle anchor at fire time), so it isn't rendered
    // sitting on the camera when no muzzle is seated yet.
    this.flash.transform.setPosition(0, 0, -3);
    this.flash.isActive = true;
    this.flashLight.enabled = true;
    this.flashTtl = 0; // don't let a later update() also try to hide it
    window.setTimeout(() => { this.flash.isActive = false; this.flashLight.enabled = false; }, 350);
  }
}

// ─── tracers + impact puffs (pooled) ─────────────────────────────────────────
export class TracerPool {
  // a tracer is a short bright STREAK that flies from the muzzle to the impact point —
  // not a static full-length beam. A beam's near end sits frozen in world space for its
  // whole lifetime, so a running shooter visibly leaves their own tracer behind them; a
  // travelling streak has cleared the muzzle by the next frame.
  private static readonly SPEED = 380; // u/s — streak flight speed
  private static readonly STREAK = 7;  // u — visible streak length
  private pool: { e: Entity; live: boolean; head: number; len: number; from: Vec3; dir: Vec3 }[] = [];
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
    let slot = this.pool.find((s) => !s.live);
    if (!slot) {
      const e = this.root.createChild("tracer");
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(this.engine, 0.02, 0.02, 1);
      r.setMaterial(this.mat);
      slot = { e, live: false, head: 0, len: 0, from: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } };
      this.pool.push(slot);
    }
    slot.live = true;
    slot.head = 0;
    slot.len = len;
    slot.from = { x: from.x, y: from.y, z: from.z };
    slot.dir = { x: dx / len, y: dy / len, z: dz / len };
    const e = slot.e;
    e.isActive = true;
    // orient -Z along dir (fixed for the streak's whole flight)
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(clamp(dy / len, -1, 1));
    Quaternion.rotationYawPitchRoll(yaw, pitch, 0, this.q);
    e.transform.rotationQuaternion = this.q;
    this.place(slot); // seat the (still zero-length) streak at the muzzle for frame one
  }

  /** stretch the streak between its tail and head along the flight line */
  private place(s: { e: Entity; head: number; len: number; from: Vec3; dir: Vec3 }): void {
    const head = Math.min(s.head, s.len);
    const tail = Math.max(s.head - TracerPool.STREAK, 0);
    const segLen = Math.max(head - tail, 0.05);
    const mid = (head + tail) / 2;
    s.e.transform.setPosition(s.from.x + s.dir.x * mid, s.from.y + s.dir.y * mid, s.from.z + s.dir.z * mid);
    s.e.transform.setScale(1, 1, segLen);
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
    for (const s of this.pool) {
      if (!s.live) continue;
      s.head += TracerPool.SPEED * dt;
      if (s.head - TracerPool.STREAK >= s.len) { s.live = false; s.e.isActive = false; continue; }
      this.place(s);
    }
    for (const s of this.puffs) if (s.ttl > 0) { s.ttl -= dt; if (s.ttl <= 0) s.e.isActive = false; }
  }

  /** compile the tracer + impact-puff shaders during loading (each is a first-render
   *  shader compile) so the first shot doesn't hitch. Rendered far underground for a
   *  few frames, then hidden — not driven by the in-game update loop. */
  prewarm(): void {
    this.spawn({ x: 0, y: -120, z: 2 }, { x: 0, y: -120, z: 8 });
    this.impact({ x: 0, y: -120, z: 2 });
    window.setTimeout(() => {
      for (const s of this.pool) { s.live = false; s.e.isActive = false; }
      for (const s of this.puffs) { s.ttl = 0; s.e.isActive = false; }
    }, 350);
  }
}
