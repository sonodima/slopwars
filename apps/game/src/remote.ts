// ─── Remote players: animated 3D avatar, interpolation buffer, hitboxes ──────
// The avatar is a rigged, skeletally-animated humanoid (the "operator" model in
// the asset catalog — a realistic CS-style tactical operator, mixamorig skeleton,
// Idle/Walk/Run/Jump + rifle clips). The locomotion state is driven from the
// interpolated motion, and the player's current weapon is parented to the right
// hand bone so it tracks the arm. The operator always shows its own standard
// textures (no team tint); prop-hunt swaps the whole humanoid for a disguise prop
// (a model from the map's prop-hunt pool, or a plain crate when the pool is empty).
import {
  Animator, AnimatorCullingMode, BlinnPhongMaterial, Color, Engine, Entity, MeshRenderer,
  PrimitiveMesh, SkinnedMeshRenderer, Vector3, WrapMode,
} from "@galacean/engine";
import { modelAnchor } from "@slopwars/shared";
import { AABB, rayAABB } from "./map";
import { GameModels, buildProp, instantiate, modelMetaOf } from "./models";
import type { MaterialLibrary } from "./materials";
import { INTERP_DELAY, PlayerState, Vec3, WeaponId, clamp } from "./types";

interface Sample { time: number; p: [number, number, number]; yaw: number; pitch: number; cr: number }

/** asset-catalog folder name of the rigged character used for every remote avatar */
const CHARACTER_MODEL = "operator";

/** which catalog model each weapon shows in a remote's hands — the SAME models the
 *  local player holds in first person, so you carry the gun everyone else sees. */
const TP_WEAPON: Partial<Record<WeaponId, string>> = {
  ak47: "wep_ak47",
  usp: "wep_makarov",
  awp: "wep_sniper",
  knife: "wep_knife",
  he: "wep_frag",
  mol: "wep_molotov",
};

// The weapon is parented to `mixamorig:RightHand` so it follows the arm through every
// clip. Each model seats by its own meta scale (its authored orientation already faces
// forward); the hand-bone's rest frame differs from that forward frame, so a fixed
// correction rotates the weapon into the hand's aim frame. Tuned once; shared by all.
const TP_HAND_ROT: [number, number, number] = [-87, -155, 59];
// small extra offset (metres, hand frame) to seat the weapon in the palm rather than
// dead-centre on the bone pivot.
const TP_HAND_OFFSET: [number, number, number] = [0, 0, 0];

const LOCO_RUN = 4.5;  // m/s above which the avatar plays Run
const LOCO_WALK = 0.7; // m/s above which the avatar plays Walk

/** pick the directional locomotion clip from a movement vector expressed in the
 *  avatar's own frame (fwd = +forward/-back, strafe = +right/-left) and speed. Falls
 *  back through the clip set the operator glTF ships (see NOTICE.txt). */
