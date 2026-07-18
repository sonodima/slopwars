// ─── Remote players: animated 3D avatar, interpolation buffer, hitboxes ──────
// The avatar is a rigged, skeletally-animated humanoid (the "operator" model in
// the asset catalog — a realistic CS-style tactical operator, mixamorig skeleton,
// Idle/Walk/Run/Jump + rifle clips). The locomotion state is driven from the
// interpolated motion, and the player's current weapon is parented to the right
// hand bone so it tracks the arm. The operator always shows its own standard
// textures (no team tint); prop-hunt swaps the whole humanoid for a disguise prop
// (a model from the map's prop-hunt pool, or a plain crate when the pool is empty).
import {
  AnimationClip, Animator, AnimatorCullingMode, BlinnPhongMaterial, Color, Engine, Entity,
  MeshRenderer, PrimitiveMesh, Quaternion, SkinnedMeshRenderer, Vector3, WrapMode,
} from "@galacean/engine";
import { modelAnchor } from "@slopwars/shared";
import { AABB, rayAABB } from "./map";
import { GameModels, buildProp, instantiate, modelMetaOf } from "./models";
import { shadeModelSlots, type MaterialLibrary } from "./materials";
import { INTERP_DELAY, PlayerState, Vec3, WeaponId, clamp } from "./types";

interface Sample { time: number; p: [number, number, number]; yaw: number; pitch: number; g?: boolean }

/** asset-catalog folder name of the rigged character used for every remote avatar */
const CHARACTER_MODEL = "operator";

/** which catalog model each weapon shows in a remote's hands — the SAME models the
 *  local player holds in first person, so you carry the gun everyone else sees. */
const TP_WEAPON: Partial<Record<WeaponId, string>> = {
  ak47: "wep_ak47",
  usp: "wep_makarov",
  luger: "wep_luger",
  m4a1: "wep_m4a1",
  suomi: "wep_suomi",
  grease: "wep_grease",
  shotgun: "wep_shotgun",
  awp: "wep_sniper",
  knife: "wep_knife",
  he: "wep_frag",
  mol: "wep_molotov",
  flash: "wep_flashbang",
  smoke: "wep_smoke",
  portalgun: "wep_grease", // same placeholder the first-person viewmodel uses
};

// The weapon is parented to `mixamorig:RightHand` so it follows the arm through every
// clip. Every weapon's geometry sits barrel-down-−Z / top-up-+Y in the mount's frame
// (some glTFs carry their own root rotation, but their `muzzle` anchors — authored in
// this same frame — all point −Z, so the mount frame is uniform across the set). The
// hand bone's frame differs from that, so this fixed correction rotates the weapon into
// the hand's aim frame. Measured against the operator's weapon-hold pose: it puts the
// barrel on the avatar's facing (dot 0.99) with the gun's top up (dot 0.99).
const TP_HAND_ROT: [number, number, number] = [90, 90, 0];
// small extra offset (metres, hand frame) to seat the weapon in the palm rather than
// dead-centre on the bone pivot.
const TP_HAND_OFFSET: [number, number, number] = [0, 0, 0];
// third-person held weapons read too small at the operator's real (1.8 m) size — the
// authored meta.scale suits the first-person viewmodel. Bump them up in the hand.
const TP_WEAPON_SCALE = 1.5;
// grenades/molotov are chunky compared to a gun; the gun bump (1.5×) makes them read as
// oversized boulders in the fist. Hold throwables closer to their real size instead.
const TP_THROWABLE_SCALE = 0.95;
const THROWABLES: WeaponId[] = ["he", "mol", "flash", "smoke"];

const LOCO_RUN = 4.5;  // m/s above which the avatar plays Run
const LOCO_WALK = 0.7; // m/s above which the avatar plays Walk

/** Ground speed (m/s) each locomotion clip is rate-matched against: animator.speed =
 *  realSpeed / ref. Tuned to the game's (fast) move speeds so the clips play near 1x at
 *  a normal run instead of frantically — a bump here slows the whole set proportionally. */
