// ─── Remote players: animated 3D avatar, interpolation buffer, hitboxes ──────
// The avatar is a rigged, skeletally-animated humanoid (the "operator" model in
// the asset catalog — a realistic CS-style tactical operator, mixamorig skeleton,
// Idle/Walk/Run/Jump + rifle clips). The locomotion state is driven from the
// interpolated motion, and the player's current weapon is parented to the right
// hand bone so it tracks the arm. Team play adds an emissive team hue (which reads
// on the dark kit where a multiplicative tint can't); prop-hunt swaps the whole
// humanoid for a crate. If the model fails to load the avatar falls back to the
// old cuboid limbs so the game never renders an empty player.
import {
  Animator, BlinnPhongMaterial, Color, Engine, Entity, MeshRenderer,
  PBRMaterial, PrimitiveMesh, SkinnedMeshRenderer,
} from "@galacean/engine";
import { AABB, rayAABB } from "./map";
import { GameModels, instantiate } from "./models";
import { INTERP_DELAY, PlayerState, Vec3, WeaponId, clamp } from "./types";

interface Sample { time: number; p: [number, number, number]; yaw: number; pitch: number; cr: number }

/** asset-catalog folder name of the rigged character used for every remote avatar */
const CHARACTER_MODEL = "operator";

/** which catalog model each weapon shows in a remote's hands (mirrors the
 *  first-person viewmodels — only the firearms/melee that have a real model) */
const TP_WEAPON: Partial<Record<WeaponId, string>> = {
  ak47: "bolt_action_rifle_7_62",
  usp: "service_pistol",
  awp: "bolt_action_rifle_7_62",
  knife: "machete",
  mol: "bleach_bottle",
};

// held-weapon placement in the right-hand bone's local frame. The weapon is
// parented to `mixamorig:RightHand` so it follows the arm through every clip;
// scale + position are given in world metres and compensated for the bone's
// world scale at attach time. rotation aligns the grip to the hand (euler deg).
const TP_TUNE: Record<string, { s: number; p: [number, number, number]; r: [number, number, number] }> = {
  bolt_action_rifle_7_62: { s: 0.9, p: [0, 0.02, 0.06], r: [0, 0, 90] },
  service_pistol: { s: 1.0, p: [0, 0.01, 0.04], r: [0, 0, 90] },
  machete: { s: 0.9, p: [0, 0.01, 0.05], r: [0, 0, 90] },
  bleach_bottle: { s: 1.0, p: [0, 0.02, 0.04], r: [0, 0, 90] },
};

const LOCO_RUN = 4.5;  // m/s above which the avatar plays Run
const LOCO_WALK = 0.7; // m/s above which the avatar plays Walk
const TEAM_TINT = 0.15; // additive emissive team-hue strength on the operator kit

export class RemotePlayer {
  entity: Entity;
  hp = 100;
  weapon: WeaponId = "ak47";
  pos: Vec3 = { x: 0, y: -100, z: 0 };
  yaw = 0;
  crouched = false;
  alive = true;
  disguised = false; // prop-hunt: rendered as a crate

  private buf: Sample[] = [];
  private engine: Engine;
  private models: GameModels;
  private origColor: number;
  private appliedColor = -2;      // last team colour applied (-1 = original)

  private charRoot: Entity | null = null;   // rigged humanoid (null if it failed to load)
  private animator: Animator | null = null;
  private tintMats: (PBRMaterial | BlinnPhongMaterial)[] = [];
  private locoState = "";
  private wasActive = false;

  private weaponHolder: Entity;      // fallback parent when there's no hand bone
  private handBone: Entity | null = null;
  private heldWeapon: WeaponId | null = null;
  private heldEntity: Entity | null = null;
  private weaponMat: BlinnPhongMaterial;

  private parts: Entity[] = [];   // cuboid fallback limbs / body (hidden while disguised)
  private bodyMat: BlinnPhongMaterial | null = null; // fallback body tint target
  private crate: Entity | null = null;

  // animation clock (wall time) for locomotion speed sampling
  private prevX = 0;
  private prevZ = 0;
  private prevY = 0;
  private prevT = 0;