function locoClip(fwd: number, strafe: number, run: boolean): string {
  // strafing dominates only when clearly more sideways than forward/back
  if (Math.abs(strafe) > Math.abs(fwd) * 1.3) return strafe > 0 ? "StrafeRight" : "StrafeLeft";
  if (fwd < 0) return run ? "RunBack" : "WalkBack";
  return run ? "Run" : "Walk";
}

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

  private charRoot: Entity | null = null;   // rigged humanoid (null if it failed to load)
  private animator: Animator | null = null;
  private locoState = "";
  private wasActive = false;

  private weaponHolder: Entity;      // fallback parent when there's no hand bone
  private handBone: Entity | null = null;
  private heldWeapon: WeaponId | null = null;
  private heldEntity: Entity | null = null;
  private weaponMat: BlinnPhongMaterial;

  private disguise: Entity | null = null;   // prop-hunt disguise prop (built lazily)
  private disguiseModel: string | null = null;  // which model the current disguise is
  private disguiseLib: MaterialLibrary | null = null;  // shades the disguise's slot materials

  // animation clock (wall time) for locomotion speed sampling
  private prevX = 0;
  private prevZ = 0;
  private prevY = 0;
  private prevT = 0;
  private deathPlayed = false;   // Death clip latched for the current death (kept prone)
  private deathKick = 0;         // frames the Death play has been (re)issued (see syncDeath)
  private smFwd = 0;             // smoothed local forward/strafe velocity (anti-jitter)
  private smStrafe = 0;

  constructor(engine: Engine, parent: Entity, public id: string, public name: string, _color: number, models: GameModels) {
    this.engine = engine;
    this.models = models;
    this.entity = parent.createChild("rp-" + id);

    this.weaponMat = new BlinnPhongMaterial(engine);
    this.weaponMat.baseColor = new Color(0.08, 0.08, 0.09, 1);

    const char = instantiate(models[CHARACTER_MODEL]);
    if (char) this.buildCharacter(char);

    this.weaponHolder = this.entity.createChild("held");
    this.syncWeapon();

    this.entity.isActive = false;
  }

  // ── avatar construction ─────────────────────────────────────────────────────

  private buildCharacter(char: Entity): void {
    char.name = "char";
    this.entity.addChild(char);
    this.charRoot = char;

    // Perf: skinned players are the heaviest thing in a match (N animated 46k-tri
    // rigs). Don't let them cast shadows — the shadow pass would redraw every
    // off-screen operator's geometry each frame — the map/props still cast shadows.
    for (const r of char.getComponentsIncludeChildren(SkinnedMeshRenderer, [])) r.castShadows = false;
    for (const r of char.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = false;

    // the glTF loader attaches an Animator (auto-built controller, states named
    // after the clips). Start it idling so a standing player isn't a frozen T-pose.
    this.animator = char.getComponentsIncludeChildren(Animator, [])[0] ?? char.getComponent(Animator);
    // Complete culling: skip the skeleton/animation evaluation entirely while the
    // avatar is off-screen — the dominant per-frame CPU cost with many players.
    if (this.animator) {
      this.animator.cullingMode = AnimatorCullingMode.Complete;
      // one-shot clips must hold their final frame instead of looping (Death stays
      // prone; Jump doesn't restart mid-air). Locomotion/idle keep the default loop.
      for (const clip of ["Death", "Jump", "JumpBack"]) {
        const st = this.animator.findAnimatorState(clip);
        if (st) st.wrapMode = WrapMode.Once;
      }
    }
    // the actual Idle play is forced on first activation (driveAnimation), since
    // the avatar is built inactive and re-enabling resets the animator's pose.

    // the right-hand bone drives the held weapon so it tracks the arm every frame.
    // (glTF tooling may strip the "mixamorig:" prefix's colon, so match by suffix.)
    this.handBone = char.findByName("mixamorig:RightHand") ?? findBoneBySuffix(char, "RightHand");
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
    const meta = modelMetaOf(folder);
    // where the hand grips this model (model-local). OPTIONAL — without one the weapon
    // seats at the mount origin by scale only (the model origin lands on the hand),
    // which for models whose origin isn't the grip makes the gun float in the hand.
    const grip = modelAnchor(meta, "grip");
    const m = instantiate(this.models[folder]);
    if (!m) return;
    // geometry-only weapon glTFs render with a flat default material — give the
    // third-person weapon a plain dark matte so it reads as a gun at a distance.
    for (const r of m.getComponentsIncludeChildren(MeshRenderer, [])) {
      r.castShadows = true;
      for (let i = 0; i < r.getMaterials().length; i++) r.setMaterial(i, this.weaponMat);
    }
    // Parent to the hand bone via a "mount" whose fixed rotation corrects the bone's
    // rest frame to the aim frame (TP_HAND_ROT), matching the model's forward-facing
    // authored orientation. Fall back to the yaw-aligned holder if the bone is missing.
    // Scale is compensated for the bone's world scale (the skeleton lives in a
    // centimetre-scaled subtree).
    const parent = this.handBone ?? this.weaponHolder;
    const mount = parent.createChild("wep-mount");
    mount.transform.setRotation(TP_HAND_ROT[0], TP_HAND_ROT[1], TP_HAND_ROT[2]);
    mount.transform.setPosition(TP_HAND_OFFSET[0], TP_HAND_OFFSET[1], TP_HAND_OFFSET[2]);
    const ws = this.handBone ? this.handBone.transform.lossyWorldScale.x : 1;
    const inv = Math.abs(ws) > 1e-6 ? 1 / ws : 1;
    const s = (meta.scale ?? 1) * inv;
    m.transform.setScale(s, s, s);
    // Seat by the grip anchor: orient the model by the grip's rotation, then offset it
    // so the grip point lands at the mount origin (the hand) — P = −R·S·gripPos. With
    // no grip authored, leave the model at the mount origin (scale only).
    if (grip) {
      const gr = grip.rot ?? [0, 0, 0];
      m.transform.setRotation(gr[0], gr[1], gr[2]);
      const g = new Vector3(grip.at[0] * s, grip.at[1] * s, grip.at[2] * s);
      Vector3.transformByQuat(g, m.transform.rotationQuaternion, g);
      m.transform.setPosition(-g.x, -g.y, -g.z);
    }
    mount.addChild(m);
    this.heldEntity = mount; // destroying the mount drops the weapon with it
  }

  // ── disguise (prop hunt) ─────────────────────────────────────────────────────

  /** prop-hunt: swap the humanoid for a disguise prop. `model` names a model from the
   *  prop-hunt pool (rebuilt if it changed); a null/missing model falls back to a plain
   *  crate so a hider is always *something*. */
  setDisguise(on: boolean, model: string | null = null, lib: MaterialLibrary | null = null): void {
    // a newly-available material library re-shades the current disguise (the lib loads
    // async at startup; a disguise built before it was ready would be untextured)
    const relibbed = on && lib !== null && lib !== this.disguiseLib && this.disguise !== null;
    this.disguiseLib = lib;
    if (on && (this.disguise === null || model !== this.disguiseModel || relibbed)) this.buildDisguise(model);
    if (on === this.disguised) return;
    this.disguised = on;
    if (this.charRoot) this.charRoot.isActive = !on;
    this.weaponHolder.isActive = !on;
    if (this.disguise) this.disguise.isActive = on;
  }

  /** (re)build the disguise prop: the named pool model (calibrated) or a plain crate */
  private buildDisguise(model: string | null): void {
    this.disguise?.destroy();
    this.disguiseModel = model;
    const holder = this.entity.createChild("disguise");
    const prop = model ? buildProp(this.models, model, this.disguiseLib ?? undefined) : null;
    if (prop) {
      for (const r of prop.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = true;
      holder.addChild(prop);
    } else {
      const m = new BlinnPhongMaterial(this.engine);
      m.baseColor = new Color(0.42, 0.3, 0.16, 1);
      const box = holder.createChild("c");
      box.transform.setPosition(0, 0.42, 0);
      const r = box.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(this.engine, 0.84, 0.84, 0.84);
      r.setMaterial(m);
      r.castShadows = true;
    }
    holder.isActive = this.disguised;
    this.disguise = holder;
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

    this.syncDeath();
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
    this.syncDeath();
    this.applyTransform();
    this.syncWeapon();
    this.driveAnimation();
  }

  /** Latch the death animation on the alive→dead edge, BEFORE applyTransform runs — so
   *  the entity never toggles inactive at death (re-activating would reset the animator
   *  to its bind/T-pose). The Death clip plays once and holds prone until respawn. */
  private syncDeath(): void {
    if (this.disguised) return;
    if (!this.alive) {
      if (this.deathPlayed) return;
      this.wasActive = true; this.locoState = "Death";
      // Galacean quirk: the very first play() right after the avatar (re)activates can
      // be swallowed (renders the bind/T-pose), so (re)issue it for the first two death
      // frames before latching — a single delayed play is enough to make it stick.
      if (this.animator?.findAnimatorState("Death")) this.animator.play("Death");
      if (++this.deathKick >= 2) this.deathPlayed = true;
    } else if (this.deathPlayed || this.deathKick) {
      this.deathPlayed = false; this.deathKick = 0; this.locoState = ""; // respawned
    }
  }

  private applyTransform(): void {
    // keep a just-killed avatar visible so its Death clip can play out (it lies prone
    // until the game respawns it); disguised crates and live avatars follow `alive`.
    // Use deathKick (set on the first dead frame, before this runs) so the entity never
    // deactivates — a toggle would reset the animator to its bind/T-pose.
    this.entity.isActive = this.alive || (this.deathKick > 0 && !this.disguised);
    this.entity.transform.setPosition(this.pos.x, this.pos.y, this.pos.z);
    // the operator rig is authored facing +Z, but the player's forward (body.yaw) points
    // −Z, so add 180° to turn the avatar to look where it's actually aiming/moving.
    this.entity.transform.setRotation(0, (this.yaw * 180) / Math.PI + 180, 0);
    // crouch: settle the whole avatar down a touch (the crate never crouches)
    const s = this.disguised ? 1 : this.crouched ? 0.82 : 1;
    this.entity.transform.setScale(1, s, 1);
  }

  /** pick Death / Jump / directional Run·Walk / Idle from the interpolated motion */
  private driveAnimation(): void {
    if (!this.animator || this.disguised) return;
    const now = performance.now() / 1000;
    const dt = now - this.prevT;
    this.prevT = now;
    let vx = 0, vz = 0, vy = 0;
    if (dt > 1e-4 && dt < 0.5) {
      vx = (this.pos.x - this.prevX) / dt;
      vz = (this.pos.z - this.prevZ) / dt;
      vy = (this.pos.y - this.prevY) / dt;
    }
    this.prevX = this.pos.x; this.prevZ = this.pos.z; this.prevY = this.pos.y;

    if (!this.alive) return; // death handled in syncDeath (before the transform toggle)

    // re-enabling the entity resets the animator to its default pose (T-pose), so
    // force a fresh play whenever the avatar comes (back) on-screen.
    const justActivated = !this.wasActive;
    this.wasActive = true;

    // resolve movement into the avatar's own frame (forward = where it faces / aims,
    // matching the game's yaw convention: forward = (-sinYaw,-cosYaw), right = (cosYaw,-sinYaw)).
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd = vx * -sy + vz * -cy;
    const strafe = vx * cy + vz * -sy;
    // light smoothing so interpolation jitter doesn't flip clips every frame
    const a = 0.35;
    this.smFwd += (fwd - this.smFwd) * a;
    this.smStrafe += (strafe - this.smStrafe) * a;
    const sp = Math.hypot(this.smFwd, this.smStrafe);

    const airborne = vy > 1.8 || vy < -5.5;
    const want = airborne ? (this.smFwd < -0.2 ? "JumpBack" : "Jump")
      : sp > LOCO_WALK ? locoClip(this.smFwd, this.smStrafe, sp > LOCO_RUN)
      : "Idle";
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

/** recursive fallback for finding a bone whose name ends with `suffix` regardless
 *  of prefix formatting (e.g. "mixamorig:RightHand" or "mixamorigRightHand") — the
 *  suffix match avoids grabbing a child like "…RightHandThumb1". */
function findBoneBySuffix(e: Entity, suffix: string): Entity | null {
  for (let i = 0; i < e.children.length; i++) {
    const c = e.children[i];
    if (c.name.endsWith(suffix)) return c;
    const hit = findBoneBySuffix(c, suffix);
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