const CLIP_REF_SPEED: Record<string, number> = {
  Walk: 3.2, WalkBack: 3.2, StrafeLeft: 3.2, StrafeRight: 3.2, Run: 9.0, RunBack: 8.0,
};
const ANIM_SPEED_MIN = 0.55, ANIM_SPEED_MAX = 1.6;

// randomized death sets (see NOTICE.txt): body deaths vs headshot-specific deaths.
const DEATHS_BODY = ["DeathFront", "DeathBack", "DeathRight", "Death"];
const DEATHS_HEAD = ["DeathFrontHead", "DeathBackHead"];

// clips that must loop seamlessly vs. one-shots that hold their final frame. Future
// clips (Falling, TurnLeft/Right, JumpStart, Landing) are listed so they Just Work
// once present in the glb.
const LOOP_CLIPS = [
  "Idle", "Walk", "WalkBack", "StrafeLeft", "StrafeRight", "Run", "RunBack", "Falling",
];
const ONCE_CLIPS = [
  "Jump", "JumpBack", "JumpStart", "Landing", "Fire", "Reload", "ThrowGrenade",
  "TurnLeft", "TurnRight", "StartWalk", "StartWalkBack", "StopWalk", "StopWalkBack",
  ...DEATHS_BODY, ...DEATHS_HEAD,
];
const pick = (a: string[]): string => a[(Math.random() * a.length) | 0];

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
  alive = true;
  disguised = false; // prop-hunt: rendered as a crate
  netGround = true;  // latest onGround from the driver (network push / setPose) — re-broadcast by the host

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
  private weaponLib: MaterialLibrary | null = null;  // shades the held weapon's slot materials

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
  private deathClip = "";        // chosen death variant (markDead); empty → random on death
  private smFwd = 0;             // smoothed local forward/strafe velocity (anti-jitter)
  private smStrafe = 0;
  private renderVisible = true;  // avatar renderers on/off (hides without resetting the animator)
  private groundHint: boolean | null = null; // real onGround from the driver (null = infer from vy)
  private airborne = false;      // latched airborne state for the jump state machine
  private airT = 0;              // seconds spent airborne (drives takeoff → fall phasing)
  private landTimer = 0;         // seconds left of the landing recover clip
  private upperTimer = 0;        // seconds left of a one-shot upper-body clip (reload/throw)

  constructor(engine: Engine, parent: Entity, public id: string, public name: string, _color: number, models: GameModels) {
    this.engine = engine;
    this.models = models;
    this.entity = parent.createChild("rp-" + id);

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

    // Players cast shadows so they're grounded in the scene (matches the map/props).
    // Animation is still culled off-screen (below) to keep the skeleton cost down.
    for (const r of char.getComponentsIncludeChildren(SkinnedMeshRenderer, [])) r.castShadows = true;
    for (const r of char.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = true;

    // the glTF loader attaches an Animator (auto-built controller, states named
    // after the clips). Start it idling so a standing player isn't a frozen T-pose.
    this.animator = char.getComponentsIncludeChildren(Animator, [])[0] ?? char.getComponent(Animator);
    // Complete culling: skip the skeleton/animation evaluation entirely while the
    // avatar is off-screen — the dominant per-frame CPU cost with many players.
    if (this.animator) {
      this.animator.cullingMode = AnimatorCullingMode.Complete;
      // Explicit wrap modes: locomotion/idle must loop seamlessly (Galacean's default
      // wrap can hitch at the loop point); every one-shot (deaths, jump, reload, throw)
      // must play once and hold its final frame instead of restarting.
      for (const clip of LOOP_CLIPS) {
        const st = this.animator.findAnimatorState(clip);
        if (st) {
          st.wrapMode = WrapMode.Loop;
          // the shipped locomotion clips don't end exactly on their first pose (Walk is
          // off by a little, Run by a lot), so a raw Loop pops every cycle — seam them.
          if (st.clip) seamLoopClip(st.clip);
        }
      }
      for (const clip of ONCE_CLIPS) {
        const st = this.animator.findAnimatorState(clip);
        if (st) st.wrapMode = WrapMode.Once;
      }
      this.buildJumpStates();
    }
    // the actual Idle play is forced on first activation (driveAnimation), since
    // the avatar is built inactive and re-enabling resets the animator's pose.

    // the right-hand bone drives the held weapon so it tracks the arm every frame.
    // (glTF tooling may strip the "mixamorig:" prefix's colon, so match by suffix.)
    this.handBone = char.findByName("mixamorig:RightHand") ?? findBoneBySuffix(char, "RightHand");
  }

  /** Split the shipped single Jump clip into takeoff / airborne / landing phases so the
   *  avatar plays a proper jump (start jump → flying → stop jump) instead of playing the
   *  whole crouch-leap-land cycle once and freezing its final (landed) frame mid-air —
   *  which read as a crooked jump. Each phase is a state over a normalized sub-range of
   *  the same clip. Skipped cleanly if the glTF ever ships dedicated Jump* clips. */
  private buildJumpStates(): void {
    const a = this.animator;
    if (!a) return;
    const clip = a.findAnimatorState("Jump")?.clip;
    const sm = a.animatorController?.layers?.[0]?.stateMachine;
    if (!clip || !sm) return;
    const mk = (name: string, start: number, end: number, wrap: WrapMode, speed = 1): void => {
      if (a.findAnimatorState(name)) return; // a real clip by this name wins
      const st = sm.addState(name);
      st.clip = clip;
      st.clipStartTime = start;
      st.clipEndTime = end;
      st.wrapMode = wrap;
      st.speed = speed;
    };
    mk("JumpStart", 0.0, 0.32, WrapMode.Once);  // crouch + push off
    // airborne: a FROZEN pose at the leap's apex (state speed 0 — playback never
    // advances, the crossfade just blends into this fixed frame). Any *playing*
    // sub-range of the Jump clip carries the hips through the leap arc, which read
    // as the avatar rapidly bobbing / trembling while in the air.
    mk("Falling", 0.45, 1.0, WrapMode.Once, 0);
    mk("Landing", 0.68, 1.0, WrapMode.Once);    // touchdown + recover
  }

  /** show/hide the avatar's renderers WITHOUT toggling the entity or animator active
   *  state — re-activating an entity resets its animator to the bind (T-)pose, so the
   *  local player's own operator is kept active + warm even in first person and merely
   *  hidden, so its death clip plays instead of a frozen T-pose when you're killed. */
  setVisible(v: boolean): void {
    if (this.renderVisible === v) return;
    this.renderVisible = v;
    if (this.charRoot) {
      for (const r of this.charRoot.getComponentsIncludeChildren(SkinnedMeshRenderer, [])) r.enabled = v;
      for (const r of this.charRoot.getComponentsIncludeChildren(MeshRenderer, [])) r.enabled = v;
    }
    this.applyWeaponVisible();
  }

  /** keep a (re)built held weapon in step with the avatar's current visibility */
  private applyWeaponVisible(): void {
    if (!this.heldEntity) return;
    for (const r of this.heldEntity.getComponentsIncludeChildren(MeshRenderer, [])) r.enabled = this.renderVisible;
  }

  // ── spawn-protection ghosting ───────────────────────────────────────────────

  /** while spawn-protected, the whole avatar (body, held weapon, disguise) fades to a
   *  translucent hologram so an untouchable player reads as untouchable. Change-guarded —
   *  the caller drives it per frame off the protection clock. */
  private ghost = false;
  setGhost(on: boolean): void {
    if (on === this.ghost) return;
    this.ghost = on;
    this.applyGhost(this.entity);
  }

  /** (re)apply the current ghost alpha to a subtree. Materials are per-renderer INSTANCE
   *  clones (getInstanceMaterials) — the shared model/library materials, used by the map
   *  and every other avatar, are never mutated. Also called for a freshly built held
   *  weapon / disguise so a rebuild mid-protection stays translucent. */
  private static readonly GHOST_ALPHA = 0.45;
  private applyGhost(root: Entity): void {
    const apply = (r: SkinnedMeshRenderer | MeshRenderer): void => {
      for (const m of r.getInstanceMaterials()) {
        const bm = m as unknown as { isTransparent?: boolean; baseColor?: Color };
        if (!bm || !bm.baseColor) continue;
        bm.isTransparent = this.ghost;
        const c = bm.baseColor;
        c.a = this.ghost ? RemotePlayer.GHOST_ALPHA : 1;
        bm.baseColor = c; // reassign to flag the material dirty
      }
    };
    for (const r of root.getComponentsIncludeChildren(SkinnedMeshRenderer, [])) apply(r);
    for (const r of root.getComponentsIncludeChildren(MeshRenderer, [])) apply(r);
  }

  // ── held weapon ─────────────────────────────────────────────────────────────

  /** the library the held weapon shades against. It loads async at startup (see
   *  main.applyWeaponMaterials), so a weapon built before it was ready is re-shaded
   *  here rather than staying untextured. */
  setWeaponLibrary(lib: MaterialLibrary): void {
    if (this.weaponLib === lib) return;
    this.weaponLib = lib;
    const folder = this.heldWeapon ? TP_WEAPON[this.heldWeapon] : undefined;
    if (this.heldEntity && folder) shadeModelSlots(this.heldEntity, modelMetaOf(folder), lib);
  }

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
    // where the hand grips this model. OPTIONAL — without one the weapon seats at the
    // mount origin by scale only (the model origin lands on the hand), which for models
    // whose origin isn't the grip makes the gun float in the hand.
    const grip = modelAnchor(meta, "grip");
    const m = instantiate(this.models[folder]);
    if (!m) return;
    // Guns are geometry-only glTFs — their surfaces come from the model's assigned
    // materials, exactly like the first-person viewmodel (weapons.applyModelMaterials).
    // Shade against the same library so the gun in a remote's hands matches the one you
    // carry. The library loads async at startup; setWeaponLibrary re-shades if it lands
    // after this build.
    for (const r of m.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = true;
    if (this.weaponLib) shadeModelSlots(m, meta, this.weaponLib);
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
    const bump = THROWABLES.includes(this.weapon) ? TP_THROWABLE_SCALE : TP_WEAPON_SCALE;
    const s = (meta.scale ?? 1) * inv * bump;
    m.transform.setScale(s, s, s);
    // Seat by the grip anchor. `grip.at` is authored in the model's own displayed frame —
    // the same frame as `muzzle` — so it takes the model's scale but NOT its rotation:
    // offsetting the model by −at·s drops that point onto the hand. Never set the model's
    // own rotation here. Several weapon glTFs bake one in (the luger's 180° among them),
    // and the set only reads barrel-−Z with it intact; overwriting it held those weapons
    // backwards. `grip.rot` is instead an optional extra turn *about the grip point* (the
    // knife needs one to point its blade forward; the guns need none) — a wrapper entity
    // carries it so the engine composes the rotation and the model keeps its own.
    let host = mount;
    if (grip?.rot) {
      host = mount.createChild("wep-grip");
      host.transform.setRotation(grip.rot[0], grip.rot[1], grip.rot[2]);
    }
    if (grip) m.transform.setPosition(-grip.at[0] * s, -grip.at[1] * s, -grip.at[2] * s);
    host.addChild(m);
    this.heldEntity = mount; // destroying the mount drops the weapon with it
    this.applyWeaponVisible(); // a freshly-built weapon inherits the avatar's visibility
    if (this.ghost) this.applyGhost(mount); // …and its spawn-protection translucency
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
    if (this.ghost) this.applyGhost(holder); // rebuilt mid-protection → stays translucent
  }

  push(s: PlayerState, time: number, hpOverride?: number): void {
    this.hp = hpOverride ?? s.hp;
    this.weapon = s.w;
    if (s.g !== undefined) this.netGround = s.g;
    this.buf.push({ time, p: s.p, yaw: s.yaw, pitch: s.pitch, g: s.g });
    // keep only what interpolation can ever look at (~INTERP_DELAY at TICK_RATE, plus
    // slack) — a deep buffer just made the per-frame search scan dead samples
    if (this.buf.length > 8) this.buf.shift();
  }

  update(now: number): void {
    this.groundHint = null; // default: infer from motion (used when a sample carries no flag)

    // Interpolate the transmitted position whether alive OR dead. A dead player keeps
    // stepping its real body physics and broadcasting it every tick, so a body killed
    // mid-air follows its true fall to the ground here — the same physics the local
    // player sees in third person — instead of a synthetic gravity approximation. The
    // Death clip is latched in syncDeath; driveAnimation skips locomotion while dead.
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
    // drive the jump/fall animation from the real onGround flag (like the local player /
    // bots) rather than inferring it from noisy interpolated vertical motion.
    this.groundHint = a.g ?? null;

    this.syncDeath();
    this.applyTransform();
    this.syncWeapon();
    this.driveAnimation();
  }

  /** directly drive the avatar (local player's own operator / offline bots — no
   *  interpolation buffer). `groundHint` is the driver's real onGround state, used for
   *  crisp jump takeoff/landing (null → infer from vertical motion). */
  setPose(pos: Vec3, yaw: number, alive: boolean, groundHint: boolean | null = null): void {
    this.pos.x = pos.x; this.pos.y = pos.y; this.pos.z = pos.z;
    this.yaw = yaw;
    this.alive = alive;
    this.groundHint = groundHint;
    if (groundHint !== null) this.netGround = groundHint; // host re-broadcasts bot ground state
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
      if (!this.deathClip) this.deathClip = pick(DEATHS_BODY); // died without a marked variant
      const clip = this.animator?.findAnimatorState(this.deathClip) ? this.deathClip : "Death";
      this.wasActive = true; this.locoState = clip;
      // Galacean quirk: the very first play() right after the avatar (re)activates can
      // be swallowed (renders the bind/T-pose), so (re)issue it for the first two death
      // frames before latching — a single delayed play is enough to make it stick.
      if (this.animator) {
        this.animator.speed = 1; // clear any locomotion rate-scaling for the death clip
        if (this.animator.findAnimatorState(clip)) this.animator.play(clip);
      }
      if (++this.deathKick >= 2) this.deathPlayed = true;
    } else if (this.deathPlayed || this.deathKick) {
      this.deathPlayed = false; this.deathKick = 0; this.deathClip = ""; this.locoState = ""; // respawned
    }
  }

  /** choose the death variant for the next death (call as the player is killed). Headshots
   *  use the headshot-specific clips; otherwise a random body death. */
  markDead(headshot: boolean): void {
    this.deathClip = headshot ? pick(DEATHS_HEAD) : pick(DEATHS_BODY);
  }

  /** play a one-shot upper-body clip (reload / grenade toss) over the current locomotion.
   *  Kept simple: it takes over the single animator layer for `dur` seconds, then
   *  driveAnimation resumes locomotion. Ignored while dead/disguised. */
  triggerUpper(clip: string, dur: number): void {
    if (!this.animator || this.disguised || !this.alive) return;
    if (!this.animator.findAnimatorState(clip)) return;
    this.animator.speed = 1;
    this.animator.crossFade(clip, 0.1);
    this.locoState = clip;
    this.upperTimer = dur;
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

    // a one-shot upper-body clip (reload / grenade toss) owns the animator until it ends
    if (this.upperTimer > 0) {
      this.upperTimer -= dt;
      this.wasActive = true;
      return;
    }

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

    // ── airborne state machine: takeoff → flying (loop) → landing ───────────────
    // Prefer the driver's real ground state when it supplies one (local player / bots);
    // network remotes have only interpolated position, so infer airborne from vertical
    // speed with a little hysteresis so the apex (where vy≈0) doesn't flicker to ground.
    let air: boolean;
    if (this.groundHint !== null) air = !this.groundHint;
    else if (this.airborne) air = vy < -0.6 || this.airT < 0.5; // stay up while descending / just after takeoff
    else air = vy > 2.0;                                        // a clear upward burst = a jump
    this.airT = air ? this.airT + dt : 0;
    if (air && !this.airborne) this.landTimer = 0;              // takeoff edge
    else if (!air && this.airborne) this.landTimer = 0.24;      // landing edge → play the recover
    this.airborne = air;

    let want: string;
    if (air) {
      want = this.airT < 0.3 ? "JumpStart" : "Falling"; // brief takeoff pose, then the looping flying pose
    } else if (this.landTimer > 0) {
      this.landTimer -= dt;
      // a fast landing rolls straight into a run; otherwise play the touchdown recover
      want = sp > LOCO_RUN ? locoClip(this.smFwd, this.smStrafe, true) : "Landing";
      if (want !== "Landing") this.landTimer = 0;
    } else {
      want = sp > LOCO_WALK ? locoClip(this.smFwd, this.smStrafe, sp > LOCO_RUN) : "Idle";
    }
    // fall back to the shipped one-shot Jump clip if the phased states aren't present
    if ((want === "JumpStart" || want === "Falling" || want === "Landing") && !this.animator.findAnimatorState(want)) {
      want = "Jump";
    }
    if ((want !== this.locoState || justActivated) && this.animator.findAnimatorState(want)) {
      this.locoState = want;
      if (justActivated) this.animator.play(want);
      else this.animator.crossFade(want, want === "JumpStart" ? 0.06 : 0.15);
    }
    // rate-match locomotion playback to the real speed so the animation slows/speeds
    // with the player (and the feet stop sliding). Idle/Jump/etc. run at normal speed.
    const ref = CLIP_REF_SPEED[want];
    this.animator.speed = ref ? clamp(sp / ref, ANIM_SPEED_MIN, ANIM_SPEED_MAX) : 1;
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
    // body AABB (world, yaw-agnostic approximation)
    const body: AABB = {
      min: { x: this.pos.x - 0.36, y: this.pos.y, z: this.pos.z - 0.36 },
      max: { x: this.pos.x + 0.36, y: this.pos.y + 1.58, z: this.pos.z + 0.36 },
    };
    // head sphere
    const hc = { x: this.pos.x, y: this.pos.y + 1.72, z: this.pos.z };
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

/** Make a locomotion clip loop seamlessly by rewriting each curve's LAST keyframe to
 *  its FIRST pose. The operator glb's loop clips don't quite return to their start pose
 *  (Walk's feet are ~0.06 off, Run's thigh ~0.25), so WrapMode.Loop snapped every cycle —
 *  the walking "hitch". Overwriting the final key makes the last frame interval blend
 *  back into the exact start pose instead. Quaternions are sign-matched to the outgoing
 *  key (q and −q are the same rotation, but lerping across the sign flip spins the bone).
 *  Clips are shared engine resources: running this twice is a no-op, so every
 *  RemotePlayer instance can call it safely. */
function seamLoopClip(clip: AnimationClip): void {
  for (const b of clip.curveBindings) {
    const keys = b.curve?.keys;
    if (!keys || keys.length < 2) continue;
    const first = keys[0].value;
    const last = keys[keys.length - 1].value;
    if (first instanceof Quaternion && last instanceof Quaternion) {
      const dot = first.x * last.x + first.y * last.y + first.z * last.z + first.w * last.w;
      const s = dot < 0 ? -1 : 1;
      last.set(first.x * s, first.y * s, first.z * s, first.w * s);
    } else if (first instanceof Vector3 && last instanceof Vector3) {
      last.copyFrom(first);
    } else if (typeof first === "number" && typeof last === "number") {
      keys[keys.length - 1].value = first;
    }
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