  constructor(engine: Engine, parent: Entity, public id: string, public name: string, color: number, models: GameModels) {
    this.engine = engine;
    this.models = models;
    this.origColor = color;
    this.entity = parent.createChild("rp-" + id);

    this.weaponMat = new BlinnPhongMaterial(engine);
    this.weaponMat.baseColor = new Color(0.08, 0.08, 0.09, 1);

    const char = instantiate(models[CHARACTER_MODEL]);
    if (char) this.buildCharacter(char);
    else this.buildCuboidFallback(color);

    this.weaponHolder = this.entity.createChild("held");
    this.syncWeapon();

    this.entity.isActive = false;
  }

  // ── avatar construction ─────────────────────────────────────────────────────

  private buildCharacter(char: Entity): void {
    char.name = "char";
    this.entity.addChild(char);
    this.charRoot = char;

    // per-player material clones so team tinting never leaks across shared avatars.
    // (the humanoid is skinned — query both plain and skinned renderers.)
    const renderers = [
      ...char.getComponentsIncludeChildren(SkinnedMeshRenderer, []),
      ...char.getComponentsIncludeChildren(MeshRenderer, []),
    ];
    for (const r of renderers) {
      r.castShadows = true;
      const mats = r.getMaterials();
      for (let i = 0; i < mats.length; i++) {
        const src = mats[i];
        if (!src) continue;
        const clone = src.clone();
        r.setMaterial(i, clone);
        if (clone instanceof PBRMaterial || clone instanceof BlinnPhongMaterial) this.tintMats.push(clone);
      }
    }

    // the glTF loader attaches an Animator (auto-built controller, states named
    // after the clips). Start it idling so a standing player isn't a frozen T-pose.
    this.animator = char.getComponentsIncludeChildren(Animator, [])[0] ?? char.getComponent(Animator);
    // the actual Idle play is forced on first activation (driveAnimation), since
    // the avatar is built inactive and re-enabling resets the animator's pose.

    // the right-hand bone drives the held weapon so it tracks the arm every frame
    this.handBone = char.findByName("mixamorig:RightHand") ?? findByNameDeep(char, "RightHand");
  }

  /** legacy blocky avatar — only used when the character model didn't load */
  private buildCuboidFallback(color: number): void {
    const engine = this.engine;
    const c = new Color(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1);
    const mBody = new BlinnPhongMaterial(engine); mBody.baseColor = c;
    this.bodyMat = mBody;
    const mDark = new BlinnPhongMaterial(engine); mDark.baseColor = new Color(0.15, 0.14, 0.13, 1);
    const mSkin = new BlinnPhongMaterial(engine); mSkin.baseColor = new Color(0.85, 0.65, 0.5, 1);

    const mk = (name: string, x: number, y: number, z: number, w: number, h: number, d: number, m: BlinnPhongMaterial): Entity => {
      const e = this.entity.createChild(name);
      e.transform.setPosition(x, y, z);
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(engine, w, h, d);
      r.setMaterial(m);
      r.castShadows = true;
      return e;
    };

    this.parts.push(mk("legs", 0, 0.45, 0, 0.5, 0.9, 0.32, mDark));
    this.parts.push(mk("torso", 0, 1.22, 0, 0.62, 0.64, 0.36, mBody));
    this.parts.push(mk("head", 0, 1.72, 0, 0.3, 0.3, 0.3, mSkin));
  }

  // ── held weapon ─────────────────────────────────────────────────────────────

  /** rebuild the hand weapon when the player's current weapon changes */
  private syncWeapon(): void {
    if (this.weapon === this.heldWeapon) return;
    this.heldWeapon = this.weapon;
    // drop the previous weapon (destroy the instance — never clearChildren the
    // hand bone, that would delete the finger bones parented under it).
    this.heldEntity?.destroy();
    this.heldEntity = null;
    const folder = TP_WEAPON[this.weapon];
    if (!folder) return; // grenades etc. — nothing held
    const m = instantiate(this.models[folder]);
    if (!m) return;
    // geometry-only weapon glTFs render with a flat default material — give the
    // third-person weapon a plain dark matte so it reads as a gun at a distance.
    for (const r of m.getComponentsIncludeChildren(MeshRenderer, [])) {
      r.castShadows = true;
      for (let i = 0; i < r.getMaterials().length; i++) r.setMaterial(i, this.weaponMat);
    }
    const t = TP_TUNE[folder] ?? { s: 1, p: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number] };
    // parent to the hand bone (scale/offset compensated for the bone's world
    // scale, since the skeleton lives in a centimetre-scaled subtree); fall back
    // to the yaw-aligned holder if the bone is missing.
    const parent = this.handBone ?? this.weaponHolder;
    const ws = this.handBone ? this.handBone.transform.lossyWorldScale.x : 1;
    const inv = Math.abs(ws) > 1e-6 ? 1 / ws : 1;
    m.transform.setScale(t.s * inv, t.s * inv, t.s * inv);
    m.transform.setPosition(t.p[0] * inv, t.p[1] * inv, t.p[2] * inv);
    m.transform.setRotation(t.r[0], t.r[1], t.r[2]);
    parent.addChild(m);
    this.heldEntity = m;
  }

  // ── team colour / disguise ──────────────────────────────────────────────────

  /** tint the body for team play, or pass null to restore the player's colour */
  setTeamColor(color: number | null): void {
    const key = color ?? -1;
    if (key === this.appliedColor) return;
    this.appliedColor = key;

    if (this.charRoot) {
      // The operator's kit is a dark camo texture — a multiplicative baseColor tint
      // can't recolour near-black cloth. Use an *additive* emissive team hue instead,
      // which reads clearly on dark gear without washing out the material detail.
      const er = color === null ? 0 : (((color >> 16) & 255) / 255) * TEAM_TINT;
      const eg = color === null ? 0 : (((color >> 8) & 255) / 255) * TEAM_TINT;
      const eb = color === null ? 0 : ((color & 255) / 255) * TEAM_TINT;
      for (const mat of this.tintMats) mat.emissiveColor = new Color(er, eg, eb, 1);
      return;
    }
    // cuboid fallback: tint just the torso material
    if (this.bodyMat) {
      const c = color ?? this.origColor;
      this.bodyMat.baseColor = new Color(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1);
    }
  }

  /** prop-hunt: swap the humanoid for a wooden crate disguise */
  setDisguise(on: boolean): void {
    if (on === this.disguised) return;
    this.disguised = on;
    if (this.charRoot) this.charRoot.isActive = !on;
    for (const p of this.parts) p.isActive = !on;
    this.weaponHolder.isActive = !on;
    if (on) {
      if (!this.crate) {
        this.crate = this.entity.createChild("crate");
        const m = new BlinnPhongMaterial(this.engine);
        m.baseColor = new Color(0.42, 0.3, 0.16, 1);
        const box = this.crate.createChild("c");
        box.transform.setPosition(0, 0.42, 0);
        const r = box.addComponent(MeshRenderer);
        r.mesh = PrimitiveMesh.createCuboid(this.engine, 0.84, 0.84, 0.84);
        r.setMaterial(m);
        r.castShadows = true;
      }
      this.crate.isActive = true;
    } else if (this.crate) {
      this.crate.isActive = false;
    }
  }

  push(s: PlayerState, time: number): void {
    this.hp = s.hp;
    this.weapon = s.w;
    this.buf.push({ time, p: s.p, yaw: s.yaw, pitch: s.pitch, cr: s.cr });
    if (this.buf.length > 30) this.buf.shift();
  }

  update(now: number): void {
    const t = now - INTERP_DELAY;
    const b = this.buf;
    if (b.length === 0) return;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].time <= t && b[i + 1].time >= t) { a = b[i]; c = b[i + 1]; break; }
    }
    const span = c.time - a.time;
    const k = span > 1e-4 ? clamp((t - a.time) / span, 0, 1) : 1;
    this.pos.x = a.p[0] + (c.p[0] - a.p[0]) * k;
    this.pos.y = a.p[1] + (c.p[1] - a.p[1]) * k;
    this.pos.z = a.p[2] + (c.p[2] - a.p[2]) * k;
    let dy = c.yaw - a.yaw;
    if (dy > Math.PI) dy -= 2 * Math.PI; else if (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw = a.yaw + dy * k;
    this.crouched = c.cr === 1;

    this.applyTransform();
    this.syncWeapon();
    this.driveAnimation();
  }

  /** directly drive the avatar (offline bots — no interpolation buffer) */
  setPose(pos: Vec3, yaw: number, crouched: boolean, alive: boolean): void {
    this.pos.x = pos.x; this.pos.y = pos.y; this.pos.z = pos.z;
    this.yaw = yaw;
    this.crouched = crouched;
    this.alive = alive;
    this.applyTransform();
    this.syncWeapon();
    this.driveAnimation();
  }

  private applyTransform(): void {
    this.entity.isActive = this.alive;
    this.entity.transform.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.entity.transform.setRotation(0, (this.yaw * 180) / Math.PI, 0);
    // crouch: settle the whole avatar down a touch (the crate never crouches)
    const s = this.disguised ? 1 : this.crouched ? 0.82 : 1;
    this.entity.transform.setScale(1, s, 1);
  }

  /** pick Jump / Run / Walk / Idle from the interpolated motion and cross-fade */
  private driveAnimation(): void {
    if (!this.animator || this.disguised) return;
    const now = performance.now() / 1000;
    const dt = now - this.prevT;
    this.prevT = now;
    let sp = 0, vy = 0;
    if (dt > 1e-4 && dt < 0.5) {
      sp = Math.hypot(this.pos.x - this.prevX, this.pos.z - this.prevZ) / dt;
      vy = (this.pos.y - this.prevY) / dt;
    }
    this.prevX = this.pos.x; this.prevZ = this.pos.z; this.prevY = this.pos.y;
    // re-enabling the entity resets the animator to its default pose (T-pose), so
    // force a fresh play whenever the avatar comes (back) on-screen.
    const justActivated = this.alive && !this.wasActive;
    this.wasActive = this.alive;
    if (!this.alive) return;
    // airborne (rising, or falling fast) → jump clip; else locomotion by speed
    const airborne = vy > 1.8 || vy < -5.5;
    const want = airborne ? "Jump" : sp > LOCO_RUN ? "Run" : sp > LOCO_WALK ? "Walk" : "Idle";
    if ((want !== this.locoState || justActivated) && this.animator.findAnimatorState(want)) {
      this.locoState = want;
      if (justActivated) this.animator.play(want);
      else this.animator.crossFade(want, 0.15);
    }
  }

  /** ray test → { dist, head } or null. Ray in world space. */
  hitTest(o: Vec3, d: Vec3, maxDist: number): { dist: number; head: boolean } | null {
    if (!this.alive) return null;
    if (this.disguised) {
      // crate hitbox — no headshots on a prop
      const crate: AABB = {
        min: { x: this.pos.x - 0.44, y: this.pos.y, z: this.pos.z - 0.44 },
        max: { x: this.pos.x + 0.44, y: this.pos.y + 0.86, z: this.pos.z + 0.44 },
      };
      const cHit = rayAABB(o, d, crate, maxDist);
      return cHit ? { dist: cHit.dist, head: false } : null;
    }
    const sy = this.crouched ? 0.82 : 1;
    // body AABB (world, yaw-agnostic approximation)
    const body: AABB = {
      min: { x: this.pos.x - 0.36, y: this.pos.y, z: this.pos.z - 0.36 },
      max: { x: this.pos.x + 0.36, y: this.pos.y + 1.58 * sy, z: this.pos.z + 0.36 },
    };
    // head sphere
    const hc = { x: this.pos.x, y: this.pos.y + 1.72 * sy, z: this.pos.z };
    const hHit = raySphere(o, d, hc, 0.21, maxDist);
    const bHit = rayAABB(o, d, body, maxDist);
    if (hHit !== null && (bHit === null || hHit <= bHit.dist)) return { dist: hHit, head: true };
    if (bHit) return { dist: bHit.dist, head: false };
    return null;
  }

  gunMuzzle(): Vec3 {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { x: this.pos.x - s * 0.6 + c * 0.28, y: this.pos.y + 1.3, z: this.pos.z - c * 0.6 - s * 0.28 };
  }
}

/** recursive fallback for finding a bone whose name merely contains `needle`
 *  (some rigs prefix bones, e.g. "mixamorig:RightHand" vs "RightHand") */
function findByNameDeep(e: Entity, needle: string): Entity | null {
  for (let i = 0; i < e.children.length; i++) {
    const c = e.children[i];
    if (c.name.includes(needle)) return c;
    const hit = findByNameDeep(c, needle);
    if (hit) return hit;
  }
  return null;
}

function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number, maxDist: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < maxDist ? t : null;
}
