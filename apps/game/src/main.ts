// ─── Bootstrap + game orchestration ──────────────────────────────────────────
import {
  AmbientLight, Animator, BackgroundMode, BlinnPhongMaterial, BloomEffect, Camera, Color,
  DirectLight, Engine, Entity, FogMode, MSAASamples, MeshRenderer, PostProcess,
  PrimitiveMesh, Quaternion, ShadowResolution, ShadowType, SkinnedMeshRenderer, SkyBoxMaterial,
  TextureCube, TonemappingEffect, TonemappingMode, UnlitMaterial, Vector3,
} from "@galacean/engine";
import { sfx } from "./audio";
import { loadHDRCube, setAssetLog } from "./assets";
import { Hud } from "./hud";
import { GameMap } from "./map";
import catalog from "virtual:asset-catalog";
import { resolveTextures } from "./textures";
import { mapTextureFolders } from "./objects";
import { MaterialLibrary, materialTextureFolders } from "./materials";
import { GameModels } from "./models";
import { MapEnv, ModelMeta, ShadowQuality, envSunColor, modelMaterials } from "./maps/schema";
import { applyFogFalloff, applyPost, applyShadows } from "./rendersettings";
import {
  DEFAULT_MAP, loadMapPool, mapById, mapMetas, pickVotedMap, randomMapId, tallyVotes,
} from "./maps";
import { HE_DAMAGE, HE_RADIUS, MOL_RADIUS, MOL_TICK_DMG, NadeKind, Projectiles } from "./nades";
import { Net } from "./net";
import { PhysicsWorld, type PropSim } from "./physics";
import { PhysxProps, createGameEngine } from "./physxprops";
import { Input, PlayerBody } from "./player";
import { RemotePlayer } from "./remote";
import { MODEL_LOAD_COUNT, buildProp, instantiate, loadModels, propHuntPool } from "./models";
import {
  BOT_TUNING, DEFAULT_CONFIG, GamePhase, GameSnapshot, INTERMISSION, MatchConfig, MAX_HP, ModeId, pickBotWeapon,
  MOVE_BACK_FACTOR, MOVE_STRAFE_FACTOR, Msg,
  PICKUP_HEAL, PICKUP_RADIUS, PICKUP_RESPAWN, Platform, PlayerState, POWERUPS, POWERUP_INTERVAL,
  POWERUP_RADIUS, PowerupKind, QUAD_MULT, RAPID_MULT, SPEED_MULT, TICK_RATE,
  MOVE, Vec3, WEAPONS, WeaponDef, WeaponId, DeathCause, deathCauseLabel, LOADOUT, clamp, rand, randomPowerup,
} from "./types";
import {
  DEFAULT_MODE, GUNGAME_FINAL, MODES, PROPHUNT_PREP, ROLE_HIDE, ROLE_SEEK,
  TEAM_COLORS, TEAM_NAMES, seekerCount, tierWeapon,
} from "./modes";
import { Voice } from "./voice";
import { NpcChat, Relation, initNpcChat } from "./npcchat";
import { TouchControls } from "./touch";
import { GamepadControls } from "./gamepad";
import { Settings } from "./settings";
import { TracerPool, WeaponSystem } from "./weapons";

interface BotAI {
  id: string;
  body: PlayerBody;
  weapon: WeaponId;      // the weapon it's holding right now (non-gungame; switches with context)
  arsenal: WeaponId[];   // the weapons it owns and can switch between by range / when dry
  mag: number;           // rounds left in the current magazine (-1 = melee, no mag)
  reloadCd: number;      // >0 while reloading — can't fire until it finishes
  switchCd: number;      // debounce so range-based weapon swaps don't flip-flop every frame
  fireCd: number;
  burstCd: number;       // short pause between bursts so autos don't hose one endless stream
  retargetCd: number;
  targetId: string | null;
  strafe: number;
  strafeCd: number;
  // ─ perception + human-like aim ─
  seen: boolean;         // clear line of sight to the current target *this* frame
  reactCd: number;       // reaction delay counting down after freshly spotting a target
  memoryCd: number;      // remaining memory of a target that broke line of sight
  lastKnown: Vec3 | null;// last position the target was actually seen at (hunted when lost)
  aimErrX: number;       // slow-drifting aim wobble, yaw / pitch (rad)
  aimErrY: number;
  aimErrCd: number;      // time until the wobble picks a new drift target
  avoidCd: number;       // hold time on the current wall-avoidance peel direction
  avoidSign: number;     // which way (+1/-1) the bot is currently steering around an obstacle
  wanderYaw: number;     // heading used while it has nothing to chase
  lastHp: number;        // hp last frame — a drop means it took fire → juke-hop
  dodgeLockCd: number;   // refractory period so the on-hit sideways juke is occasional, not a twitch
}

// ─── bot aim math: turn toward a heading at a capped rate instead of snapping ──
function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
/** step `cur` toward `tgt` by at most `maxStep` radians (shortest way round). */
function approachAngle(cur: number, tgt: number, maxStep: number): number {
  const d = normAngle(tgt - cur);
  if (Math.abs(d) <= maxStep) return tgt;
  return normAngle(cur + Math.sign(d) * maxStep);
}

/** Fisher–Yates copy — returns a new shuffled array, leaving the input untouched. */
function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** escape a string for safe use inside a RegExp (bot names → word-boundary match). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// delay from pressing throw to the grenade leaving the hand — matches the toss
// animation's wind-up so the projectile releases in sync with the arm.
const THROW_WINDUP_MS = 350;
// gamepad look speed (rad/s) at full right-stick deflection, before the sensitivity
// setting scales it — tuned so aim feels responsive but controllable on a controller.
const GP_LOOK_RATE = 3.2;

// ─── Aim assist (controller + touch only) ─────────────────────────────────────
// Two classic console/mobile aids, both scaled by the Settings strength (0..1):
//  • friction  — look input slows as the crosshair nears an enemy, so you don't overshoot
//  • follow    — the aim tracks a fraction of a *moving* target's drift, so strafers stick
// It never pulls a stationary target onto the crosshair (no soft-lock / auto-aim), only
// helps you stay on one you've already found — "enough that it helps", not an aimbot.
const AA_BUBBLE = 0.16;        // rad (~9°) angular radius around the crosshair where assist engages
const AA_RANGE = 55;           // m — beyond this there's no assist
const AA_FRICTION_MIN = 0.28;  // dead-centre on a target, look input slows to this (at full strength)
const AA_FRICTION_CURVE = 0.55; // <1 = friction ramps up early (strong over more of the bubble, not just dead-centre)
const AA_FOLLOW = 0.62;        // fraction of a target's horizontal angular drift the aim follows
const AA_FOLLOW_PITCH = 0.4;   // gentler tracking on the vertical axis
// slow cinematic orbit (rad/s) of the death camera around the fallen body.
const DEATH_CAM_ORBIT_SPEED = 0.4;
// seconds the death orbit plays before a no-respawn player (Prop-Hunt hider) switches
// to spectating a living seeker instead of staring at their own corpse forever.
const SPECTATE_AFTER = 1.8;

class Game {
  engine!: Engine;
  usePhysx = false;   // true once the PhysX rigid-body backend is active
  camera!: Camera;
  camEntity!: Entity;
  map = new GameMap();

  // world/render refs reused across map (re)loads
  root!: Entity;
  models!: GameModels;
  skyMat!: SkyBoxMaterial;
  /** HDRI path → prefiltered cube (loaded once, reused across map switches) */
  hdriCache = new Map<string, Promise<TextureCube>>();
  sunE!: Entity;
  sun!: DirectLight;
  amb!: AmbientLight;
  bloom!: BloomEffect;
  tone!: TonemappingEffect;

  // map rotation + voting
  currentMapId = DEFAULT_MAP;
  mapVotes: Record<string, string> = {}; // host: playerId → map id
  myVote: string | null = null;
  lastVoteCounts: Record<string, number> = {};
  body!: PlayerBody;
  ws!: WeaponSystem;
  lastWeapon: WeaponId | null = null; // weapon held at death — reselected on respawn
  tracers!: TracerPool;
  nades!: Projectiles;
  // dynamic-prop simulation — PhysX rigid bodies when available, else the custom
  // fallback. Starts as the fallback; init() swaps in PhysX after the engine is up.
  physics: PropSim = new PhysicsWorld(this.map);
  hud = new Hud();
  net = new Net();
  voice = new Voice();
  touch = new TouchControls();
  gamepad = new GamepadControls();
  // current local input device (last one used wins). Drives the virtual controls,
  // pointer-lock behaviour, and the platform icon peers see next to this player.
  myPlatform: Platform = "keyboard";
  platforms: Record<string, Platform> = {}; // playerId → their current input device
  private navFocusEl: HTMLElement | null = null; // gamepad menu-navigation focus ring
  // aim assist (controller / touch): per-frame look-input scale (1 = none) + follow state
  aimFriction = 1;
  private aimTargetId: string | null = null;
  private aimPrevTargetPos: Vec3 | null = null; // target aim-point last frame (for follow velocity)
  private touchLookMs = 0;                       // perf-clock ms of the last touch look drag
  settings = new Settings();

  // ── AI opponents (host-driven; may coexist with human guests) ──
  bots = new Map<string, BotAI>();

  // ── Chrome Prompt-API NPC banter (host-only, on-device, best-effort) ──
  npc: NpcChat | null = null;                          // set once the model resolves
  private npcDeaths: Record<string, Record<string, number>> = {}; // victimBot → killer → times killed
  private npcStreakK: Record<string, number> = {};     // humanId → current kill streak (reset on death)
  private npcRival: Record<string, string> = {};       // humanId → botId last traded kills with (chat context)
  private npcWeapon: Record<string, string> = {};       // id → readable weapon it last got a kill with
  private npcBotCd: Record<string, number> = {};       // botId → wall-clock s before it may speak again
  private npcSpontaneousCd = 0;                         // global gate: min gap between unprompted NPC lines
  private npcLog: string[] = [];                        // recent chat lines, for reply context
  private npcReplyCd = 0;                               // wall-clock s before bots may answer chat again

  // ── host match rules (mirrored to guests) ──
  cfg: MatchConfig = { ...DEFAULT_CONFIG };
  leaving = false; // set during an intentional leave (suppresses the unload prompt)

  // third-person self avatar. Prop-Hunt hiders show a disguise crate (selfAvatar);
  // a match with the third-person camera enabled shows the local player as the same
  // rigged operator everyone else sees (selfOperator, built lazily on first use).
  selfAvatar!: Entity;
  selfOperator: RemotePlayer | null = null;

  remotes = new Map<string, RemotePlayer>();
  names = new Map<string, string>();

  // 3D lobby scene (shared with the main menu — same swaying showcase camera + stage)
  lobbyView = false;
  menuView = false;            // main menu shows the same 3D backdrop as the lobby
  private menuAvatar: Entity | null = null; // single showcase operator on the menu stage
  lobbyStageRoot!: Entity;
  lobbyAvatars = new Map<string, Entity>();
  private lobbyAvatarSig = ""; // roster signature the current lobby avatars were built for
  private lobbyTarget = new Vector3(0, 1.3, -6);
  private worldUp = new Vector3(0, 1, 0);

  // authoritative (host) / mirrored (guest)
  phase: GamePhase = "lobby";
  round = 0;
  timeLeft = 0;
  scores: Record<string, { k: number; d: number }> = {};
  hpMap: Record<string, number> = {}; // host only

  // ── game modes ──
  mode: ModeId = DEFAULT_MODE;
  teams: Record<string, number> = {};   // tdm: side 0/1 · prophunt: 0 seeker / 1 hide
  teamScore: [number, number] = [0, 0]; // tdm side scores · prophunt [seeker, hider] wins
  tiers: Record<string, number> = {};   // gungame: player → weapon-ladder tier
  myRole = ROLE_SEEK;                    // prophunt: local role (mirror of teams[myId])

  myHp = MAX_HP;
  alive = true;
  respawnAt = 0;
  private deathTime = 0;                // wall-clock seconds at death (orbit phase)
  private deathYaw = 0;                 // facing at death (orbit start angle)
  private deathLookTarget = new Vector3();
  private spectateId: string | null = null; // seeker being spectated (no-respawn hider)
  inGame = false;
  locked = false;
  sbOpen = false;

  keys = new Set<string>();
  fireHeld = false;
  sendAcc = 0;
  gameAcc = 0;
  stepAcc = 0;
  triedFireQueued = false;

  q = new Quaternion();

  // pickups
  pkTimers: number[] = [];
  pkEntities: Entity[] = [];
  pkSpin = 0;

  // powerups
  pwEntities: Entity[] = [];
  pwMats: UnlitMaterial[] = [];
  pwActive: (PowerupKind | null)[] = [];
  pwSpawnAcc = 0;
  buff: { kind: PowerupKind; until: number } | null = null;
  dmgMult = 1;

  // stats
  ping = 0;
  pingAcc = 0;
  fpsE = 60;
  statAcc = 0;
  /** worst frame time (s) seen in the current stats window — surfaces *jank*
   *  (spikes) that a smoothed average fps hides; reset each overlay refresh */
  framePeak = 0;

  async start(): Promise<void> {
    // register the PWA service worker up-front (offline shell) — must not wait
    // on the heavy asset load below, so it works even if a load stalls
    this.registerServiceWorker();

    // Kick off the on-device NPC-chat model (Chrome Prompt API) in the background.
    // Best-effort: resolves to a no-op stub on non-Chrome / unsupported devices.
    void initNpcChat().then((n) => {
      this.npc = n;
      this.settings.setAiSupported(n.status !== "unavailable"); // gates the Settings toggle
      this.decideAiDownload();  // consent prompt / resume / auto-provision as appropriate
      this.syncAiChatPref();    // fold the (per-host) preference into the match cfg
    });

    const { engine, physx } = await createGameEngine("game-canvas");
    this.engine = engine;
    this.usePhysx = physx;
    engine.canvas.resizeByClientSize();
    window.addEventListener("resize", () => this.applyResolution());

    const scene = engine.sceneManager.activeScene;
    const root = scene.createRootEntity("root");
    this.root = root;
    // with PhysX available, swap the fallback sim for real rigid bodies (props roll,
    // tumble, stack); colliders are (re)bound to each map on load via syncFromMap().
    if (this.usePhysx) this.physics = new PhysxProps(engine, root, this.map);
    // sky (HDRI) + image-based ambient applied per-map by applyEnv(), below

    // ── lights (env-specific values set by applyEnv on map load) ──
    const sunE = root.createChild("sun");
    sunE.transform.setPosition(0, 30, 0);
    sunE.transform.setRotation(-52, -38, 0);
    const sun = sunE.addComponent(DirectLight);
    sun.color = new Color(1.35, 1.22, 1.0, 1);
    sun.shadowType = ShadowType.SoftHigh;
    sun.shadowStrength = 0.82;
    this.sunE = sunE;
    this.sun = sun;
    scene.shadowResolution = ShadowResolution.High;
    scene.shadowDistance = 70;
    scene.shadowFadeBorder = 0.15;

    const amb: AmbientLight = scene.ambientLight;
    amb.diffuseSolidColor = new Color(0.55, 0.6, 0.72, 1);
    amb.diffuseIntensity = 0.62;
    amb.specularIntensity = 0.85; // specularTexture set from HDRI after load
    this.amb = amb;

    // ── atmosphere ──
    scene.fogMode = FogMode.Linear;
    scene.fogColor = new Color(0.78, 0.74, 0.66, 1);
    scene.fogStart = 40;
    scene.fogEnd = 150;

    // ── camera + post ──
    this.camEntity = root.createChild("camera");
    const cam = this.camEntity.addComponent(Camera);
    this.camera = cam;
    cam.fieldOfView = 75;
    cam.nearClipPlane = 0.05;
    cam.farClipPlane = 220;
    cam.enableHDR = true;
    cam.enablePostProcess = true;
    cam.opaqueTextureEnabled = true;   // lets transmissive water refract the scene
    cam.msaaSamples = MSAASamples.FourX;

    const ppE = root.createChild("post");
    const pp = ppE.addComponent(PostProcess);
    // effect defaults are (re)applied per-map from env.post in applyEnv()
    this.bloom = pp.addEffect(BloomEffect);
    this.bloom.enabled = true;
    this.tone = pp.addEffect(TonemappingEffect);
    this.tone.enabled = true;
    this.tone.mode.value = TonemappingMode.ACES;

    // ── load models with progress (textures + HDRI load lazily, per map) ──
    this.hud.show("loading");
    this.syncTitle();   // tab reads "SlopWars · Loading…" before the tick loop starts
    // pedantic boot log: every asset fetch (mesh/tex/hdri/map) reports its own
    // path to the loading screen — no grouping
    setAssetLog((line) => this.hud.loadingLabel(line));
    const total = MODEL_LOAD_COUNT + 1; // models + first map's texture/sky bundle
    let loaded = 0;
    const bump = (): void => { this.hud.loadingProgress(++loaded / total); };
    this.models = await loadModels(engine, bump);

    // ── HDRI skybox material shell (its texture is set per-map by loadMap) ──
    const skyMat = new SkyBoxMaterial(engine);
    skyMat.textureDecodeRGBM = true;
    scene.background.sky.material = skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);
    amb.specularTextureDecodeRGBM = true;
    this.skyMat = skyMat;

    // ── map (resolves textures + sky, builds geometry/env/pickups) ──
    await loadMapPool();                 // fetch maps/*.json into the registry
    await this.loadMap(DEFAULT_MAP);
    bump();
    setAssetLog(null);                   // stop logging once the boot screen is done

    // ── player + weapons + fx ──
    this.body = new PlayerBody(this.map);
    this.body.teleport({ x: 0, y: 0.1, z: -18 }, 180);
    this.lobbyStageRoot = root.createChild("lobby-avatars");
    this.buildSelfAvatar(root);
    this.ws = new WeaponSystem(engine, this.camEntity, this.models);
    void this.applyWeaponMaterials();   // texture the geometry-only gun viewmodels (async; pops in)
    void this.ensureDisguiseMaterials(); // texture the Prop-Hunt disguise props (async; ready well before any match)
    this.ws.onShoot = (def, spread) => {
      if (def.throwable) this.throwNade(def.id as NadeKind);
      else this.fireHitscan(def, spread);
    };
    this.ws.onAmmoChange = () => this.refreshAmmoHud();
    this.tracers = new TracerPool(engine, root);
    this.nades = new Projectiles(engine, root, this.map, this.models);
    this.nades.onBounce = (p) => { const r = this.relAudio(p); sfx.nadeBounce(r.pan, r.dist); };
    this.nades.onBoom = (p) => { const r = this.relAudio(p); sfx.explosion(r.pan, r.dist); this.physics.applyExplosion(p, HE_RADIUS, 42); };
    this.nades.onBreak = (p) => { const r = this.relAudio(p); sfx.shatter(r.pan, r.dist); };
    this.nades.onIgnite = (p, dur) => { const r = this.relAudio(p); sfx.fire(dur, r.pan, r.dist); };
    this.nades.onExplode = (c, _owner, local) => { if (local) this.explodeDamage(c); };
    this.nades.onFireTick = (c, _owner, local) => { if (local) this.fireTickDamage(c); };

    window.addEventListener("beforeunload", (e) => {
      // warn before an accidental navigation/close mid-match (skipped on an
      // intentional "leave to menu", which sets `this.leaving`). Don't tear the
      // connection down here — the user may cancel; peers detect the drop on close.
      if (this.inGame && !this.leaving) { e.preventDefault(); e.returnValue = ""; return; }
      this.net.leave();
    });
    this.bindInput();
    this.bindTouch();
    this.bindGamepad();
    this.bindSettings();
    this.wireNet();
    this.wireHud();

    // main loop via Script-less tick
    let last = performance.now();
    const loop = (): void => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.tick(dt, now / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    engine.run();

    // warm up combat FX shaders while the menu shows, so the first shot / first
    // explosion don't stall ~800ms compiling shaders (muzzle-flash point-light
    // permutation, tracer/puff/fireball/smoke/particle materials + sphere meshes).
    this.ws.prewarm();
    this.tracers.prewarm();
    this.nades.prewarm();

    this.hud.show("menu");
    this.enterMenu();   // 3D showcase backdrop behind the create/join menu
    // theme music starts on first user gesture (autoplay policy)
    window.addEventListener("pointerdown", () => {
      sfx.unlock();
      if (!this.inGame) sfx.startTheme();
    }, { once: true });

  }

  /** register the PWA service worker (installable / offline shell) in prod only */
  registerServiceWorker(): void {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    // If a controller already exists, this page is being run by an OLD service worker.
    // When a newly-deployed SW claims control (its `activate` purged the stale cache), a
    // one-time reload fetches the fresh HTML/JS/assets — so an updated deploy applies on
    // its own, without the user needing a manual force refresh (incl. iOS PWA). Skipped on
    // the very first install (no prior controller) and while in a match (the reload would
    // interrupt play — the update lands on the next navigation instead).
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing || !hadController || this.inGame) return;
      refreshing = true;
      window.location.reload();
    });
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  bindInput(): void {
    const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.keys.clear(); this.fireHeld = false; }
      if (this.inGame && this.myPlatform === "keyboard") {
        this.hud.clickToPlay(!this.locked);
        // Pressing Esc exits pointer lock *and* the browser swallows that Escape
        // keydown, so the pause menu can never open from the keydown handler while
        // locked. Open it here on any in-game unlock (Esc / alt-tab). Skipped while
        // leaving, or when it's already open.
        if (!this.locked && !this.leaving && !this.settings.isOpen()) this.openSettings();
      }
    });
    canvas.addEventListener("click", () => {
      if (this.myPlatform !== "keyboard") return; // touch / gamepad drive look without pointer lock
      if (this.inGame && !this.locked) canvas.requestPointerLock();
    });
    document.getElementById("click-to-play")!.addEventListener("click", () => {
      if (this.inGame && !this.locked && this.myPlatform === "keyboard") canvas.requestPointerLock();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.inGame || !this.alive) return; // no aiming while dead (cinematic cam)
      const sens = 0.0022 * this.settings.state.sensitivity * (this.ws.scoped ? 0.35 : 1);
      this.body.look(e.movementX, e.movementY, sens);
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.locked || !this.inGame || this.hud.chatOpen) return;
      if (e.button === 0) { this.fireHeld = true; this.triedFireQueued = true; }
      if (e.button === 2 && this.ws.def().scope && this.alive) {
        this.ws.setScope(!this.ws.scoped);
        this.applyScopeFov();
      }
    });
    document.addEventListener("mouseup", (e) => { if (e.button === 0) this.fireHeld = false; });
    document.addEventListener("contextmenu", (e) => { if (this.inGame) e.preventDefault(); });

    document.addEventListener("wheel", (e) => {
      if (!this.locked || !this.inGame || !this.alive || !this.canSwitchWeapon()) return;
      this.ws.cycle(e.deltaY > 0 ? 1 : -1);
      this.applyScopeFov();
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
      // Esc toggles settings (works from the menu too); chat handles its own Esc
      if (e.code === "Escape") {
        if (this.settings.isOpen()) this.settings.close();
        else if (this.inGame && !this.hud.chatOpen) this.openSettings();
        return;
      }
      if (!this.inGame) return;
      if (this.hud.chatOpen) return; // chat input handles its own keys
      if (e.code === "Tab") { e.preventDefault(); this.sbOpen = true; }
      if (!this.locked) return;
      if (e.code === "KeyT" || e.code === "Enter") {
        e.preventDefault();
        this.keys.clear();
        this.fireHeld = false;
        this.hud.openChat();
        return;
      }
      if (e.code === "KeyV") {
        if (this.voice.micOk) {
          this.voice.setMuted(!this.voice.muted);
          this.hud.voice(this.voice.muted ? "muted" : "on");
        }
        return;
      }
      this.keys.add(e.code);
      if (e.code === "KeyR") this.localReload();
      const wi = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(e.code);
      if (wi >= 0 && this.alive && this.canSwitchWeapon()) { this.ws.select(LOADOUT[wi]); this.applyScopeFov(); }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Tab") this.sbOpen = false;
      this.keys.delete(e.code);
    });
  }

  /** the local player is currently an unarmed Prop-Hunt hider */
  isHider(): boolean {
    return this.mode === "prophunt" && this.myRole === ROLE_HIDE;
  }

  applyScopeFov(): void {
    this.camera.fieldOfView = this.ws.scoped ? 22 : this.settings.state.fov;
    this.hud.scope(this.ws.scoped);
    this.hud.crosshair(!this.ws.scoped && this.alive && !this.isHider());
  }

  // ─── camera perspective (first / third person) ────────────────────────────────

  /** true when the camera should sit behind the avatar. Prop-Hunt hiders (disguised
   *  props) are always third-person; otherwise the whole match is third-person when
   *  the host enabled the third-person camera in the lobby. */
  thirdPersonActive(): boolean {
    if (!this.inGame) return false;
    if (this.mode === "prophunt" && this.myRole === ROLE_HIDE) return true;
    // scoping (AWP ADS) drops to a first-person scope even in a third-person match —
    // you can't aim a sniper scope from over the shoulder.
    return this.cfg.thirdPerson && !this.ws.scoped;
  }

  /** build the local player's third-person avatar container (a Prop-Hunt disguise) */
  buildSelfAvatar(root: Entity): void {
    this.selfAvatar = root.createChild("self-avatar");
    this.selfAvatar.isActive = false;
  }

  /** which model the local disguise is currently built from (avoids rebuilding it) */
  private selfDisguiseModel: string | null | undefined = undefined;

  /** (re)build the local player's disguise prop — the model from the prop-hunt pool
   *  assigned to this player, or a plain crate when the pool is empty. */
  refreshSelfDisguise(): void {
    if (!this.selfAvatar) return;
    const model = this.propForPlayer(this.net.myId);
    if (model === this.selfDisguiseModel && this.selfAvatar.children.length) return;
    this.selfDisguiseModel = model;
    this.selfAvatar.clearChildren();
    const prop = model ? buildProp(this.models, model, this.disguiseLib ?? undefined) : null;
    if (prop) {
      for (const r of prop.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = true;
      this.selfAvatar.addChild(prop);
    } else {
      const m = new BlinnPhongMaterial(this.engine);
      m.baseColor = new Color(0.42, 0.3, 0.16, 1);
      const box = this.selfAvatar.createChild("c");
      box.transform.setPosition(0, 0.42, 0);
      const r = box.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(this.engine, 0.84, 0.84, 0.84);
      r.setMaterial(m);
      r.castShadows = true;
    }
  }

  /** position the camera + local avatar for the current perspective */
  updateSelfView(eye: number, pitch: number): void {
    // Dead: cinematic orbit death-cam showing your operator play out its death clip —
    // even in first-person matches. No viewmodel, no aiming (mouse-look is disabled).
    if (!this.alive) {
      this.ws.showViewmodel(false);
      if (this.selfAvatar) this.selfAvatar.isActive = false;
      if (!this.isHider()) {
        const op = this.ensureSelfOperator();
        if (op) { op.setVisible(true); op.weapon = this.ws.current; op.setPose(this.body.pos, this.body.yaw, false, this.body.onGround); }
      }
      // no-respawn hider: brief death orbit, then spectate a living seeker
      if (this.selfNoRespawn() && performance.now() / 1000 - this.deathTime > SPECTATE_AFTER) {
        const tgt = this.spectateTarget();
        if (tgt) { document.body.classList.remove("dead"); this.updateSpectateCam(tgt); return; }
      }
      this.updateDeathCam();
      return;
    }

    const third = this.thirdPersonActive();
    // viewmodel only in first-person while alive (third-person shows the world avatar)
    this.ws.showViewmodel(!third);

    if (!third) {
      // first person: camera at the eye, avatar hidden
      this.camEntity.transform.setPosition(this.body.pos.x, eye, this.body.pos.z);
      if (this.selfAvatar) this.selfAvatar.isActive = false;
      // Keep the operator alive-but-hidden and warm (its animator kept running at the
      // body's pose) rather than deactivating it. Re-activating a dormant avatar resets
      // its animator to the bind/T-pose — which is why dying in a first-person match used
      // to show a frozen T-pose instead of the death animation. Kept active and warm, the
      // death clip plays straight away when you're killed.
      if (!this.isHider()) {
        const op = this.ensureSelfOperator();
        if (op) { op.setVisible(false); op.weapon = this.ws.current; op.setPose(this.body.pos, this.body.yaw, this.alive, this.body.onGround); }
      } else if (this.selfOperator) {
        this.selfOperator.entity.isActive = false;
      }
      return;
    }

    // third person (alive OR the death-cam): pull the camera back along the aim, over
    // the right shoulder. When dead the body is frozen where you fell, so the camera
    // holds behind your operator while it plays out the Death clip.
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const dir: Vec3 = { x: -Math.sin(this.body.yaw) * cp, y: sp, z: -Math.cos(this.body.yaw) * cp };
    const rx = Math.cos(this.body.yaw), rz = -Math.sin(this.body.yaw); // right vector
    let back = 3.0;
    const o: Vec3 = { x: this.body.pos.x, y: eye, z: this.body.pos.z };
    const nd: Vec3 = { x: -dir.x, y: -dir.y, z: -dir.z };
    const hit = this.map.raycast(o, nd, back + 0.4);
    if (hit) back = Math.max(0.6, hit.dist - 0.4);
    const cx = o.x + nd.x * back + rx * 0.55;
    const cy = o.y + nd.y * back + 0.35;
    const cz = o.z + nd.z * back + rz * 0.55;
    this.camEntity.transform.setPosition(cx, cy, cz);

    if (this.isHider()) {
      // Prop-Hunt hider: the crate disguise standing at the player's feet (alive only)
      if (this.selfOperator) this.selfOperator.entity.isActive = false;
      const a = this.selfAvatar;
      a.isActive = this.alive;
      a.transform.setPosition(this.body.pos.x, this.body.pos.y, this.body.pos.z);
      a.transform.setRotation(0, (this.body.yaw * 180) / Math.PI, 0);
      return;
    }

    // general third-person: drive the local operator avatar with the body's pose so
    // you see the same rigged character (animated, holding your gun) as everyone else.
    // Passing `alive` lets the avatar play its Death clip in place when you're killed.
    if (this.selfAvatar) this.selfAvatar.isActive = false;
    const op = this.ensureSelfOperator();
    if (op) {
      op.setVisible(true);
      op.weapon = this.ws.current;
      op.setPose(this.body.pos, this.body.yaw, this.alive, this.body.onGround);
    }
  }

  /** build (once) the local player's third-person operator avatar */
  ensureSelfOperator(): RemotePlayer | null {
    if (this.selfOperator) return this.selfOperator;
    if (!this.models) return null;
    const root = this.engine.sceneManager.activeScene.getRootEntity();
    if (!root) return null;
    this.selfOperator = new RemotePlayer(
      this.engine, root, "self", this.names.get(this.net.myId) ?? "", this.net.colorOf(this.net.myId), this.models,
    );
    return this.selfOperator;
  }

  /** enter the death cinematic: desaturate the screen (B&W) and start the orbit clock. */
  startDeathCam(): void {
    this.deathTime = performance.now() / 1000;
    this.deathYaw = this.body.yaw;
    document.body.classList.add("dead");
    sfx.muffle(true); // muffle all fx while dead / in respawn screen
  }

  /** leave the death cinematic on respawn. */
  endDeathCam(): void {
    document.body.classList.remove("dead");
    sfx.muffle(false);
  }

  /** slowly orbit the camera around the fallen body (which keeps falling under gravity
   *  until it lands, so the shot follows it down). Pivots on the live body position. */
  updateDeathCam(): void {
    const c = this.body.pos;
    const t = performance.now() / 1000 - this.deathTime;
    const ang = this.deathYaw + t * DEATH_CAM_ORBIT_SPEED;
    const r = 3.4, h = 1.6;
    let cx = c.x + Math.sin(ang) * r;
    let cy = c.y + h;
    let cz = c.z + Math.cos(ang) * r;
    // don't let the orbit clip through walls — pull in to the nearest hit
    const o: Vec3 = { x: c.x, y: c.y + 1.0, z: c.z };
    const dir: Vec3 = { x: cx - o.x, y: cy - o.y, z: cz - o.z };
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const nd: Vec3 = { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl };
    const hit = this.map.raycast(o, nd, dl + 0.3);
    if (hit) { const d = Math.max(0.8, hit.dist - 0.3); cx = o.x + nd.x * d; cy = o.y + nd.y * d; cz = o.z + nd.z * d; }
    this.camEntity.transform.setPosition(cx, cy, cz);
    this.deathLookTarget.set(c.x, c.y + 0.5, c.z);
    this.camEntity.transform.lookAt(this.deathLookTarget, this.worldUp);
  }

  /** the local player is dead for the rest of the round (no respawn) — currently only a
   *  Prop-Hunt hider, who becomes a spectator instead of waiting on a respawn timer. */
  selfNoRespawn(): boolean { return this.isHider(); }

  /** pick a living seeker to spectate: keep the current one if still valid, else the
   *  nearest. Positions come from remotes (guest view / other humans) or bots (host). */
  private spectateTarget(): { pos: Vec3; yaw: number; id: string } | null {
    const posOf = (id: string): { pos: Vec3; yaw: number } | null => {
      const r = this.remotes.get(id);
      if (r && r.alive) return { pos: r.pos, yaw: r.yaw };
      const b = this.bots.get(id);
      if (b) return { pos: b.body.pos, yaw: b.body.yaw };
      return null;
    };
    // keep spectating the same seeker while it's still around
    if (this.spectateId && this.teams[this.spectateId] === ROLE_SEEK) {
      const cur = posOf(this.spectateId);
      if (cur) return { ...cur, id: this.spectateId };
    }
    let best: { pos: Vec3; yaw: number; id: string } | null = null;
    let bestD = Infinity;
    for (const id of Object.keys(this.teams)) {
      if (id === this.net.myId || this.teams[id] !== ROLE_SEEK) continue;
      const p = posOf(id);
      if (!p) continue;
      const d = (p.pos.x - this.body.pos.x) ** 2 + (p.pos.z - this.body.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = { ...p, id }; }
    }
    this.spectateId = best?.id ?? null;
    return best;
  }

  /** third-person chase cam behind the spectated seeker (Prop-Hunt hider spectator). */
  updateSpectateCam(t: { pos: Vec3; yaw: number }): void {
    const p = t.pos, yaw = t.yaw;
    let back = 3.2;
    const o: Vec3 = { x: p.x, y: p.y + 1.5, z: p.z };
    // behind = opposite the player's forward (-sin,-cos); pull in on walls
    const nd: Vec3 = { x: Math.sin(yaw), y: 0.18, z: Math.cos(yaw) };
    const nl = Math.hypot(nd.x, nd.y, nd.z) || 1;
    nd.x /= nl; nd.y /= nl; nd.z /= nl;
    const hit = this.map.raycast(o, nd, back + 0.4);
    if (hit) back = Math.max(0.8, hit.dist - 0.4);
    this.camEntity.transform.setPosition(o.x + nd.x * back, o.y + nd.y * back, o.z + nd.z * back);
    this.deathLookTarget.set(p.x, p.y + 1.3, p.z);
    this.camEntity.transform.lookAt(this.deathLookTarget, this.worldUp);
  }

  /** apply host physics rules (gravity/speed scale) to every local body */
  applyPhysicsConfig(): void {
    if (this.body) this.body.gravityScale = this.cfg.gravity;
    for (const b of this.bots.values()) b.body.gravityScale = this.cfg.gravity;
  }

  /** true when a real (non-bot) remote player is in the lobby/match */
  hasHumanGuests(): boolean {
    return this.net.players.some((p) => p.id !== this.net.myId && !this.bots.has(p.id));
  }

  // ─── mode-specific local loadout ──────────────────────────────────────────────

  /** pick the right weapon set for the local player given the active mode */
  applyLoadout(): void {
    this.myRole = this.teams[this.net.myId] ?? ROLE_SEEK;
    this.updateCombatUI();
    if (this.mode === "gungame") { this.applyTier(this.tiers[this.net.myId] ?? 0); return; }
    if (this.mode === "prophunt" && this.myRole === ROLE_HIDE) {
      // hider: an unarmed prop — no viewmodel, no weapon
      this.refreshSelfDisguise();
      this.ws.showViewmodel(false);
      this.ws.select("knife");
      this.applyScopeFov();
      return;
    }
    this.ws.showViewmodel(this.inGame);
    // re-equip whatever was held at death (nades are refilled by now, so a thrown-empty
    // weapon is valid again); fall back to the rifle on first spawn / if unavailable.
    const w = this.lastWeapon && this.ws.available(this.lastWeapon) ? this.lastWeapon : "ak47";
    this.ws.select(w);
  }

  /** show/hide combat controls: Prop-Hunt hiders are unarmed props */
  updateCombatUI(): void {
    document.body.classList.toggle("hider", this.inGame && this.isHider());
    this.applyScopeFov(); // refresh crosshair visibility for the new role
  }

  /** gungame: lock the local player to their current tier's weapon (full ammo) */
  applyTier(tier: number): void {
    const w = tierWeapon(tier);
    const d = WEAPONS[w];
    if (!d.melee) this.ws.ammo[w] = { mag: d.mag, reserve: d.reserve < 0 ? -1 : d.reserve };
    this.ws.showViewmodel(this.inGame);
    this.ws.select(w);
    this.applyScopeFov();
    this.refreshAmmoHud();
  }

  /** manual weapon switching is disabled in gungame + for prop-hunt hiders */
  canSwitchWeapon(): boolean {
    return this.mode !== "gungame" && !(this.mode === "prophunt" && this.myRole === ROLE_HIDE);
  }

  /** per-frame: prop-hunt disguises on remote avatars */
  updateModeVisuals(): void {
    const disguise = this.mode === "prophunt";
    for (const r of this.remotes.values()) {
      r.setDisguise(disguise && this.teams[r.id] === ROLE_HIDE, this.propForPlayer(r.id), this.disguiseLib);
    }
  }

  /** the disguise-prop pool for the current map (models flagged usable for prop hunt) */
  private propPool: string[] = propHuntPool();
  /** material library the Prop-Hunt disguises shade against (built once; see ensureDisguiseMaterials) */
  private disguiseLib: MaterialLibrary | null = null;

  /** deterministic disguise-prop model for a player id (host + guests agree without any
   *  extra networking). null when the pool is empty → callers fall back to the crate. */
  propForPlayer(id: string): string | null {
    const pool = this.propPool;
    if (!pool.length) return null;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return pool[h % pool.length];
  }

  /** per-frame: mode HUD (team score / gungame tier / prop-hunt role) */
  updateModeHud(): void {
    if (this.mode === "tdm") {
      this.hud.teamScoreHud(
        { name: TEAM_NAMES[0], score: this.teamScore[0], color: TEAM_COLORS[0] },
        { name: TEAM_NAMES[1], score: this.teamScore[1], color: TEAM_COLORS[1] },
      );
    } else if (this.mode === "prophunt") {
      this.hud.teamScoreHud(
        { name: "Seekers", score: this.teamScore[0], color: TEAM_COLORS[0] },
        { name: "Hiders", score: this.teamScore[1], color: TEAM_COLORS[1] },
      );
    } else {
      this.hud.teamScoreHud(null);
    }

    if (this.mode === "gungame") {
      const tier = this.tiers[this.net.myId] ?? 0;
      this.hud.tierHud(tier, GUNGAME_FINAL, WEAPONS[tierWeapon(tier)].name);
    } else {
      this.hud.tierHud(-1, 0, "");
    }

    if (this.mode === "prophunt" && this.phase === "play") {
      if (this.myRole === ROLE_HIDE) {
        this.hud.roleHud("You are a prop · hide & stay still", "hide");
      } else if (this.inPrepPhase()) {
        const s = Math.ceil(this.timeLeft - (this.cfg.roundTime - PROPHUNT_PREP));
        this.hud.roleHud(`Seeker · hunt begins in ${s}s`, "prep");
      } else {
        this.hud.roleHud(`Seeker · hiders left: ${this.countHiders()}`, "seek");
      }
    } else {
      this.hud.roleHud("", "");
    }
  }

  /** hiders still alive (works on host + guests via avatar liveness) */
  countHiders(): number {
    let n = 0;
    for (const p of this.net.players) {
      if (this.teams[p.id] !== ROLE_HIDE) continue;
      const alive = p.id === this.net.myId ? this.alive : (this.remotes.get(p.id)?.alive ?? false);
      if (alive) n++;
    }
    return n;
  }

  /** end-screen headline for the finished match */
  resultTitle(): string {
    if (this.mode === "tdm") {
      const [a, b] = this.teamScore;
      if (a === b) return "Draw";
      return `${TEAM_NAMES[a > b ? 0 : 1]} wins`;
    }
    if (this.mode === "prophunt") {
      const [s, h] = this.teamScore;
      if (s === h) return "Prop Hunt · draw";
      return s > h ? "Seekers win" : "Hiders win";
    }
    if (this.mode === "gungame") {
      let best = "", bt = -1;
      for (const p of this.net.players) {
        const t = this.tiers[p.id] ?? 0;
        if (t > bt) { bt = t; best = this.names.get(p.id) ?? p.name; }
      }
      return best ? `${best} wins` : "Match over";
    }
    // ffa: top killer
    let best = "", bk = -1;
    for (const p of this.net.players) {
      const k = this.scores[p.id]?.k ?? 0;
      if (k > bk) { bk = k; best = this.names.get(p.id) ?? p.name; }
    }
    return best ? `${best} wins` : "Match over";
  }

  // ─── settings (graphics quality preset + aim / fov / hud prefs) ───────────────

  bindSettings(): void {
    this.settings.build();
    this.settings.onChange = () => {
      this.applySettings();
      // toggling NPC AI chat on while the model isn't downloaded yet kicks off the
      // (consented) download; syncAiChatPref folds the preference into the match cfg.
      if (this.settings.state.aiChat && this.npc && !this.npc.ready) void this.startAiDownload();
      this.syncAiChatPref();
    };
    // first-run consent pop-up: "Download" arms the toggle (which triggers the fetch
    // via onChange), "Not now" just records the choice so we don't ask again.
    this.hud.onAiConsent = (accept) => this.settings.setAiChat(accept);
    document.getElementById("btn-gear")!.addEventListener("click", () => this.openSettings());
    document.getElementById("tc-settings")!.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation(); this.openSettings();
    });
    document.getElementById("set-leave")!.addEventListener("click", () => this.leaveToMenu());

    // callsign: set on the first (menu) screen, persisted across reloads
    const menuName = document.getElementById("inp-name") as HTMLInputElement;
    menuName.value = this.settings.state.name;
    menuName.addEventListener("input", () => this.settings.setName(menuName.value));

    this.applySettings();
    this.syncAiChatPref(); // arm the match cfg from the persisted per-host preference
  }

  /** once support is known, decide what (if anything) to do about the model download:
   *   • already cached / unsupported → nothing;
   *   • not yet asked → ASK FIRST with the consent pop-up (only reached when supported);
   *   • already explicitly opted in (answered + on) → show / attach the download.
   *  Consent is the primary gate: we NEVER surface the progress toast before the user
   *  has said yes — even when `availability()` already reports "downloading". (Gemini
   *  Nano is a browser-level component, so a fresh/incognito profile can see an
   *  in-flight download it never triggered; we just don't reveal it until opt-in.) */
  private decideAiDownload(): void {
    const npc = this.npc;
    if (!npc || npc.status === "unavailable" || npc.status === "available") return;
    // status is "downloadable" or "downloading" — model isn't usable yet either way
    if (!this.settings.state.aiPrompted) this.hud.showAiConsent();
    else if (this.settings.state.aiChat) void this.startAiDownload();
  }

  /** download + warm the model (once), driving the progress toast. Guarded so it never
   *  runs twice concurrently or when the model is already ready. On success the freshly
   *  ready model is folded into the match cfg. */
  private aiDownloading = false;
  private async startAiDownload(): Promise<void> {
    const npc = this.npc;
    if (!npc || this.aiDownloading || npc.ready) return;
    this.aiDownloading = true;
    const ok = await npc.provision({
      onStart: () => this.hud.showAiDownload(),
      onProgress: (loaded) => this.hud.setAiDownloadProgress(loaded),
      onDone: () => this.hud.aiDownloadDone(),
      onError: () => this.hud.hideAiDownload(),
    });
    this.aiDownloading = false;
    if (ok) this.syncAiChatPref(); // now ready → reflect into cfg (+ broadcast if hosting)
  }

  /** NPC AI chat is a per-host *client* preference (Settings), not a per-match rule.
   *  Fold it into the match config: while hosting a lobby, live-broadcast the change to
   *  guests; otherwise stash it for the next match we host. A guest's local toggle never
   *  touches the (host-authoritative) config. Gated by model support so an unsupported
   *  host never advertises AI banter it can't produce. */
  private syncAiChatPref(): void {
    const want = this.settings.state.aiChat && this.settings.aiSupported;
    if (this.net.isHost) {
      if (this.phase === "lobby") { if (this.cfg.aiChat !== want) this.setCfg({ aiChat: want }); }
      else this.cfg.aiChat = want;
    } else if (!this.net.peer) {
      this.cfg.aiChat = want; // not in a session yet → pre-arm for the lobby we'll host
    }
  }

  /** open the settings overlay, revealing the in-match "leave" control only in-game */
  openSettings(): void {
    document.getElementById("set-leave")!.classList.toggle("hidden", !this.inGame);
    this.settings.open();
  }

  /** re-apply every live setting (called on change + at boot) */
  applySettings(): void {
    this.applyGraphics();
    this.applyScopeFov(); // picks up fov
    document.getElementById("stats")!.classList.toggle("hidden", !this.settings.state.showStats);
  }

  /** the device quality preset as a ceiling on the map's authored shadow tier
   *  (so a low-end device never pays for a map's ultra shadows) */
  private shadowCap(): ShadowQuality {
    const q = this.settings.state.quality;
    return q === "low" ? "off" : q === "medium" ? "medium" : "ultra";
  }

  /** map the device quality preset onto camera knobs (MSAA / HDR / post / render
   *  scale), then re-apply the current map's shadows clamped to that preset. The
   *  map's env owns the *look*; this preset only trades quality for framerate. */
  applyGraphics(): void {
    const scene = this.engine.sceneManager.activeScene;
    const cam = this.camera;
    const q = this.settings.state.quality;
    cam.msaaSamples = q === "low" ? MSAASamples.None : q === "medium" ? MSAASamples.TwoX : MSAASamples.FourX;
    cam.enableHDR = q !== "low";
    cam.enablePostProcess = q !== "low";
    if (this.map?.env) applyShadows(scene, this.sun, this.map.env, this.shadowCap());
    this.applyResolution();
  }

  /** render-buffer scale: trade sharpness for framerate on the lower presets.
   *  The device pixel ratio is capped (DPR_CAP) before the preset scale, because
   *  a 2× Retina display (e.g. an M1 Pro MacBook) renders 4× the pixels — with
   *  MSAA 4× + HDR + bloom that saturates fill-rate, which is why the game runs
   *  fine at half a window but lags at fullscreen. Capping to 1.5× cuts that pixel
   *  count almost in half while staying crisp; low-DPI screens are unaffected. */
  applyResolution(): void {
    const DPR_CAP = 1.5;
    const scale = this.settings.state.quality === "low" ? 0.6
      : this.settings.state.quality === "medium" ? 0.85 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const canvas = this.engine.canvas as unknown as { resizeByClientSize(pixelRatio?: number): void };
    canvas.resizeByClientSize(dpr * scale);
  }

  // ─── touch controls + device adaptation ───────────────────────────────────────

  bindTouch(): void {
    const t = this.touch;
    t.onLook = (dx, dy) => {
      if (!this.inGame || this.hud.chatOpen) return;
      if (!(this.alive && this.phase === "play")) return;
      this.touchLookMs = performance.now(); // marks the player as actively aiming (follow gate)
      const sens = 0.005 * this.settings.state.sensitivity * (this.ws.scoped ? 0.35 : 1) * this.aimFriction;
      this.body.look(dx, dy, sens);
    };
    t.onFire = (down) => {
      if (this.hud.chatOpen) { this.fireHeld = false; return; }
      this.fireHeld = down;
      if (down) this.triedFireQueued = true;
    };
    t.onJump = (down) => { if (down) this.keys.add("Space"); else this.keys.delete("Space"); };
    t.onScore = (down) => { this.sbOpen = down; };
    t.onScope = () => {
      if (this.ws.def().scope && this.alive) { this.ws.setScope(!this.ws.scoped); this.applyScopeFov(); }
    };
    t.onReload = () => { if (this.alive) this.localReload(); };
    t.onWeapon = (i) => { if (this.alive && this.canSwitchWeapon()) { this.ws.select(LOADOUT[i]); this.applyScopeFov(); } };
    t.onChat = () => { this.keys.clear(); this.fireHeld = false; this.hud.openChat(); };
    t.onMic = () => {
      if (this.voice.micOk) { this.voice.setMuted(!this.voice.muted); this.hud.voice(this.voice.muted ? "muted" : "on"); }
    };
    t.build();

    // Adapt to the input device: switch to virtual controls the moment a touch
    // is seen, and back to mouse/keyboard on real mouse input (last one wins).
    // Desktop play is never altered — the touch overlay stays hidden + inert.
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.setPlatform("touch");
      else if (e.pointerType === "mouse") this.setPlatform("keyboard");
    }, { capture: true });
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && (e.movementX || e.movementY)) this.setPlatform("keyboard");
    }, { capture: true });
    // A physical key press is an unambiguous desktop signal. Alt-tabbing away and back (or
    // a stray trackpad/synthetic pointer event) could flip us into touch mode, where mouse
    // look stops working and the camera only turns while a button is held (the touch look
    // pad needs a pointer down). Any keydown recovers mouse mode instantly. Ignored while
    // typing in chat so a touch player with a soft keyboard isn't kicked out mid-message.
    window.addEventListener("keydown", () => { if (!this.hud.chatOpen) this.setPlatform("keyboard"); }, { capture: true });
  }

  /** Switch the active input device (last one used wins). Toggles the on-screen touch
   *  overlay, and — for touch / gamepad, which drive look without a locked pointer —
   *  releases pointer lock and hides the click-to-play prompt. Announces the change to
   *  peers so their player-list icon for us updates live. */
  setPlatform(p: Platform): void {
    if (p === this.myPlatform) return;
    this.myPlatform = p;
    const touch = p === "touch";
    document.body.classList.toggle("touch", touch);
    document.body.classList.toggle("gamepad", p === "gamepad");
    this.touch.setEnabled(touch);
    this.touch.setWeapon(this.ws.current);
    if (this.inGame) {
      if (p === "keyboard") { if (!this.locked) this.hud.clickToPlay(true); }
      else { this.hud.clickToPlay(false); if (this.locked) document.exitPointerLock(); }
    }
    this.announcePlatform();
  }

  // ─── gamepad (Xbox / PlayStation) ─────────────────────────────────────────────

  bindGamepad(): void {
    const g = this.gamepad;
    // any pad activity makes it the active device (mirrors touch/mouse last-wins)
    g.onActivity = () => { if (!this.hud.chatOpen) this.setPlatform("gamepad"); };
    g.onFire = (down) => {
      if (this.hud.chatOpen) { this.fireHeld = false; return; }
      this.fireHeld = down;
      if (down) this.triedFireQueued = true;
    };
    g.onJump = (down) => { if (down) this.keys.add("Space"); else this.keys.delete("Space"); };
    g.onScore = (down) => { this.sbOpen = down; };
    g.onScope = () => {
      if (this.ws.def().scope && this.alive) { this.ws.setScope(!this.ws.scoped); this.applyScopeFov(); }
    };
    g.onReload = () => { if (this.alive) this.localReload(); };
    g.onWeaponCycle = (dir) => {
      if (this.alive && this.canSwitchWeapon()) { this.ws.cycle(dir); this.applyScopeFov(); }
    };
    g.onWeaponSelect = (i) => {
      if (this.alive && this.canSwitchWeapon()) { this.ws.select(LOADOUT[i]); this.applyScopeFov(); }
    };
    g.onMic = () => {
      if (this.voice.micOk) { this.voice.setMuted(!this.voice.muted); this.hud.voice(this.voice.muted ? "muted" : "on"); }
    };
    g.onPause = () => { if (this.settings.isOpen()) this.settings.close(); else this.openSettings(); };
    // menu navigation (only fires while gamepad.mode === "menu"; see the tick loop)
    g.onNavigate = (dir) => this.menuMove(dir);
    g.onAdjust = (dir) => this.menuAdjust(dir);
    g.onConfirm = () => this.menuConfirm();
    g.onBack = () => this.menuBack();

    // a freshly plugged-in pad becomes the device on its first input (handled by poll);
    // if the active pad is unplugged mid-match, fall back to mouse/keyboard.
    window.addEventListener("gamepadconnected", () => this.hud.banner("Gamepad connected"));
    window.addEventListener("gamepaddisconnected", () => {
      if (this.myPlatform === "gamepad") this.setPlatform("keyboard");
    });
  }

  // ─── platform (input-device) sync ─────────────────────────────────────────────

  /** publish our current input device to peers (+ record it locally). Host broadcasts to
   *  every guest; a guest sends it to the host, which relays. Cheap + idempotent. */
  announcePlatform(): void {
    this.platforms[this.net.myId] = this.myPlatform;
    if (this.net.isHost) this.net.broadcast({ t: "plat", id: this.net.myId, plat: this.myPlatform });
    else this.net.send({ t: "plat", id: this.net.myId, plat: this.myPlatform });
    // only touch the lobby DOM/avatars while actually in the lobby — never once the match
    // has started (phase can still read "lobby" for a beat during enterGame, and a refresh
    // there would rebuild the 3D lobby avatars into the live map).
    if (this.phase === "lobby" && !this.inGame) this.refreshLobby();
  }

  // ─── gamepad menu navigation ──────────────────────────────────────────────────
  // Drive the plain DOM menus (create/join, lobby, settings, map vote, end screen)
  // with a controller: a focus ring moves between the interactive controls, A
  // activates, B backs out, and left/right nudges sliders.

  /** the top-most navigable menu/overlay currently on screen (null while just playing) */
  private activeNavRoot(): HTMLElement | null {
    const vis = (id: string): HTMLElement | null => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("hidden") && el.offsetParent !== null ? el : null;
    };
    // priority: modal pop-ups first, then the settings overlay, then whole screens
    return vis("ai-consent") ?? (this.settings.isOpen() ? document.getElementById("settings") : null)
      ?? vis("vote") ?? vis("scr-end") ?? vis("scr-lobby") ?? vis("scr-menu");
  }

  /** interactive controls inside a menu root, in document (≈ visual) order */
  private navItems(root: HTMLElement): HTMLElement[] {
    const els = root.querySelectorAll<HTMLElement>("button, input, .mode-card, .vc");
    return Array.from(els).filter((el) =>
      !el.classList.contains("hidden") && !el.classList.contains("readonly")
      && !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  }

  private setNavFocus(el: HTMLElement): void {
    if (this.navFocusEl && this.navFocusEl !== el) this.navFocusEl.classList.remove("gp-focus");
    this.navFocusEl = el;
    el.classList.add("gp-focus");
    el.scrollIntoView({ block: "nearest" });
  }

  private clearNav(): void {
    this.navFocusEl?.classList.remove("gp-focus");
    this.navFocusEl = null;
  }

  /** move the focus ring by `dir` (−1 up / +1 down), wrapping; first press just reveals it */
  menuMove(dir: number): void {
    const root = this.activeNavRoot();
    if (!root) return;
    const items = this.navItems(root);
    if (!items.length) { this.clearNav(); return; }
    const i = this.navFocusEl ? items.indexOf(this.navFocusEl) : -1;
    if (i < 0) { this.setNavFocus(items[0]); return; }
    this.setNavFocus(items[(i + dir + items.length) % items.length]);
  }

  /** left/right: nudge a focused slider, otherwise move the focus ring horizontally */
  menuAdjust(dir: number): void {
    const el = this.navFocusEl;
    if (el instanceof HTMLInputElement && el.type === "range") {
      const step = parseFloat(el.step) || 1;
      const min = parseFloat(el.min), max = parseFloat(el.max);
      const v = clamp(parseFloat(el.value) + dir * step, min, max);
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    this.menuMove(dir);
  }

  /** A button: activate the focused control (text inputs just take keyboard focus) */
  menuConfirm(): void {
    const root = this.activeNavRoot();
    if (!root) return;
    const items = this.navItems(root);
    if (!items.length) return;
    if (!this.navFocusEl || !items.includes(this.navFocusEl)) { this.setNavFocus(items[0]); return; }
    const el = this.navFocusEl;
    if (el instanceof HTMLInputElement && (el.type === "text" || el.type === "range")) { el.focus(); return; }
    el.click();
  }

  /** B button: close the top-most overlay (settings / consent). No-op on base screens. */
  menuBack(): void {
    if (this.settings.isOpen()) { this.settings.close(); return; }
    document.getElementById("ai-consent-no")?.click();
  }

  // ─── aim assist (controller / touch) ──────────────────────────────────────────

  /** is `id` an enemy of the local player under the current mode's team rules? */
  private localEnemy(id: string): boolean {
    if (id === this.net.myId) return false;
    if (!MODES[this.mode].teams) return true; // ffa / gungame — everyone is fair game
    return this.teams[id] !== this.teams[this.net.myId];
  }

  /** the world point on a target the assist sticks to — upper chest (or crate centre) */
  private aimPoint(r: RemotePlayer): Vec3 {
    return r.disguised
      ? { x: r.pos.x, y: r.pos.y + 0.43, z: r.pos.z }
      : { x: r.pos.x, y: r.pos.y + 1.4, z: r.pos.z };
  }

  /** the player is actively aiming/moving — gates the follow so the camera never drifts
   *  on its own while the player is completely idle. */
  private aimEngaged(nowMs: number): boolean {
    const lookMag = Math.hypot(this.gamepad.lookX, this.gamepad.lookY);
    const moveMag = Math.hypot(this.touch.moveX + this.gamepad.moveX, this.touch.moveY + this.gamepad.moveY);
    return lookMag > 0.02 || moveMag > 0.15 || nowMs - this.touchLookMs < 140;
  }

  /** Per-frame aim assist for controller + touch. Sets `aimFriction` (look-input slowdown
   *  near a target) and nudges the view to follow a *moving* target. Disabled for mouse,
   *  when the strength slider is 0, while dead / not playing, on throwables, and in menus. */
  updateAimAssist(dt: number, nowMs: number): void {
    this.aimFriction = 1;
    const strength = this.settings.state.aimAssist;
    const eligible = (this.myPlatform === "gamepad" || this.myPlatform === "touch")
      && strength > 0 && this.alive && this.phase === "play" && !this.isHider()
      && !this.settings.isOpen() && !this.hud.chatOpen && !this.ws.def().throwable;
    if (!eligible) { this.aimTargetId = null; this.aimPrevTargetPos = null; return; }

    const eye: Vec3 = { x: this.body.pos.x, y: this.body.eyeY, z: this.body.pos.z };
    const aim = this.body.aimDir();
    const maxDist = Math.min(this.ws.def().range, AA_RANGE);

    // pick the enemy nearest the crosshair, within the bubble + range, with a clear line
    let best: RemotePlayer | null = null, bestAng = AA_BUBBLE, bestP: Vec3 | null = null;
    for (const r of this.remotes.values()) {
      if (!r.alive || !this.localEnemy(r.id)) continue;
      const P = this.aimPoint(r);
      const tx = P.x - eye.x, ty = P.y - eye.y, tz = P.z - eye.z;
      const dist = Math.hypot(tx, ty, tz);
      if (dist < 0.5 || dist > maxDist) continue;
      const ux = tx / dist, uy = ty / dist, uz = tz / dist;
      const ang = Math.acos(clamp(aim.x * ux + aim.y * uy + aim.z * uz, -1, 1));
      if (ang >= bestAng) continue;
      if (this.map.raycast(eye, { x: ux, y: uy, z: uz }, dist - 0.3)) continue; // wall in the way
      best = r; bestAng = ang; bestP = P;
    }
    if (!best || !bestP) { this.aimTargetId = null; this.aimPrevTargetPos = null; return; }

    const proximity = 1 - bestAng / AA_BUBBLE; // 1 dead-centre → 0 at the bubble edge
    // (1) friction: slow the look input the closer the crosshair sits to the target. The
    // curve (<1) makes the slowdown build early rather than only dead-centre, so the aim
    // gets "heavy" as you arrive on a player — easier to settle the reticle and flick precisely.
    const fricProx = Math.pow(proximity, AA_FRICTION_CURVE);
    this.aimFriction = 1 - (1 - AA_FRICTION_MIN) * fricProx * strength;

    // (2) follow: track the target's own angular drift (measured with the eye held fixed, so
    //     it's the target's motion — not the player's — that's compensated). No pull while
    //     sniping, and only while the player is actively engaging.
    if (!this.ws.scoped && this.aimEngaged(nowMs) && this.aimTargetId === best.id
        && this.aimPrevTargetPos && dt > 1e-4 && dt < 0.1) {
      const prev = this.aimPrevTargetPos;
      let dYaw = bearingYaw(eye, bestP) - bearingYaw(eye, prev);
      if (dYaw > Math.PI) dYaw -= 2 * Math.PI; else if (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const dPitch = bearingPitch(eye, bestP) - bearingPitch(eye, prev);
      const k = proximity * strength;
      this.body.yaw += dYaw * AA_FOLLOW * k;
      this.body.pitch = clamp(this.body.pitch + dPitch * AA_FOLLOW_PITCH * k, -1.55, 1.55);
    }
    this.aimTargetId = best.id;
    this.aimPrevTargetPos = { ...bestP };
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  tick(dt: number, now: number): void {
    // positional map sounds fade by the camera's distance to each emitter
    if (this.map.root) {
      const cp = this.camEntity.transform.worldPosition;
      this.map.tickSounds({ x: cp.x, y: cp.y, z: cp.z });
    }
    // poll the gamepad every frame so a controller can take over at any time (its
    // callbacks self-gate on match state); analog move/look are read below. When a menu
    // or overlay is up, the pad drives DOM focus navigation instead of the FPS.
    const navRoot = this.activeNavRoot();
    this.gamepad.mode = navRoot ? "menu" : "game";
    if (!navRoot && this.navFocusEl) this.clearNav(); // left the menus → drop the focus ring
    this.gamepad.poll();
    if (this.inGame) {
      const kFwd = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const kRight = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const inp: Input = {
        fwd: clamp(kFwd + this.touch.moveY + this.gamepad.moveY, -1, 1),
        right: clamp(kRight + this.touch.moveX + this.gamepad.moveX, -1, 1),
        jump: this.keys.has("Space"),
        sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.touch.sprint || this.gamepad.sprint,
      };
      // aim assist (controller / touch): compute friction + apply target-follow. Must run
      // before the gamepad look below so the friction scale is fresh this frame.
      this.updateAimAssist(dt, performance.now());
      // gamepad look: analog right stick applied per-frame, like mouse-look (scaled by
      // the sensitivity setting; halved while scoped, matching mouse ADS; and slowed by
      // aim-assist friction when the crosshair is near a target).
      if (this.myPlatform === "gamepad" && this.alive && this.phase === "play" && !this.hud.chatOpen
          && (this.gamepad.lookX || this.gamepad.lookY)) {
        const sens = GP_LOOK_RATE * dt * this.settings.state.sensitivity * (this.ws.scoped ? 0.35 : 1) * this.aimFriction;
        this.body.look(this.gamepad.lookX, this.gamepad.lookY, sens);
      }
      // prop hunt: seekers are frozen during the hide window; hiders are unarmed props
      const frozen = this.mode === "prophunt" && this.myRole === ROLE_SEEK && this.inPrepPhase();
      const isHider = this.mode === "prophunt" && this.myRole === ROLE_HIDE;
      const canPlay = this.alive && this.phase === "play" && !frozen;
      const speedBuff = this.buff?.kind === "speed" ? SPEED_MULT : 1;
      // directional movement penalty (classic FPS feel): backpedalling and strafing are
      // slower than running forward. Only the dominant wish direction matters.
      const back = inp.fwd < -0.01, sideDom = Math.abs(inp.right) > Math.abs(inp.fwd) + 0.01;
      const dirFactor = sideDom ? MOVE_STRAFE_FACTOR : back ? MOVE_BACK_FACTOR : 1;
      this.body.update(dt, canPlay ? inp : { fwd: 0, right: 0, jump: false, sprint: false }, this.ws.def().moveFactor * speedBuff * this.cfg.speed * dirFactor);

      if (this.body.jumped) sfx.jump();
      if (this.body.landed) sfx.land();
      const moving = this.body.horizontalSpeed() > 1.5;
      if (moving && this.body.onGround && canPlay) {
        this.stepAcc += dt * this.body.horizontalSpeed();
        if (this.stepAcc > 3.2) { this.stepAcc = 0; sfx.footstep(); }
      }

      // fire (Prop-Hunt hiders are unarmed and cannot shoot)
      if (canPlay && !isHider && (this.fireHeld || this.triedFireQueued)) {
        if (this.ws.def().auto || this.triedFireQueued) {
          this.ws.tryFire(this.body.horizontalSpeed(), this.body.onGround);
        }
      }
      this.triedFireQueued = false;

      this.ws.update(dt, moving, this.body.onGround);
      this.tracers.update(dt);
      this.nades.update(dt, now);
      // dynamic props: integrate after the player has moved so walking into a light
      // prop can shove it (and a heavy one blocks). No-op when the map has none.
      this.physics.step(dt, this.alive ? this.body : null);

      // camera transform (first- or third-person)
      const eye = this.body.eyeY;
      const pitch = this.body.pitch + this.ws.recoilPitch;
      Quaternion.rotationYawPitchRoll(this.body.yaw, pitch, 0, this.q);
      this.camEntity.transform.rotationQuaternion = this.q;
      this.updateSelfView(eye, pitch);

      // remotes + proximity voice
      if (this.net.isHost && this.bots.size) this.updateBots(dt, now);
      for (const r of this.remotes.values()) {
        r.update(now);
        const rel = this.relAudio(r.pos);
        this.voice.setSpatial(r.id, rel.pan, rel.dist);
      }

      // ambient water loop, spatialized to the map's water source (if any)
      if (this.map.env.water) {
        const w = this.map.env.water;
        const wr = this.relAudio({ x: w[0], y: w[1], z: w[2] });
        sfx.setWaterSpatial(wr.pan, wr.dist);
      }

      // pickups: spin/bob + host claim detection
      this.pkSpin += dt * 2.2;
      for (let i = 0; i < this.pkEntities.length; i++) {
        const e = this.pkEntities[i];
        if (!e.isActive) continue;
        const sp = this.map.pickupSpots[i];
        e.transform.setPosition(sp.x, sp.y + Math.sin(this.pkSpin + i) * 0.12, sp.z);
        e.transform.setRotation(0, (this.pkSpin * 180) / Math.PI, 0);
      }
      // powerups: spin/bob
      for (let i = 0; i < this.pwEntities.length; i++) {
        const e = this.pwEntities[i];
        if (!e.isActive) continue;
        const sp = this.map.powerupSpots[i];
        e.transform.setPosition(sp.x, sp.y + Math.sin(this.pkSpin * 1.5 + i) * 0.15, sp.z);
        e.transform.setRotation(0, this.pkSpin * 90, this.pkSpin * 60);
      }

      if (this.net.isHost && this.phase === "play") {
        this.hostCheckPickups();
        this.pwSpawnAcc += dt;
        if (this.pwSpawnAcc >= POWERUP_INTERVAL) { this.pwSpawnAcc = 0; this.hostSpawnPowerup(); }
        this.hostCheckPowerups();
      }

      // active buff timer / HUD
      if (this.buff) {
        const left = this.buff.until - now;
        if (left <= 0) this.clearBuff();
        else { const d = POWERUPS[this.buff.kind]; this.hud.buff(d.name, d.color, left); }
      }

      // ping (guest)
      this.pingAcc += dt;
      if (this.pingAcc >= 2) {
        this.pingAcc = 0;
        if (!this.net.isHost) this.net.send({ t: "ping", ts: performance.now() });
      }

      // respawn overlay (or spectator label for a no-respawn hider)
      if (!this.alive) {
        if (this.selfNoRespawn()) {
          this.hud.respawnOverlay(null);
          const spectating = this.spectateId ? this.names.get(this.spectateId) ?? null : null;
          this.hud.spectate(performance.now() / 1000 - this.deathTime > SPECTATE_AFTER ? spectating : null);
        } else {
          const t = this.respawnAt - now;
          this.hud.respawnOverlay(t > 0 ? t : null);
        }
      }

      // net send
      this.sendAcc += dt;
      if (this.sendAcc >= 1 / TICK_RATE) {
        this.sendAcc = 0;
        this.netTick(now);
      }

      // host game clock
      if (this.net.isHost) {
        this.gameAcc += dt;
        this.hostClock(dt);
      }

      this.hud.timer(this.phase, this.round, this.timeLeft, this.cfg.rounds);
      this.hud.scoreboard(this.sbOpen || this.phase === "inter", this.net.players, this.scores, this.net.myId, this.platforms);
      this.updateModeVisuals();
      this.updateModeHud();
    } else if (this.lobbyView || this.menuView) {
      this.updateLobbyCamera(now);
    }
    this.syncTitle();
    this.hud.update(dt);

    // stats overlay
    this.fpsE += (1 / Math.max(dt, 1e-4) - this.fpsE) * 0.08;
    this.framePeak = Math.max(this.framePeak, dt);
    this.statAcc += dt;
    if (this.statAcc >= 0.25 && this.inGame && this.settings.state.showStats) {
      this.statAcc = 0;
      const tris = this.map.tris + this.remotes.size * 48 + 220;
      // backing-store size + effective pixel ratio: on a Retina display this is
      // where "high fps but janky, fine at half-size" comes from — the frame is
      // fill-rate bound at 2× resolution. `peak` is the worst frame in the last
      // window (ms) — if it's ≫ the average, the hitches are GC/upload spikes.
      this.framePeak = 0;
      // compact: just the numbers that matter at a glance — fps, frame time, tri
      // count and network latency. (Detailed resolution/dpr/solids/speed telemetry
      // was dropped to keep the overlay small and unobtrusive.)
      const ping = this.net.isHost ? "host" : `${this.ping.toFixed(0)}ms`;
      this.hud.stats(
        `<b>${this.fpsE.toFixed(0)}</b> fps · ${(1000 / this.fpsE).toFixed(1)}ms · ${(tris / 1000).toFixed(1)}k tris · ${ping}`
      );
    }
  }

  myState(): PlayerState {
    return {
      id: this.net.myId,
      p: [this.body.pos.x, this.body.pos.y, this.body.pos.z],
      yaw: this.body.yaw,
      pitch: this.body.pitch,
      w: this.ws.current,
      hp: this.alive ? this.myHp : 0,
      g: this.body.onGround,
    };
  }

  netTick(now: number): void {
    if (this.net.isHost) {
      const ps: PlayerState[] = [this.myState()];
      for (const r of this.remotes.values()) {
        ps.push({ id: r.id, p: [r.pos.x, r.pos.y, r.pos.z], yaw: r.yaw, pitch: 0, w: r.weapon, hp: this.hpMap[r.id] ?? 0, g: r.netGround });
      }
      this.net.broadcast({ t: "snap", ps, time: now });
    } else {
      this.net.send({ t: "state", s: this.myState() });
    }
  }

  // ─── shooting ───────────────────────────────────────────────────────────────

  fireHitscan(def: WeaponDef, spread: number): void {
    const o: Vec3 = { x: this.body.pos.x, y: this.body.eyeY, z: this.body.pos.z };
    const pitch = this.body.pitch + this.ws.recoilPitch;
    const cp = Math.cos(pitch);
    let d: Vec3 = { x: -Math.sin(this.body.yaw) * cp, y: Math.sin(pitch), z: -Math.cos(this.body.yaw) * cp };
    // spread
    if (spread > 0) {
      d = { x: d.x + rand(-spread, spread), y: d.y + rand(-spread, spread), z: d.z + rand(-spread, spread) };
      const l = Math.hypot(d.x, d.y, d.z);
      d.x /= l; d.y /= l; d.z /= l;
    }

    this.broadcastShot(o, d, def.id);
    // start the local player's tracer at the gun muzzle so it reads as leaving the gun.
    // In third person the first-person viewmodel is hidden (its muzzle sits at the camera,
    // which would draw the tracer from the corner) — use the third-person avatar's muzzle.
    const muzzle = this.thirdPersonActive()
      ? (this.selfOperator?.gunMuzzle() ?? undefined)
      : (this.ws.muzzleWorld() ?? undefined);
    this.resolveRay(o, d, def, 1, this.net.myId, true, 0, 0, muzzle);
  }

  /** trace one segment; may recurse once through a wall (wallbang). `tracerFrom` overrides
   *  the local player's tracer start (the muzzle); undefined uses an eye-relative point. */
  resolveRay(o: Vec3, d: Vec3, def: WeaponDef, dmgScale: number, shooterId: string, localShooter: boolean, depth = 0, baseDist = 0, tracerFrom?: Vec3): void {
    const wallHit = this.map.raycast(o, d, def.range);
    const wallDist = wallHit ? wallHit.dist : def.range;

    // nearest victim before the wall
    let victim: RemotePlayer | null = null;
    let vDist = wallDist;
    let vHead = false;
    for (const r of this.remotes.values()) {
      const h = r.hitTest(o, d, vDist);
      if (h) { victim = r; vDist = h.dist; vHead = h.head; }
    }

    // explosive barrel closer than any victim/wall → it takes the hit and stops the ray
    const bh = this.map.raycastBarrel(o, d, vDist);
    // a dynamic physics prop the ray reaches (before a barrel) stops it too, and gets
    // shoved. Applied on every client (not just the shooter) so each local sim agrees.
    const pbh = this.physics.raycast(o, d, bh ? Math.min(vDist, bh.dist) : vDist);
    if (pbh && (!bh || pbh.dist < bh.dist)) {
      const pp: Vec3 = { x: o.x + d.x * pbh.dist, y: o.y + d.y * pbh.dist, z: o.z + d.z * pbh.dist };
      this.physics.applyImpulseAt(pbh.body, pp, d, def.melee ? 6 : 9);
      if (localShooter) {
        if (!def.melee) this.tracers.spawn(tracerFrom ?? { x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 }, pp);
        this.tracers.impact(pp);
        const rel = this.relAudio(pp);
        sfx.impact(rel.pan, rel.dist);
      }
      return;
    }
    if (bh) {
      const bp: Vec3 = { x: o.x + d.x * bh.dist, y: o.y + d.y * bh.dist, z: o.z + d.z * bh.dist };
      if (localShooter) {
        if (!def.melee) this.tracers.spawn(tracerFrom ?? { x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 }, bp);
        this.tracers.impact(bp);
        const rel = this.relAudio(bp);
        sfx.impact(rel.pan, rel.dist);
        this.reportBarrelHit(bh.index, Math.max(1, Math.round(def.damage * dmgScale * this.dmgMult)));
      }
      return;
    }

    const end: Vec3 = { x: o.x + d.x * Math.min(vDist, wallDist), y: o.y + d.y * Math.min(vDist, wallDist), z: o.z + d.z * Math.min(vDist, wallDist) };
    if (localShooter) {
      const mo: Vec3 = tracerFrom ?? { x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 };
      if (!def.melee) this.tracers.spawn(mo, end);
    }

    if (victim) {
      let dmg = def.damage * dmgScale * falloff(def, baseDist + vDist);
      if (vHead) dmg *= def.headMult;
      if (localShooter) dmg *= this.dmgMult; // quad-damage powerup
      dmg = Math.max(1, Math.round(dmg));
      if (localShooter) {
        this.hud.hitmarker(vHead);
        sfx.hitmarker(vHead);
        this.reportHit(victim.id, dmg, vHead, def.id);
      }
      return;
    }

    if (wallHit && !def.melee) {
      if (localShooter) {
        this.tracers.impact(end);
        const rel = this.relAudio(end);
        sfx.impact(rel.pan, rel.dist);
      }
      // wallbang
      if (def.penetration > 0 && depth === 0 && dmgScale > 0.5) {
        const thickness = this.map.thicknessAt(end, d, def.penetration);
        if (thickness <= def.penetration) {
          const exit: Vec3 = { x: end.x + d.x * (thickness + 0.02), y: end.y + d.y * (thickness + 0.02), z: end.z + d.z * (thickness + 0.02) };
          this.resolveRay(exit, d, def, dmgScale * def.penDamageKeep * (1 - thickness / (def.penetration * 2)), shooterId, localShooter, 1, baseDist + wallDist);
        }
      }
    }
  }

  reportHit(victimId: string, dmg: number, hs: boolean, w: DeathCause): void {
    if (this.net.isHost) this.hostApplyHit(this.net.myId, victimId, dmg, hs, w);
    else this.net.send({ t: "hit", v: victimId, dmg, hs: hs ? 1 : 0, w });
  }

  broadcastShot(o: Vec3, d: Vec3, w: WeaponId): void {
    const m: Msg = { t: "shot", id: this.net.myId, o: [o.x, o.y, o.z], d: [d.x, d.y, d.z], w };
    if (this.net.isHost) this.net.broadcast(m);
    else this.net.send(m);
  }

  relAudio(p: Vec3): { pan: number; dist: number } {
    const dx = p.x - this.body.pos.x, dz = p.z - this.body.pos.z;
    const dist = Math.hypot(dx, dz);
    const s = Math.sin(this.body.yaw), c = Math.cos(this.body.yaw);
    const rightX = c, rightZ = -s;
    const pan = dist > 0.5 ? clamp((dx * rightX + dz * rightZ) / dist, -1, 1) : 0;
    return { pan, dist };
  }

  /** reload the current weapon and, if it actually started, play the third-person
   *  reload animation on the local operator avatar. */
  localReload(): void {
    const before = this.ws.reloading;
    this.ws.reload();
    if (this.ws.reloading > 0 && before <= 0) this.selfOperator?.triggerUpper("Reload", this.ws.reloading);
  }

  // ─── grenades ───────────────────────────────────────────────────────────────

  throwNade(kind: NadeKind): void {
    // play the toss animation first, then release the projectile at the wind-up peak so
    // the grenade leaves the hand in sync with the arm (was released instantly, before
    // the animation had even started). Aim is sampled at release, not at button-press.
    this.selfOperator?.triggerUpper("ThrowGrenade", 0.9);
    const release = (): void => {
      if (!this.alive || this.ws.current !== kind) return; // died / switched during wind-up
      const d = this.body.aimDir();
      const o: Vec3 = { x: this.body.pos.x + d.x * 0.35, y: this.body.eyeY - 0.05, z: this.body.pos.z + d.z * 0.35 };
      const spd = kind === "he" ? 16 : 14;
      const v: Vec3 = { x: d.x * spd, y: d.y * spd + 3.2, z: d.z * spd };
      this.nades.throw_(kind, o, v, this.net.myId, true);
      const m: Msg = { t: "nade", id: this.net.myId, k: kind, o: [o.x, o.y, o.z], v: [v.x, v.y, v.z] };
      if (this.net.isHost) this.net.broadcast(m);
      else this.net.send(m);
      // last one thrown → the spent throwable leaves the loadout, so switch off it at once
      // (keep the gungame/prophunt weapon lock). Immediate so the HUD never shows a 0-ammo nade.
      if (this.ws.ammo[kind].mag <= 0 && this.ws.current === kind) {
        if (this.mode === "gungame") this.applyTier(this.tiers[this.net.myId] ?? 0);
        else if (this.canSwitchWeapon()) { this.ws.select("ak47"); this.applyScopeFov(); }
      }
    };
    window.setTimeout(release, THROW_WINDUP_MS);
  }

  /** area damage from a blast at `c`. `cause` attributes the kill — a thrown HE
   *  grenade ("he") or an exploding barrel/environmental charge ("barrel"). */
  explodeDamage(c: Vec3, cause: DeathCause = "he"): void {
    const targets: { id: string; p: Vec3 }[] = this.alive ? [{ id: this.net.myId, p: this.body.pos }] : [];
    for (const r of this.remotes.values()) if (r.alive) targets.push({ id: r.id, p: r.pos });
    for (const t of targets) {
      const tc: Vec3 = { x: t.p.x, y: t.p.y + 0.9, z: t.p.z };
      const dx = tc.x - c.x, dy = tc.y - c.y, dz = tc.z - c.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > HE_RADIUS) continue;
      const dir: Vec3 = { x: dx / (dist || 1), y: dy / (dist || 1), z: dz / (dist || 1) };
      const wall = this.map.raycast({ x: c.x, y: c.y + 0.15, z: c.z }, dir, dist);
      if (wall && wall.dist < dist - 0.3) continue; // fully blocked
      const dmg = Math.max(1, Math.round(HE_DAMAGE * (1 - dist / HE_RADIUS)));
      this.reportHit(t.id, dmg, false, cause);
    }
  }

  fireTickDamage(c: Vec3): void {
    const targets: { id: string; p: Vec3 }[] = this.alive ? [{ id: this.net.myId, p: this.body.pos }] : [];
    for (const r of this.remotes.values()) if (r.alive) targets.push({ id: r.id, p: r.pos });
    for (const t of targets) {
      if (Math.hypot(t.p.x - c.x, t.p.z - c.z) < MOL_RADIUS && Math.abs(t.p.y - c.y) < 2) {
        this.reportHit(t.id, MOL_TICK_DMG, false, "mol");
      }
    }
  }

  // ─── explosive barrels ───────────────────────────────────────────────────────

  reportBarrelHit(i: number, dmg: number): void {
    if (this.net.isHost) this.hostBarrelHit(i, dmg);
    else this.net.send({ t: "bhit", i, dmg });
  }

  hostBarrelHit(i: number, dmg: number): void {
    const b = this.map.barrels[i];
    if (!b || b.dead) return;
    b.hp -= dmg;
    if (b.hp <= 0) this.hostBarrelExplode(i);
  }

  hostBarrelExplode(i: number): void {
    const b = this.map.barrels[i];
    if (!b || b.dead) return;
    const c: Vec3 = { ...b.pos };
    this.map.killBarrel(i);
    this.spawnBarrelFx(c);
    this.explodeDamage(c, "barrel"); // host applies HE-like area damage, credited to the barrel
    this.net.broadcast({ t: "bexp", i });
  }

  spawnBarrelFx(c: Vec3): void {
    this.nades.explodeFx(c);
    this.physics.applyExplosion(c, HE_RADIUS, 52);   // barrels fling nearby props harder
  }

  // ─── host authority ─────────────────────────────────────────────────────────

  hostApplyHit(attacker: string, victim: string, dmg: number, hs: boolean, w: DeathCause): void {
    if (this.phase !== "play") return;
    const hp = this.hpMap[victim];
    if (hp === undefined || hp <= 0) return;
    // team modes: no friendly fire (TDM sides / Prop Hunt roles)
    if (MODES[this.mode].teams && attacker !== victim && this.teams[attacker] === this.teams[victim]) return;
    // prep phase: seekers can't hurt hiders while the hiders are still scattering
    if (this.mode === "prophunt" && this.inPrepPhase()) return;
    const nhp = Math.max(0, hp - dmg);
    this.hpMap[victim] = nhp;
    const from = this.posOf(attacker);
    const dmgMsg: Msg = { t: "dmg", v: victim, hp: nhp, a: attacker, from: [from.x, from.y, from.z] };
    this.net.broadcast(dmgMsg);
    this.applyLocal(dmgMsg);
    if (nhp <= 0) {
      this.scores[attacker] = this.scores[attacker] ?? { k: 0, d: 0 };
      this.scores[victim] = this.scores[victim] ?? { k: 0, d: 0 };
      if (attacker !== victim) this.scores[attacker].k++;
      this.scores[victim].d++;
      const killMsg: Msg = { t: "kill", k: attacker, v: victim, w, hs: hs ? 1 : 0 };
      this.net.broadcast(killMsg);
      this.applyLocal(killMsg);
      this.hostModeOnKill(attacker, victim, w);
      this.npcOnKill(attacker, victim, w, hs);
      this.pushGame();
      const respawn = MODES[this.mode].respawn;
      // prop hunt: dead hiders don't respawn (they stay out for the round)
      const noRespawn = this.mode === "prophunt" && this.teams[victim] === ROLE_HIDE;
      if (!noRespawn) window.setTimeout(() => this.hostSpawn(victim), respawn * 1000);
    }
  }

  /** host-only: broadcast a chat line as if a bot typed it, and show it locally.
   *  Mirrors the wire shape a guest→host "chat" message would take. */
  botSay(botId: string, txt: string): void {
    if (!this.net.isHost || !this.bots.has(botId)) return;
    const clean = txt.slice(0, 120);
    this.hud.chatMsg(this.names.get(botId) ?? "bot", this.net.colorOf(botId), clean);
    this.net.broadcast({ t: "chat", id: botId, txt: clean });
    this.npcLog.push(`${this.names.get(botId) ?? "bot"}: ${clean}`);
    if (this.npcLog.length > 20) this.npcLog.shift();
  }

  /** a bot's tone toward a human: teammates (same side in a team mode) vs enemies.
   *  FFA / gungame have no teams → everyone is an enemy, so banter stays toxic. */
  private botRelation(botId: string, humanId: string): Relation {
    if (MODES[this.mode].teams && this.teams[botId] !== undefined && this.teams[botId] === this.teams[humanId]) {
      return "teammate";
    }
    return "enemy";
  }

  /** compact match-state facts fed to the model so bots have real stuff to riff on:
   *  the mode, where the match is at, and the two combatants' scoreboards. */
  private npcFacts(aId: string, bId: string): string[] {
    const facts: string[] = [];
    const m = MODES[this.mode];
    facts.push(`mode: ${m.name}, round ${Math.max(1, this.round)}/${this.cfg.rounds}, ${this.timeLeftLabel()} left`);
    if (m.teams) {
      const label = this.mode === "prophunt" ? ["seekers", "hiders"] : [TEAM_NAMES[0], TEAM_NAMES[1]];
      facts.push(`team score: ${label[0]} ${this.teamScore[0]} — ${label[1]} ${this.teamScore[1]}`);
    }
    const kd = (id: string): string => {
      const s = this.scores[id] ?? { k: 0, d: 0 };
      const tag = MODES[this.mode].teams && this.teams[id] !== undefined && this.teams[id] === this.teams[aId]
        ? " (same team as you)" : "";
      const wep = this.npcWeapon[id] ? `, running a ${this.npcWeapon[id]}` : "";
      return `${this.names.get(id) ?? id}${tag}: ${s.k} kills ${s.d} deaths${wep}`;
    };
    facts.push(`scores — ${kd(aId)}; ${kd(bId)}`);
    return facts;
  }

  /** rough "M:SS" of the time left in the round (for match-state facts). */
  private timeLeftLabel(): string {
    const t = Math.max(0, Math.floor(this.timeLeft));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  /** the bot's own most recent chat line (from the log), for anchoring a reply thread. */
  private npcLastLineBy(botId: string): string | null {
    const tag = `${this.names.get(botId) ?? "bot"}: `;
    for (let i = this.npcLog.length - 1; i >= 0; i--) {
      if (this.npcLog[i].startsWith(tag)) return this.npcLog[i].slice(tag.length);
    }
    return null;
  }

  /** gate + fire one unprompted NPC line: honours per-bot and global cooldowns and a
   *  probability roll so bots don't chatter on every single kill/death. */
  private npcTryLine(botId: string, human: string, relation: Relation, situation: string, prob: number): void {
    if (!this.cfg.aiChat || !this.npc?.ready || !this.bots.has(botId)) return;
    const now = performance.now() / 1000;
    if (now < (this.npcBotCd[botId] ?? 0)) return;   // this bot spoke too recently
    if (now < this.npcSpontaneousCd) return;         // global anti-spam across all bots
    if (Math.random() > prob) return;                // …and only sometimes even then
    this.npcBotCd[botId] = now + 10;
    this.npcSpontaneousCd = now + 4;
    const bot = this.names.get(botId) ?? "bot";
    const player = this.names.get(human) ?? "player";
    void this.npc.line({
      bot, player, relation, situation,
      context: this.npcFacts(botId, human),
    }).then((line) => {
      if (line && this.bots.has(botId)) this.botSay(botId, line);
    });
  }

  /** host-only: react to a kill. Bots rage-bait enemies they drop, get salty when a
   *  human keeps farming them, and a teammate bot may hype a human on a streak. Only
   *  *sometimes* — see npcTryLine — so it fires when it makes sense, not every frag. */
  private npcOnKill(attacker: string, victim: string, w: DeathCause, hs: boolean): void {
    if (!this.net.isHost || attacker === victim) return;
    const aBot = this.bots.has(attacker), vBot = this.bots.has(victim);

    // remember the last bot a human traded kills with — used to resolve who a later
    // chat message is aimed at when no bot is named explicitly.
    if (aBot !== vBot) {
      const human = aBot ? victim : attacker;
      this.npcRival[human] = aBot ? attacker : victim;
    }
    // remember the weapon each killer is using — fuels weapon-specific jabs later.
    this.npcWeapon[attacker] = deathCauseLabel(w);
    // kill-streak bookkeeping for everyone (humans + bots); a death resets it.
    this.npcStreakK[attacker] = (this.npcStreakK[attacker] ?? 0) + 1;
    this.npcStreakK[victim] = 0;

    if (!this.cfg.aiChat || !this.npc?.ready) return;

    const weapon = deathCauseLabel(w);
    const hsTag = hs ? " with a headshot" : "";

    // bot dropped a human enemy → cocky rage-bait (friendly fire is blocked upstream,
    // so a bot killing a human is always an enemy kill).
    if (aBot && !vBot) {
      this.npcTryLine(attacker, victim, "enemy",
        `You just fragged ${this.names.get(victim) ?? "them"} with your ${weapon}${hsTag}. ` +
        `Rage-bait them in one line — act like it was free, mention how you did it.`,
        0.45);
    }

    // human keeps killing the same bot → it gets salty and names them (never concedes).
    if (!aBot && vBot) {
      const tally = (this.npcDeaths[victim] ??= {});
      const deaths = (tally[attacker] = (tally[attacker] ?? 0) + 1);
      if (deaths >= 2) {
        this.npcTryLine(victim, attacker, "enemy",
          `${this.names.get(attacker) ?? "they"} has killed you ${deaths} times, this time with a ${weapon}${hsTag}. ` +
          `Fire back one salty line naming them — never admit they're good, mock their ${weapon} or make an excuse.`,
          0.6);
      }
    }

    // human on a tear → a living TEAMMATE bot hypes them up (team modes only).
    if (!aBot) {
      const s = this.npcStreakK[attacker];
      if (s >= 3 && s % 2 === 1) {
        const mate = this.pickTeammateBot(attacker);
        if (mate) {
          this.npcTryLine(mate, attacker, "teammate",
            `Your teammate ${this.names.get(attacker) ?? "them"} is on a ${s}-kill streak. Hype them up in one line.`,
            0.6);
        }
      }
    }

    // a BOT on a rampage → a different bot pipes up ABOUT it (npc-to-npc banter):
    // a teammate hypes, an enemy accuses it of hacking. Keeps bots talking to each
    // other, not just the player. Rate-limited like every other unprompted line.
    if (aBot) {
      const s = this.npcStreakK[attacker];
      if (s >= 3 && s % 2 === 1) {
        const other = this.pickOtherBot(attacker);
        if (other) {
          const rel = this.botRelation(other, attacker);
          const name = this.names.get(attacker) ?? "that bot";
          const situation = rel === "teammate"
            ? `Your teammate ${name} is on a ${s}-kill streak. Hype ${name} up by name in one line.`
            : `Rival bot ${name} is on a ${s}-kill streak. Trash-talk ${name} by name in one line — call them a hacker or lucky.`;
          this.npcTryLine(other, attacker, rel, situation, 0.5);
        }
      }
    }
  }

  /** a random living bot other than `exclude` (for bot-to-bot banter), else null. */
  private pickOtherBot(exclude: string): string | null {
    const pool = [...this.bots.keys()].filter((id) => id !== exclude && (this.hpMap[id] ?? 0) > 0);
    return pool.length ? shuffle(pool)[0] : null;
  }

  /** a random living bot on the same team as `human` (team modes only), else null. */
  private pickTeammateBot(human: string): string | null {
    if (!MODES[this.mode].teams) return null;
    const team = this.teams[human];
    if (team === undefined) return null;
    const mates = [...this.bots.keys()].filter((id) => this.teams[id] === team && (this.hpMap[id] ?? 0) > 0);
    return mates.length ? shuffle(mates)[0] : null;
  }

  /** host-only: a human sent a chat line. Work out which bot(s) it's aimed at —
   *  a named bot, else the bot they've been trading kills with, else a random one —
   *  and have them answer in-character (toxic to enemies, chill to teammates). */
  private npcOnChat(fromId: string, txt: string): void {
    if (!this.net.isHost) return;
    const who = this.names.get(fromId) ?? "player";
    this.npcLog.push(`${who}: ${txt}`);
    if (this.npcLog.length > 20) this.npcLog.shift();
    if (!this.cfg.aiChat || !this.npc?.ready || this.bots.has(fromId)) return; // off / not ready / bot line
    const now = performance.now() / 1000;
    if (now < this.npcReplyCd) return;

    const lower = txt.toLowerCase();
    const nameHit = (id: string): boolean => {
      const n = (this.names.get(id) ?? "").toLowerCase();
      return n.length >= 2 && new RegExp(`\\b${escapeRe(n)}\\b`).test(lower);
    };
    const namedBots = [...this.bots.keys()].filter(nameHit);
    // other humans named in the message → the line is aimed at another player
    const namedOtherHuman = this.net.players.some(
      (p) => !this.bots.has(p.id) && p.id !== fromId && nameHit(p.id),
    );

    // Resolve who (if anyone) should answer. The golden rule: NEVER let a bot answer
    // a message that was addressed to someone else.
    let targets: string[];
    let addressed: boolean;
    if (namedBots.length) {
      targets = namedBots;      // named a bot (or bots) → exactly those, nobody else
      addressed = true;
    } else if (namedOtherHuman) {
      return;                   // aimed at another human → every bot stays quiet
    } else {
      // no name at all → the bot they're actively dueling may field it, else a random
      // living bot chimes in on the open chatter. Only ever one bot here.
      addressed = false;
      const rival = this.npcRival[fromId];
      if (rival && this.bots.has(rival)) {
        targets = [rival];
      } else {
        const live = [...this.bots.keys()].filter((id) => (this.hpMap[id] ?? 0) > 0);
        const pool = live.length ? live : [...this.bots.keys()];
        if (!pool.length) return;
        targets = [shuffle(pool)[0]];
      }
    }

    this.npcReplyCd = now + 5;
    const transcript = this.npcLog.slice();
    targets.slice(0, 2).forEach((id, i) => {
      const bot = this.names.get(id) ?? "bot";
      const relation = this.botRelation(id, fromId);
      // anchor the thread: spell out that THIS bot is the addressee, and remind it
      // what it last said so a back-and-forth actually tracks.
      const mine = this.npcLastLineBy(id);
      const priorLine = mine ? ` Earlier you said "${mine}", and they are responding to that.` : "";
      const lead = addressed
        ? `${who} is talking directly TO YOU (${bot}) by name.`
        : `${who} is talking TO YOU (${bot}) — they've been dueling you.`;
      window.setTimeout(() => {
        if (!this.bots.has(id)) return;
        void this.npc!.line({
          bot, player: who, relation, transcript,
          context: this.npcFacts(id, fromId),
          situation: `${lead}${priorLine} They just said: "${txt}". Reply directly to ${who} in one line, ` +
            `in character as their ${relation}. Do not answer anyone else.`,
        }).then((line) => {
          if (line && this.bots.has(id)) this.botSay(id, line);
        });
      }, i * 900);                                            // stagger so replies don't collide
    });
  }

  /** true during the Prop-Hunt hide window at the start of a round */
  inPrepPhase(): boolean {
    return this.mode === "prophunt" && this.phase === "play" && this.timeLeft > this.cfg.roundTime - PROPHUNT_PREP;
  }

  /** host: mode-specific consequences of a kill (team score, gungame ladder, prophunt end) */
  hostModeOnKill(attacker: string, victim: string, w: DeathCause): void {
    if (attacker === victim) return;
    if (this.mode === "tdm") {
      const t = this.teams[attacker];
      if (t === 0 || t === 1) this.teamScore[t]++;
    } else if (this.mode === "gungame") {
      const cur = this.tiers[attacker] ?? 0;
      if (cur >= GUNGAME_FINAL) { this.hostGunGameWin(attacker); return; }
      this.hostSetTier(attacker, cur + 1);
      if (w === "knife") { // a melee kill demotes the victim one tier
        this.hostSetTier(victim, Math.max(0, (this.tiers[victim] ?? 0) - 1));
      }
    } else if (this.mode === "prophunt") {
      // hider eliminated → if that was the last one, seekers take the round now
      if (this.teams[victim] === ROLE_HIDE && this.livingHiders() === 0) this.timeLeft = 0.02;
    }
  }

  hostSetTier(id: string, tier: number): void {
    this.tiers[id] = tier;
    if (id === this.net.myId) this.applyTier(tier);
    else this.net.sendTo(id, { t: "tier", tier });
  }

  hostGunGameWin(winner: string): void {
    this.hud.banner(`${this.names.get(winner) ?? "player"} reached the knife!`, 3000);
    this.phase = "over";
    this.pushGame();
    this.enterEnd();
  }

  /** count of hiders still alive (host, prop hunt) */
  livingHiders(): number {
    let n = 0;
    for (const p of this.net.players) {
      if (this.teams[p.id] === ROLE_HIDE && (this.hpMap[p.id] ?? 0) > 0) n++;
    }
    return n;
  }

  posOf(id: string): Vec3 {
    if (id === this.net.myId) return this.body.pos;
    return this.remotes.get(id)?.pos ?? { x: 0, y: 0, z: 0 };
  }

  hostSpawn(id: string): void {
    if (this.phase !== "play") return;
    if (!this.net.players.some((p) => p.id === id)) return;
    const sp = this.pickSpawn();
    this.hpMap[id] = MAX_HP;
    const bot = this.bots.get(id);
    if (bot) {
      bot.body.teleport(sp.p, sp.yaw);
      bot.targetId = null; bot.fireCd = 0.4; bot.burstCd = 0;
      bot.seen = false; bot.reactCd = 0; bot.memoryCd = 0; bot.lastKnown = null;
      bot.wanderYaw = bot.body.yaw; bot.lastHp = MAX_HP; bot.dodgeLockCd = 0;
      bot.reloadCd = 0; bot.switchCd = 0;
      if (this.mode !== "gungame") { // fresh loadout each life
        const primary = pickBotWeapon();
        bot.arsenal = [...new Set<WeaponId>([primary, "usp", "knife"])];
        bot.weapon = primary; bot.mag = WEAPONS[primary].mag;
      }
    }
    const m: Msg = { t: "spawn", id, p: [sp.p.x, sp.p.y, sp.p.z], yaw: sp.yaw };
    this.net.broadcast(m);
    // deliver the mode loadout directly (unreliable channel → don't rely on snapshot order)
    if (id !== this.net.myId) {
      if (this.mode === "prophunt") this.net.sendTo(id, { t: "role", role: this.teams[id] ?? ROLE_SEEK, prop: 0 });
      else if (this.mode === "gungame") this.net.sendTo(id, { t: "tier", tier: this.tiers[id] ?? 0 });
    }
    this.applyLocal(m);
  }

  pickSpawn(): { p: Vec3; yaw: number } {
    // random among spawns far enough from every living enemy; fallback: random top-half by distance
    const enemies: Vec3[] = [];
    for (const r of this.remotes.values()) if (r.alive) enemies.push(r.pos);
    if (this.alive) enemies.push(this.body.pos);
    const scored = this.map.spawns.map((s) => {
      let minD = 1e9;
      for (const e of enemies) minD = Math.min(minD, Math.hypot(s.p.x - e.x, s.p.z - e.z));
      return { s, minD };
    });
    const safe = scored.filter((v) => v.minD > 12);
    if (safe.length) return safe[(Math.random() * safe.length) | 0].s;
    scored.sort((a, b) => b.minD - a.minD);
    const pool = scored.slice(0, Math.max(3, scored.length >> 1));
    return pool[(Math.random() * pool.length) | 0].s;
  }

  hostClock(dt: number): void {
    for (let i = 0; i < this.pkTimers.length; i++) {
      if (this.pkTimers[i] > 0) {
        this.pkTimers[i] -= dt;
        if (this.pkTimers[i] <= 0) { this.pkTimers[i] = 0; this.pkEntities[i].isActive = true; }
      }
    }
    if (this.phase === "play" || this.phase === "inter") {
      this.timeLeft -= dt;
      if (this.gameAcc >= 1) { this.gameAcc = 0; this.pushGame(); }
      if (this.timeLeft <= 0) {
        if (this.phase === "play") {
          // prop hunt: whoever's left standing takes the round
          if (this.mode === "prophunt") {
            if (this.livingHiders() > 0) this.teamScore[ROLE_HIDE]++;
            else this.teamScore[ROLE_SEEK]++;
          }
          if (this.round >= this.cfg.rounds) {
            this.phase = "over";
            this.pushGame();
            this.enterEnd();
          } else {
            this.phase = "inter";
            this.timeLeft = INTERMISSION;
            this.pushGame();
            this.hud.banner(`Round ${this.round} over`);
            sfx.roundEnd();
            sfx.startInterlude();
          }
        } else {
          void this.hostStartRound(this.round + 1);
        }
      }
    }
  }

  async hostStartRound(n: number): Promise<void> {
    // round 1 = random map; later rounds = plurality of the interlude vote when
    // there are human guests to vote, otherwise just keep rotating randomly
    const mapId = n === 1 ? randomMapId()
      : this.hasHumanGuests() ? pickVotedMap(this.mapVotes) : this.currentMapId;
    await this.loadMap(mapId);
    this.mapVotes = {};
    this.myVote = null;
    this.hud.vote(null);

    this.phase = "play";
    this.round = n;
    this.timeLeft = this.cfg.roundTime;
    this.applyPhysicsConfig();
    this.pkTimers = this.map.pickupSpots.map(() => 0);
    for (const e of this.pkEntities) e.isActive = true;
    this.pwSpawnAcc = 0;
    for (let i = 0; i < this.pwActive.length; i++) { this.pwActive[i] = null; if (this.pwEntities[i]) this.pwEntities[i].isActive = false; }
    this.clearBuff();
    this.hostSetupRoundMode(n);
    for (const p of this.net.players) this.hpMap[p.id] = MAX_HP;
    this.pushGame(); // sync mode/teams/tiers before spawns carry the loadout
    for (const p of this.net.players) this.hostSpawn(p.id);
    sfx.stopInterlude();
    const modeName = MODES[this.mode].name;
    this.hud.banner(`${modeName} · ${this.map.meta.name} — Round ${n}`);
    sfx.roundStart();
  }

  /** host: (re)assign teams / roles / gungame tiers for a round */
  hostSetupRoundMode(n: number): void {
    const ids = this.net.players.map((p) => p.id);
    if (n === 1) { this.teamScore = [0, 0]; this.tiers = {}; }
    this.teams = {};
    if (this.mode === "tdm") {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      shuffled.forEach((id, i) => { this.teams[id] = i % 2; });
    } else if (this.mode === "prophunt") {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      const seekers = seekerCount(ids.length);
      shuffled.forEach((id, i) => { this.teams[id] = i < seekers ? ROLE_SEEK : ROLE_HIDE; });
    } else if (this.mode === "gungame") {
      for (const id of ids) if (this.tiers[id] === undefined) this.tiers[id] = 0;
    }
    this.myRole = this.teams[this.net.myId] ?? ROLE_SEEK;
  }

  pushGame(): void {
    const g = this.gameSnap();
    this.net.broadcast({ t: "game", g });
    this.applyGame(g);
  }

  gameSnap(): GameSnapshot {
    return {
      phase: this.phase, round: this.round, timeLeft: this.timeLeft, scores: this.scores,
      pk: this.pkTimers.map((t) => Math.ceil(t)), map: this.currentMapId,
      mode: this.mode, cfg: this.cfg, teams: this.teams, teamScore: this.teamScore, tiers: this.tiers,
      platforms: this.platforms,
    };
  }

  applyGame(g: GameSnapshot): void {
    const prevPhase = this.phase;
    // guests follow the host's loaded map
    if (!this.net.isHost && g.map && g.map !== this.currentMapId) void this.loadMap(g.map);
    this.phase = g.phase;
    this.round = g.round;
    this.timeLeft = g.timeLeft;
    this.scores = g.scores;
    // mirror mode state (guests)
    if (g.mode) this.mode = g.mode;
    if (g.cfg) { this.cfg = g.cfg; if (!this.net.isHost) this.applyPhysicsConfig(); }
    if (g.teams) this.teams = g.teams;
    if (g.teamScore) this.teamScore = g.teamScore;
    if (g.tiers) this.tiers = g.tiers;
    // merge synced input-device icons, but never let a stale host snapshot stomp our
    // own live platform (we're the source of truth for the device we're holding).
    if (g.platforms) { this.platforms = { ...g.platforms }; this.platforms[this.net.myId] = this.myPlatform; }
    if (!this.net.isHost) this.myRole = this.teams[this.net.myId] ?? ROLE_SEEK;
    if (g.phase === "lobby") this.refreshLobby(); // keep the lobby mode label in sync
    // map-vote UI opens during the interlude, closes when the round starts
    if (prevPhase !== "inter" && g.phase === "inter") this.openVote(g.map);
    if (g.phase !== "inter" && prevPhase === "inter") this.hud.vote(null);
    if (!this.net.isHost && g.pk) {
      for (let i = 0; i < this.pkEntities.length; i++) this.pkEntities[i].isActive = (g.pk[i] ?? 0) <= 0;
    }
    if (!this.net.isHost) {
      if (prevPhase !== "inter" && g.phase === "inter") { this.hud.banner(`Round ${g.round} over`); sfx.roundEnd(); sfx.startInterlude(); }
      if (prevPhase !== "play" && g.phase === "play") { sfx.stopInterlude(); this.hud.banner(`${this.map.meta.name} · Round ${g.round} — go!`); sfx.roundStart(); }
      if (g.phase === "over" && prevPhase !== "over") this.enterEnd();
    }
  }

  enterEnd(): void {
    this.inGame = false;
    if (this.selfAvatar) this.selfAvatar.isActive = false;
    if (this.selfOperator) this.selfOperator.entity.isActive = false;
    document.body.classList.remove("hider");
    document.exitPointerLock();
    this.spectateId = null;
    this.hud.spectate(null);
    this.hud.respawnOverlay(null);
    this.hud.end(this.net.players, this.scores, this.net.isHost, this.resultTitle(), this.net.myId, this.platforms);
    this.hud.show("end");
    sfx.muffle(false); // clear any death-cam muffle carried into the end screen
    sfx.death();
    sfx.stopInterlude();
    sfx.startTheme();
  }

  // ─── map loading / rotation ───────────────────────────────────────────────────

  /** HDRI cube for a path, loaded at most once (skybox + IBL specular source) */
  loadHdri(path: string): Promise<TextureCube> {
    let p = this.hdriCache.get(path);
    if (!p) { p = loadHDRCube(this.engine, path); this.hdriCache.set(path, p); }
    return p;
  }

  /** load (or hot-swap) a map by id: resolve palette + sky, rebuild geometry,
   *  env, pickups & powerups. async — textures/HDRI load (cached) per map. */
  async loadMap(id: string): Promise<void> {
    // tear down old pickup/powerup visuals (map geometry is torn down by map.load)
    for (const e of this.pkEntities) e.destroy();
    for (const e of this.pwEntities) e.destroy();
    this.pkEntities = [];
    this.pwEntities = [];
    this.pwMats = [];
    this.pwActive = [];
    const def = mapById(id);
    const tex = await resolveTextures(this.engine, mapTextureFolders(def));
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.physics.syncFromMap();   // (re)bind prop colliders + rebuild static world (PhysX)
    this.currentMapId = id;
    await this.applyEnv(def.env);
    this.buildPickups(this.root);
    this.buildPowerups(this.root);
    this.updateAmbientWater();
  }

  /** shade the weapon viewmodels with their models' assigned materials. Guns are
   *  geometry-only glTFs (all textures live in the material library), so this loads
   *  just the texture folders those materials need, builds a one-off material library,
   *  and hands it to the weapon system — otherwise the guns render untextured. */
  private async applyWeaponMaterials(): Promise<void> {
    const folders = this.ws.weaponModelFolders();
    if (!folders.length) return;
    const metas = new Map<string, ModelMeta>();
    const matNames = new Set<string>();
    for (const f of folders) {
      const meta = catalog.models.find((m) => m.name === f)?.meta ?? {};
      metas.set(f, meta);
      for (const mat of modelMaterials(meta)) matNames.add(mat);
    }
    if (!matNames.size) return;
    const tex = await resolveTextures(this.engine, materialTextureFolders(matNames));
    const lib = new MaterialLibrary(this.engine, tex);
    this.ws.applyModelMaterials(metas, lib);
    // the thrown-grenade models (wep_frag / wep_molotov) are among these weapon models,
    // so the same library shades the projectiles a player throws.
    this.nades.setMaterialLibrary(lib);
  }

  /** shade the Prop-Hunt disguise props with their models' assigned MAIN materials.
   *  Disguise models (Barrel_01, crates, …) reference material slots just like map
   *  placements do, so — exactly like the gun viewmodels — we load only the texture
   *  folders those materials need and build a one-off library the disguises shade
   *  against. Without it a disguise renders with its untextured glTF placeholder. */
  private async ensureDisguiseMaterials(): Promise<void> {
    if (this.disguiseLib) return;
    const matNames = new Set<string>();
    for (const name of this.propPool) {
      const meta = catalog.models.find((m) => m.name === name)?.meta;
      for (const mat of modelMaterials(meta)) matNames.add(mat);
    }
    if (!matNames.size) return;
    const tex = await resolveTextures(this.engine, materialTextureFolders(matNames));
    this.disguiseLib = new MaterialLibrary(this.engine, tex);
  }

  /** apply a map's skybox / fog / lighting identity (awaits its HDRI if any) */
  async applyEnv(env: MapEnv): Promise<void> {
    const scene = this.engine.sceneManager.activeScene;
    this.sunE.transform.setRotation(env.sun.rot[0], env.sun.rot[1], env.sun.rot[2]);
    const sc = envSunColor(env);
    this.sun.color = new Color(sc[0], sc[1], sc[2], 1);
    this.amb.diffuseSolidColor = new Color(env.ambient.color[0], env.ambient.color[1], env.ambient.color[2], 1);
    this.amb.diffuseIntensity = env.ambient.intensity;
    this.amb.specularIntensity = env.ambient.specular ?? 0.85;
    applyShadows(scene, this.sun, env, this.shadowCap());   // clamped to device preset
    applyPost(env, this.bloom, this.tone);                  // tonemapping + bloom from env
    if (env.fog) applyFogFalloff(scene, env.fog);
    else scene.fogMode = FogMode.None;
    if (env.sky.hdri) {
      const cube = await this.loadHdri(env.sky.hdri);
      this.skyMat.texture = cube;
      this.amb.specularTexture = cube;
      scene.background.mode = BackgroundMode.Sky;
      scene.background.sky.material = this.skyMat;
    } else {
      const s = env.sky.solid ?? [0, 0, 0];
      // don't carry a prior map's IBL into a solid-sky map (runtime accepts null → solid ambient)
      this.amb.specularTexture = null as unknown as TextureCube;
      scene.background.mode = BackgroundMode.SolidColor;
      scene.background.solidColor = new Color(s[0], s[1], s[2], 1);
    }
  }

  /** ambient water loop plays only in-game on maps that define a water source */
  updateAmbientWater(): void {
    if (this.inGame && this.map.env.water) sfx.startAmbientWater();
    else sfx.stopAmbientWater();
  }

  // ─── map voting (interlude) ────────────────────────────────────────────────────

  /** open the next-map vote card UI for the interlude */
  openVote(currentId: string): void {
    if (!this.hasHumanGuests()) { this.hud.vote(null); return; } // no human voters → keep rotating
    this.myVote = null;
    if (this.net.isHost) this.mapVotes = {};
    this.lastVoteCounts = {};
    this.hud.vote(mapMetas(), currentId);
    this.hud.voteCounts({}, null);
  }

  /** local player picked a map → record/route the vote */
  castVote(id: string): void {
    this.myVote = id;
    if (this.net.isHost) {
      this.mapVotes[this.net.myId] = id;
      this.broadcastVotes();
    } else {
      this.net.send({ t: "mapvote", map: id });
      this.hud.voteCounts(this.lastVoteCounts, id);
    }
  }

  /** host: recompute + broadcast the live vote tally */
  broadcastVotes(): void {
    const counts = tallyVotes(this.mapVotes);
    this.lastVoteCounts = counts;
    this.net.broadcast({ t: "votes", counts });
    this.hud.voteCounts(counts, this.myVote);
  }

  // ─── health pickups ─────────────────────────────────────────────────────────

  buildPickups(root: Entity): void {
    const mat = new UnlitMaterial(this.engine);
    mat.baseColor = new Color(0.35, 3.4, 0.9, 1); // HDR green → bloom
    for (const sp of this.map.pickupSpots) {
      const g = root.createChild("pk");
      g.transform.setPosition(sp.x, sp.y, sp.z);
      for (const [w, h] of [[0.52, 0.18], [0.18, 0.52]] as const) {
        const c = g.createChild("x");
        const r = c.addComponent(MeshRenderer);
        r.mesh = PrimitiveMesh.createCuboid(this.engine, w, h, 0.14);
        r.setMaterial(mat);
      }
      this.pkEntities.push(g);
    }
    this.pkTimers = this.map.pickupSpots.map(() => 0);
  }

  hostCheckPickups(): void {
    for (let i = 0; i < this.map.pickupSpots.length; i++) {
      if (this.pkTimers[i] > 0) continue;
      const sp = this.map.pickupSpots[i];
      for (const p of this.net.players) {
        const hp = this.hpMap[p.id] ?? 0;
        if (hp <= 0 || hp >= MAX_HP) continue;
        const pos = p.id === this.net.myId ? this.body.pos : this.remotes.get(p.id)?.pos;
        if (!pos) continue;
        if (Math.hypot(pos.x - sp.x, pos.z - sp.z) < PICKUP_RADIUS && Math.abs(pos.y + 1 - sp.y) < 1.8) {
          this.hostTakePickup(i, p.id);
          break;
        }
      }
    }
  }

  hostTakePickup(i: number, id: string): void {
    const hp = Math.min(MAX_HP, (this.hpMap[id] ?? 0) + PICKUP_HEAL);
    this.hpMap[id] = hp;
    this.pkTimers[i] = PICKUP_RESPAWN;
    this.pkEntities[i].isActive = false;
    const heal: Msg = { t: "heal", v: id, hp };
    this.net.broadcast(heal);
    this.applyLocal(heal);
    this.net.broadcast({ t: "pkup", i });
    this.pushGame();
  }

  // ─── powerups / modifiers ─────────────────────────────────────────────────────

  buildPowerups(root: Entity): void {
    for (const sp of this.map.powerupSpots) {
      const g = root.createChild("pw");
      g.transform.setPosition(sp.x, sp.y, sp.z);
      const r = g.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createSphere(this.engine, 0.3, 3); // low-poly gem
      const m = new UnlitMaterial(this.engine);
      r.setMaterial(m);
      g.isActive = false;
      this.pwEntities.push(g);
      this.pwMats.push(m);
      this.pwActive.push(null);
    }
  }

  /** host: try to activate a random empty powerup spot with a rarity-weighted kind */
  hostSpawnPowerup(): void {
    const free: number[] = [];
    for (let i = 0; i < this.pwActive.length; i++) if (!this.pwActive[i]) free.push(i);
    if (!free.length) return;
    const i = free[(Math.random() * free.length) | 0];
    const k = randomPowerup();
    this.applyPwSpawn(i, k);
    this.net.broadcast({ t: "pwspawn", i, k });
  }

  applyPwSpawn(i: number, k: PowerupKind): void {
    if (!this.pwEntities[i]) return;
    this.pwActive[i] = k;
    const c = POWERUPS[k].color;
    // HDR-boosted colour → bloom glow
    this.pwMats[i].baseColor = new Color(((c >> 16) & 255) / 255 * 4, ((c >> 8) & 255) / 255 * 4, (c & 255) / 255 * 4, 1);
    this.pwEntities[i].isActive = true;
  }

  hostCheckPowerups(): void {
    for (let i = 0; i < this.pwActive.length; i++) {
      const k = this.pwActive[i];
      if (!k) continue;
      const sp = this.map.powerupSpots[i];
      for (const p of this.net.players) {
        const me = p.id === this.net.myId;
        const pos = me ? this.body.pos : this.remotes.get(p.id)?.pos;
        const alive = me ? this.alive : (this.remotes.get(p.id)?.alive ?? false);
        if (!pos || !alive) continue;
        if (Math.hypot(pos.x - sp.x, pos.z - sp.z) < POWERUP_RADIUS && Math.abs(pos.y + 1 - sp.y) < 2) {
          this.applyPwTake(i, p.id, k);
          this.net.broadcast({ t: "pwtake", i, who: p.id, k });
          break;
        }
      }
    }
  }

  applyPwTake(i: number, who: string, k: PowerupKind): void {
    this.pwActive[i] = null;
    if (this.pwEntities[i]) this.pwEntities[i].isActive = false;
    if (who === this.net.myId) this.applyBuff(k);
  }

  applyBuff(k: PowerupKind): void {
    this.buff = { kind: k, until: performance.now() / 1000 + POWERUPS[k].duration };
    this.dmgMult = k === "quad" ? QUAD_MULT : 1;
    this.ws.fireRateMult = k === "rapid" ? RAPID_MULT : 1;
    sfx.pickup();
    this.hud.banner(`${POWERUPS[k].name}!`, 1500);
  }

  clearBuff(): void {
    if (!this.buff) return;
    this.buff = null;
    this.dmgMult = 1;
    this.ws.fireRateMult = 1;
    this.hud.buff(null, 0, 0);
  }

  // ─── net wiring ─────────────────────────────────────────────────────────────

  wireNet(): void {
    const n = this.net;

    n.onHello = (id, name): Msg => {
      this.names.set(id, name);
      this.ensureRemote(id, name);
      this.hpMap[id] = MAX_HP;
      this.scores[id] = this.scores[id] ?? { k: 0, d: 0 };
      this.assignLateJoiner(id);
      // late joiner mid-game → spawn them
      if (this.phase === "play") window.setTimeout(() => this.hostSpawn(id), 400);
      this.refreshLobby();
      return { t: "init", id, players: n.players, game: this.gameSnap() };
    };

    n.onPeerJoin = (p) => {
      this.names.set(p.id, p.name);
      this.ensureRemote(p.id, p.name);
      this.refreshLobby();
      this.hud.banner(`${p.name} joined`);
    };

    n.onPeerLeave = (id) => {
      const r = this.remotes.get(id);
      if (r) { r.entity.destroy(); this.remotes.delete(id); }
      delete this.hpMap[id];
      delete this.platforms[id];
      this.voice.drop(id);
      this.refreshLobby();
    };

    n.onError = (err) => {
      this.hud.connecting(false);
      const established = this.net.players.length > 0; // we already received the host's init
      const lost = err.includes("Lost connection") || err.includes("Connection failed");
      if (!this.net.isHost && established && lost) {
        // host gone → the lobby/match is over for this client; return home
        this.inGame = false;
        this.leaving = true;
        this.exitLobby();
        document.exitPointerLock();
        this.hud.menuError("Host left — lobby closed.");
        this.hud.show("menu");
        window.setTimeout(() => location.reload(), 1200);
      } else if (!this.inGame && this.phase === "lobby") {
        this.hud.menuError(
          err.includes("Could not connect") || err.includes("peer-unavailable") || err.includes("Connection failed")
            ? "Lobby not found." : err,
        );
        this.hud.show("menu");
      } else {
        this.hud.banner("Connection lost");
      }
    };

    n.onMessage = (m, fromId) => this.handleMsg(m, fromId);
  }

  ensureRemote(id: string, name: string): RemotePlayer {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemotePlayer(this.engine, this.engine.sceneManager.activeScene.getRootEntity()!, id, name, this.net.colorOf(id), this.models);
      this.remotes.set(id, r);
    }
    return r;
  }

  handleMsg(m: Msg, fromId: string): void {
    switch (m.t) {
      case "init": {
        this.net.myId = m.id;
        this.net.players = m.players;
        for (const p of m.players) {
          this.names.set(p.id, p.name);
          if (p.id !== m.id) this.ensureRemote(p.id, p.name);
        }
        this.applyGame(m.game);
        this.refreshLobby();
        if (m.game.phase === "play" || m.game.phase === "inter") this.enterGame();
        else { this.hud.show("lobby"); this.enterLobby(); }
        this.hud.connecting(false);
        this.announcePlatform(); // tell the host (→ everyone) our current input device
        this.startVoice();
        break;
      }
      case "pjoin": {
        if (!this.net.isHost) {
          this.net.players.push(m.p);
          this.names.set(m.p.id, m.p.name);
          this.ensureRemote(m.p.id, m.p.name);
          this.refreshLobby();
          this.hud.banner(`${m.p.name} joined`);
        }
        break;
      }
      case "pleave": {
        this.net.players = this.net.players.filter((p) => p.id !== m.id);
        const r = this.remotes.get(m.id);
        if (r) { r.entity.destroy(); this.remotes.delete(m.id); }
        delete this.platforms[m.id];
        this.voice.drop(m.id);
        this.refreshLobby();
        break;
      }
      case "state": {
        // host receives guest state
        if (this.net.isHost) {
          const r = this.remotes.get(fromId);
          if (r) r.push({ ...m.s, hp: this.hpMap[fromId] ?? 100 }, performance.now() / 1000);
        }
        break;
      }
      case "snap": {
        if (!this.net.isHost) {
          const now = performance.now() / 1000;
          for (const s of m.ps) {
            if (s.id === this.net.myId) continue;
            const r = this.ensureRemote(s.id, this.names.get(s.id) ?? "player");
            r.push(s, now);
            r.alive = s.hp > 0;
          }
        }
        break;
      }
      case "shot": {
        const r = this.remotes.get(m.id);
        const o: Vec3 = { x: m.o[0], y: m.o[1], z: m.o[2] };
        const d: Vec3 = { x: m.d[0], y: m.d[1], z: m.d[2] };
        const from = r ? r.gunMuzzle() : o;
        const def = WEAPONS[m.w];
        const wallHit = this.map.raycast(o, d, def.range);
        const dist = wallHit ? wallHit.dist : Math.min(def.range, 120);
        if (!def.melee) this.tracers.spawn(from, { x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist });
        const rel = this.relAudio(o);
        sfx.shot(m.w, rel.pan, rel.dist);
        if (this.net.isHost) this.net.broadcast(m, fromId); // relay
        break;
      }
      case "hit": {
        if (this.net.isHost) this.hostApplyHit(fromId, m.v, m.dmg, m.hs === 1, m.w);
        break;
      }
      case "dmg": case "kill": case "spawn": {
        this.applyLocal(m);
        if (this.net.isHost) this.net.broadcast(m); // (host never receives these; guests get from host)
        break;
      }
      case "game": {
        this.applyGame(m.g);
        break;
      }
      case "start": {
        this.enterGame();
        break;
      }
      case "nade": {
        this.nades.throw_(m.k, { x: m.o[0], y: m.o[1], z: m.o[2] }, { x: m.v[0], y: m.v[1], z: m.v[2] }, m.id, false);
        sfx.nadeThrow();
        if (this.net.isHost) this.net.broadcast(m, fromId);
        break;
      }
      case "chat": {
        const from = this.net.isHost ? fromId : m.id;
        this.hud.chatMsg(this.names.get(from) ?? "?", this.net.colorOf(from), m.txt);
        if (this.net.isHost) {
          this.net.broadcast({ t: "chat", id: from, txt: m.txt }, fromId);
          this.npcOnChat(from, m.txt); // a guest spoke → maybe bots answer
        }
        break;
      }
      case "heal": {
        this.applyLocal(m);
        break;
      }
      case "pkup": {
        if (!this.net.isHost && this.pkEntities[m.i]) this.pkEntities[m.i].isActive = false;
        break;
      }
      case "bhit": {
        if (this.net.isHost) this.hostBarrelHit(m.i, m.dmg);
        break;
      }
      case "bexp": {
        const b = this.map.killBarrel(m.i);
        if (b) this.spawnBarrelFx(b.pos);
        break;
      }
      case "pwspawn": {
        if (!this.net.isHost) this.applyPwSpawn(m.i, m.k);
        break;
      }
      case "pwtake": {
        this.applyPwTake(m.i, m.who, m.k);
        break;
      }
      case "mapvote": {
        if (this.net.isHost) { this.mapVotes[fromId] = m.map; this.broadcastVotes(); }
        break;
      }
      case "votes": {
        this.lastVoteCounts = m.counts;
        this.hud.voteCounts(m.counts, this.myVote);
        break;
      }
      case "mode": {
        // host → all: lobby mode selection changed
        this.mode = m.mode;
        this.refreshLobby();
        break;
      }
      case "cfg": {
        // host → all: lobby match-rules changed
        this.cfg = m.cfg;
        this.applyPhysicsConfig();
        this.refreshLobby();
        break;
      }
      case "role": {
        // host → me: prop-hunt role for this round
        this.myRole = m.role;
        this.teams[this.net.myId] = m.role;
        if (this.inGame && this.alive) this.applyLoadout();
        break;
      }
      case "tier": {
        // host → me: gungame tier changed
        this.tiers[this.net.myId] = m.tier;
        if (this.inGame && this.mode === "gungame") this.applyTier(m.tier);
        break;
      }
      case "plat": {
        // a player switched input device (mouse ↔ gamepad ↔ touch). Record it and, on
        // the host, relay to the other guests so everyone's list icons stay in sync.
        this.platforms[m.id] = m.plat;
        if (this.net.isHost) this.net.broadcast(m, fromId);
        if (this.phase === "lobby" && !this.inGame) this.refreshLobby();
        break;
      }
      case "ping": {
        if (this.net.isHost) this.net.sendTo(fromId, { t: "pong", ts: m.ts });
        break;
      }
      case "pong": {
        this.ping = performance.now() - m.ts;
        break;
      }
      case "hello": break;
    }
  }

  /** apply dmg/kill/spawn effects locally (both host + guests) */
  applyLocal(m: Msg): void {
    if (m.t === "heal") {
      if (m.v === this.net.myId) {
        this.myHp = m.hp;
        this.hud.hp(this.myHp);
        sfx.pickup();
      } else {
        const r = this.remotes.get(m.v);
        if (r) r.hp = m.hp;
      }
      return;
    }
    if (m.t === "dmg") {
      if (m.v === this.net.myId) {
        this.myHp = m.hp;
        this.hud.hp(this.myHp);
        this.hud.damageFlash();
        const rel = this.relAudio({ x: m.from[0], y: m.from[1], z: m.from[2] });
        sfx.hurt(rel.pan);
      } else {
        const r = this.remotes.get(m.v);
        if (r) r.hp = m.hp;
      }
    } else if (m.t === "kill") {
      this.hud.kill(this.names.get(m.k) ?? "?", this.names.get(m.v) ?? "?", m.w, m.hs === 1);
      if (m.v === this.net.myId) {
        this.alive = false;
        this.lastWeapon = this.ws.current; // remember it so respawn re-equips the same gun
        this.selfOperator?.markDead(m.hs === 1); // pick the death variant before syncDeath
        this.respawnAt = performance.now() / 1000 + MODES[this.mode].respawn;
        sfx.death(); // clear cue, before the death cam muffles the bus
        this.startDeathCam();
        this.hud.crosshair(false);
        this.ws.setScope(false);
        this.applyScopeFov();
        this.clearBuff();
      } else {
        const r = this.remotes.get(m.v);
        if (r) { r.markDead(m.hs === 1); r.alive = false; }
      }
    } else if (m.t === "spawn") {
      if (m.id === this.net.myId) {
        this.alive = true;
        this.myHp = MAX_HP;
        this.body.teleport({ x: m.p[0], y: m.p[1], z: m.p[2] }, m.yaw);
        this.ws.ammo.usp = { mag: 12, reserve: 48 };
        this.ws.ammo.ak47 = { mag: 30, reserve: 90 };
        this.ws.ammo.awp = { mag: 5, reserve: 15 };
        this.ws.ammo.he = { mag: 2, reserve: -1 };
        this.ws.ammo.mol = { mag: 1, reserve: -1 };
        this.applyLoadout(); // mode-aware weapon (gungame tier / prophunt disguise)
        this.applyScopeFov();
        this.endDeathCam();
        this.spectateId = null;
        this.hud.spectate(null);
        this.hud.hp(this.myHp);
        this.hud.respawnOverlay(null);
        this.hud.crosshair(true);
        this.refreshAmmoHud();
      } else {
        const r = this.remotes.get(m.id);
        if (r) { r.alive = true; r.hp = MAX_HP; }
      }
    }
  }

  // ─── HUD wiring ─────────────────────────────────────────────────────────────

  wireHud(): void {
    this.hud.onCreate = (name) => {
      sfx.unlock();
      this.hud.connecting(true);
      this.names.set("host", name);
      this.net.onReady = () => {
        this.hud.connecting(false);
        this.scores["host"] = { k: 0, d: 0 };
        this.hpMap["host"] = MAX_HP;
        this.platforms["host"] = this.myPlatform; // seed our own list icon
        this.refreshLobby();
        this.hud.show("lobby");
        this.enterLobby();
        this.startVoice();
      };
      this.net.host(name);
    };

    this.hud.onJoin = (code, name) => {
      sfx.unlock();
      this.hud.connecting(true);
      this.net.join(code, name);
      // init message will drive the rest
    };

    this.hud.onStart = () => {
      if (!this.net.isHost) return;
      this.addBots(this.cfg.bots);
      this.net.broadcast({ t: "start" });
      this.enterGame();
      void this.hostStartRound(1);
    };

    this.hud.onChat = (txt) => {
      this.hud.chatMsg(this.names.get(this.net.myId) ?? "me", this.net.colorOf(this.net.myId), txt);
      const m: Msg = { t: "chat", id: this.net.myId, txt };
      if (this.net.isHost) { this.net.broadcast(m); this.npcOnChat(this.net.myId, txt); }
      else this.net.send(m);
    };

    this.hud.onPlayAgain = () => {
      if (!this.net.isHost) return;
      this.addBots(this.cfg.bots);
      for (const id of Object.keys(this.scores)) this.scores[id] = { k: 0, d: 0 };
      this.net.broadcast({ t: "start" });
      this.enterGame();
      void this.hostStartRound(1);
    };

    this.hud.onVote = (id) => this.castVote(id);
    this.hud.onMode = (id) => this.setMode(id);
    this.hud.onCfg = (patch) => this.setCfg(patch);
    this.hud.onHome = () => this.leaveToMenu();
  }

  /** host: change a match rule, mirror to guests, re-apply live physics */
  setCfg(patch: Partial<MatchConfig>): void {
    if (!this.net.isHost || this.phase !== "lobby") return;
    this.cfg = { ...this.cfg, ...patch };
    this.applyPhysicsConfig();
    this.net.broadcast({ t: "cfg", cfg: this.cfg });
    this.refreshLobby();
  }

  /** leave the current lobby/match and return to the home screen */
  leaveToMenu(): void {
    this.leaving = true; // suppress the beforeunload confirm for this intentional exit
    try { this.net.leave(); } catch { /* ignore */ }
    location.reload(); // cleanest full reset back to the menu
  }

  addBots(n: number): void {
    this.clearBots();
    const pool = ["Rook", "Vex", "Nyx", "Cael", "Bishop", "Dax", "Orin", "Zeph"];
    for (let i = 0; i < n; i++) {
      const id = "bot" + (i + 1);
      const name = pool[i % pool.length];
      const info = { id, name, color: this.net.pickColor(id) };
      this.names.set(id, name);
      this.net.players.push(info);
      this.scores[id] = { k: 0, d: 0 };
      this.hpMap[id] = MAX_HP;
      this.platforms[id] = "bot"; // AI opponents show a bot icon in lists / leaderboards
      this.ensureRemote(id, name);
      const body = new PlayerBody(this.map);
      body.gravityScale = this.cfg.gravity;
      body.teleport({ x: rand(-6, 6), y: 4, z: rand(-6, 6) }, rand(0, 360));
      const primary = pickBotWeapon();
      const arsenal = [...new Set<WeaponId>([primary, "usp", "knife"])]; // everyone keeps a sidearm + knife
      this.bots.set(id, {
        id, body, weapon: primary, arsenal, mag: WEAPONS[primary].mag, reloadCd: 0, switchCd: 0,
        fireCd: 0, burstCd: 0, retargetCd: 0, targetId: null, strafe: 1, strafeCd: 0,
        seen: false, reactCd: 0, memoryCd: 0, lastKnown: null,
        aimErrX: 0, aimErrY: 0, aimErrCd: 0, avoidCd: 0, avoidSign: 1, wanderYaw: body.yaw,
        lastHp: MAX_HP, dodgeLockCd: 0,
      });
      this.net.broadcast({ t: "pjoin", p: info }); // let guests see the bot
      this.net.broadcast({ t: "plat", id, plat: "bot" }); // …with a bot platform icon
    }
  }

  clearBots(): void {
    for (const b of this.bots.values()) {
      const r = this.remotes.get(b.id);
      if (r) { r.entity.destroy(); this.remotes.delete(b.id); }
      this.net.players = this.net.players.filter((p) => p.id !== b.id);
      delete this.scores[b.id];
      delete this.hpMap[b.id];
      delete this.platforms[b.id];
      this.net.broadcast({ t: "pleave", id: b.id });
    }
    this.bots.clear();
    this.npcDeaths = {};
    this.npcStreakK = {};
    this.npcRival = {};
    this.npcWeapon = {};
    this.npcBotCd = {};
    this.npcSpontaneousCd = 0;
    this.npcReplyCd = 0;
    this.npcLog = [];
  }

  /** absolute position of any combatant (local player or bot) */
  entityPos(id: string): Vec3 {
    if (id === this.net.myId) return this.body.pos;
    const bot = this.bots.get(id);
    if (bot) return bot.body.pos;
    return this.remotes.get(id)?.pos ?? { x: 0, y: 0, z: 0 };
  }

  botIsEnemy(a: string, b: string): boolean {
    if (a === b) return false;
    if (MODES[this.mode].teams) return this.teams[a] !== this.teams[b];
    return true;
  }

  botTargetAlive(id: string | null): boolean {
    if (!id) return false;
    if (id === this.net.myId) return this.alive;
    return (this.hpMap[id] ?? 0) > 0;
  }

  botPickTarget(bot: BotAI): string | null {
    let best: string | null = null, bd = Infinity;
    const consider = (id: string, p: Vec3): void => {
      if (!this.botIsEnemy(bot.id, id)) return;
      const d = Math.hypot(p.x - bot.body.pos.x, p.z - bot.body.pos.z);
      if (d < bd) { bd = d; best = id; }
    };
    if (this.alive) consider(this.net.myId, this.body.pos);
    for (const other of this.bots.values()) {
      if (other.id === bot.id || (this.hpMap[other.id] ?? 0) <= 0) continue;
      consider(other.id, other.body.pos);
    }
    for (const r of this.remotes.values()) {
      if (this.bots.has(r.id) || (this.hpMap[r.id] ?? 0) <= 0) continue;
      consider(r.id, r.pos); // human guests are targets too
    }
    return best;
  }

  /** the weapon a bot is currently fighting with (gungame ladder, else its live loadout). */
  botWeapon(bot: BotAI): WeaponId {
    return this.mode === "gungame" ? tierWeapon(this.tiers[bot.id] ?? 0) : bot.weapon;
  }

  /** swap a bot to a weapon from its arsenal: loads a fresh mag and adds a short draw delay. */
  botEquip(bot: BotAI, w: WeaponId): void {
    if (bot.weapon === w) return;
    bot.weapon = w;
    bot.mag = WEAPONS[w].melee ? -1 : WEAPONS[w].mag;
    bot.reloadCd = 0;
    bot.fireCd = Math.max(bot.fireCd, 0.35); // can't fire the instant it's drawn
  }

  /** which owned weapon best fits the current range — the AWP holds long, the pistol/knife
   *  take over when a fight collapses to close quarters, the rifle covers the middle. The
   *  held weapon gets a bonus so bots don't flip-flop at band edges. */
  botIdealWeapon(bot: BotAI, dist: number): WeaponId {
    let best = bot.weapon, bestScore = -Infinity;
    for (const w of bot.arsenal) {
      const d = WEAPONS[w];
      let sc = d.melee ? (dist < 2.5 ? 3.5 : -1)
        : d.scope ? (dist > 22 ? 5 : dist < 10 ? 0.4 : 2)   // AWP: lethal far, clumsy close
        : d.auto ? (dist < 40 ? 4 : 2.5)                    // rifle: strong all-round
        : (dist < 18 ? 3.4 : 1.6);                          // pistol: fine close/mid
      if (w === bot.weapon) sc += 0.8;                      // hysteresis
      if (sc > bestScore) { bestScore = sc; best = w; }
    }
    return best;
  }

  /** does the bot actually perceive `pos` right now? Frontal vision cone (fov) + line of
   *  sight — the two things that stop a bot from tracking you through a wall or from behind.
   *  Point-blank (≤6m) it's aware regardless of facing (footsteps / peripheral). */
  botCanSee(bot: BotAI, pos: Vec3, eye: Vec3): boolean {
    const tune = BOT_TUNING[this.cfg.difficulty];
    const dx = pos.x - eye.x, dy = (pos.y + 1.0) - eye.y, dz = pos.z - eye.z;
    const flat = Math.hypot(dx, dz) || 1e-3;
    const dist = Math.hypot(dx, dy, dz) || 1;
    if (flat > 6) {
      const fx = -Math.sin(bot.body.yaw), fz = -Math.cos(bot.body.yaw);
      if ((dx * fx + dz * fz) / flat < Math.cos(tune.fov)) return false; // outside FOV cone
    }
    // clear LOS if nothing solid sits between the eye and (just short of) the target
    return !this.map.raycast(eye, { x: dx / dist, y: dy / dist, z: dz / dist }, dist - 0.5);
  }

  /** whisker obstacle-avoidance: given a desired world move dir, steer it around walls so
   *  bots peel past corners instead of grinding into them. Commits to a side briefly to
   *  avoid jitter. Returns a world-space move vector (aim is handled separately). */
  botSteer(bot: BotAI, wx: number, wz: number): { x: number; z: number; blocked: boolean; open: boolean } {
    const len = Math.hypot(wx, wz);
    if (len < 1e-3) return { x: 0, z: 0, blocked: false, open: false };
    const nx = wx / len, nz = wz / len;
    const o: Vec3 = { x: bot.body.pos.x, y: bot.body.pos.y + 0.9, z: bot.body.pos.z };
    const R = 2.8; // look-ahead: start bending early so it's a gentle curve, not a last-moment jerk
    const clear = (ax: number, az: number): number =>
      this.map.raycast(o, { x: ax, y: 0, z: az }, R)?.dist ?? R;
    const ahead = clear(nx, nz);
    if (ahead >= R - 0.05) return { x: wx, z: wz, blocked: false, open: true }; // open road
    const rot = (a: number): { x: number; z: number } => {
      const cs = Math.cos(a), sn = Math.sin(a);
      return { x: nx * cs - nz * sn, z: nx * sn + nz * cs };
    };
    if (bot.avoidCd <= 0) { // pick the side with more room, then commit to it briefly (no jitter)
      const l = rot(0.6), rr = rot(-0.6);
      bot.avoidSign = clear(l.x, l.z) >= clear(rr.x, rr.z) ? 1 : -1;
      bot.avoidCd = 0.4;
    }
    // bend proportional to how close the wall is: barely at range R, hard up close
    const near = 1 - ahead / R; // 0..1
    const s = rot((0.2 + 1.0 * near) * bot.avoidSign);
    return { x: s.x * len, z: s.z * len, blocked: ahead < 1.1, open: false };
  }

  /** drive every bot: perceive, aim (capped slew), move (obstacle-aware), shoot. Host only. */
  updateBots(dt: number, _now: number): void {
    const tune = BOT_TUNING[this.cfg.difficulty];
    for (const bot of this.bots.values()) {
      const r = this.remotes.get(bot.id);
      if (!r) continue;
      r.weapon = this.botWeapon(bot); // keep the visible held gun in sync with contextual swaps
      if ((this.hpMap[bot.id] ?? 0) <= 0) {
        // dead bot: keep stepping gravity (no input) so a body killed mid-air falls to the
        // ground and plays its death prone, instead of freezing where it was hit.
        bot.body.update(dt, { fwd: 0, right: 0, jump: false, sprint: false }, 0);
        r.setPose(bot.body.pos, bot.body.yaw, false, bot.body.onGround);
        continue;
      }

      const role = this.teams[bot.id];
      const isHider = this.mode === "prophunt" && role === ROLE_HIDE;
      const frozen = this.mode === "prophunt" && role === ROLE_SEEK && this.inPrepPhase();
      const playing = this.phase === "play" && !frozen;

      bot.avoidCd -= dt; bot.reactCd -= dt; bot.burstCd -= dt; bot.fireCd -= dt;
      bot.reloadCd -= dt; bot.switchCd -= dt;
      // finished reloading → top the mag back up
      if (bot.reloadCd < 0 && bot.mag <= 0 && !WEAPONS[bot.weapon].melee) bot.mag = WEAPONS[bot.weapon].mag;

      bot.retargetCd -= dt;
      if (bot.retargetCd <= 0 || !this.botTargetAlive(bot.targetId)) {
        bot.targetId = isHider ? null : this.botPickTarget(bot);
        bot.retargetCd = 0.8 + Math.random() * 0.8;
      }
      const tgt = bot.targetId ? this.entityPos(bot.targetId) : null;
      const eye: Vec3 = { x: bot.body.pos.x, y: bot.body.eyeY, z: bot.body.pos.z };

      // ── perception: real sight → refresh memory; lost sight → hunt last-known, then forget ──
      const canSee = !!tgt && !isHider && this.botCanSee(bot, tgt, eye);
      if (canSee && tgt) {
        if (!bot.seen) bot.reactCd = tune.react * (0.7 + Math.random() * 0.6); // just spotted → react before firing
        bot.seen = true;
        bot.lastKnown = { x: tgt.x, y: tgt.y, z: tgt.z };
        bot.memoryCd = tune.memory;
      } else {
        bot.seen = false;
        if (bot.memoryCd > 0) bot.memoryCd -= dt; else bot.lastKnown = null;
      }
      const aimAt = bot.seen ? tgt : bot.lastKnown; // what the bot *believes* — not omniscient

      // aim wobble drifts on its own timer so tracking never locks pixel-perfect
      bot.aimErrCd -= dt;
      if (bot.aimErrCd <= 0) {
        bot.aimErrX = (Math.random() * 2 - 1) * tune.err;
        bot.aimErrY = (Math.random() * 2 - 1) * tune.err * 0.6;
        bot.aimErrCd = 0.18 + Math.random() * 0.35;
      }

      // took damage since last frame? → juke *sideways* (flip strafe), never a hop. Throttled so
      // it's an occasional direction change under fire, not a twitch every tick.
      const hp = this.hpMap[bot.id] ?? 0;
      if (hp < bot.lastHp && hp > 0 && bot.dodgeLockCd <= 0) {
        bot.dodgeLockCd = 0.9 + Math.random() * 0.6;
        bot.strafe = -bot.strafe;
      }
      bot.lastHp = hp;
      bot.dodgeLockCd -= dt;

      // ── build the desired world-space move, and (when fighting) the true aim heading ──
      let wishX = 0, wishZ = 0, rushing = false, sprint = false;
      let aimYaw: number | null = null, aimPitch = 0, trueYaw = 0, dist = 0;

      if (aimAt) {
        const dx = aimAt.x - bot.body.pos.x, dz = aimAt.z - bot.body.pos.z;
        dist = Math.hypot(dx, dz) || 1e-3;
        trueYaw = Math.atan2(-dx, -dz);
        // context switch: pick the right tool for this range (AWP → pistol/knife when a fight
        // collapses close, rifle for the mid, AWP when far). Not in gungame, not mid-reload.
        if (this.mode !== "gungame" && bot.switchCd <= 0 && bot.reloadCd <= 0) {
          const ideal = this.botIdealWeapon(bot, dist);
          if (ideal !== bot.weapon) { this.botEquip(bot, ideal); bot.switchCd = 1.6; }
        }
        // footwork keyed to the weapon's ideal range: AWP keeps distance, knife rushes, etc.
        const def = WEAPONS[this.botWeapon(bot)];
        const near = def.melee ? 0 : def.scope ? 16 : def.auto ? 6 : 4;
        const far = def.melee ? 99 : def.scope ? 30 : def.auto ? 16 : 11;
        const along = def.melee ? 1 : dist > far ? 1 : dist < near ? -0.7 : 0.12;
        rushing = along > 0.6; // closing a lot of ground → OK to bhop
        const nfx = dx / dist, nfz = dz / dist; // unit dir bot→enemy (world)
        bot.strafeCd -= dt;
        if (bot.strafeCd <= 0) { bot.strafe = Math.random() < 0.5 ? -1 : 1; bot.strafeCd = 0.5 + Math.random(); }
        const strafe = (bot.seen ? 0.85 : 0.25) * bot.strafe; // only juke hard when actually in a fight
        wishX = nfx * along + -nfz * strafe;  // forward + perpendicular strafe
        wishZ = nfz * along + nfx * strafe;
        sprint = rushing && !def.scope;
        if (bot.seen) { aimYaw = trueYaw + bot.aimErrX; aimPitch = clamp(Math.atan2((aimAt.y + 1.0) - eye.y, Math.max(0.5, dist)) + bot.aimErrY, -1.2, 1.2); }
      } else {
        // nothing believed in view → patrol a slowly-drifting heading
        bot.strafeCd -= dt;
        if (bot.strafeCd <= 0) { bot.wanderYaw += (Math.random() - 0.5) * 1.2; bot.strafeCd = 1.5 + Math.random() * 2.5; }
        wishX = -Math.sin(bot.wanderYaw);
        wishZ = -Math.cos(bot.wanderYaw);
      }

      // steer the movement gently around walls *before* aiming, so the head can follow travel
      const steer = this.botSteer(bot, wishX, wishZ);
      const travelLen = Math.hypot(steer.x, steer.z);
      const travelYaw = travelLen > 1e-3 ? Math.atan2(-steer.x, -steer.z) : bot.body.yaw;

      // aim: lock onto a seen enemy, otherwise look where you're actually walking (never into a wall)
      let desYaw: number, desPitch: number, slewScale: number;
      if (bot.seen && aimYaw !== null) {
        desYaw = aimYaw; desPitch = aimPitch; slewScale = bot.reactCd > 0 ? 0.35 : 1;
      } else {
        desYaw = travelYaw + bot.aimErrX * 0.4; desPitch = bot.body.pitch * 0.85; slewScale = 0.85;
        if (!aimAt) bot.wanderYaw = approachAngle(bot.wanderYaw, travelYaw, 3 * dt); // curve the whim heading along corridors
      }
      const slew = tune.turn * slewScale * dt;
      bot.body.yaw = approachAngle(bot.body.yaw, desYaw, slew);
      bot.body.pitch = clamp(bot.body.pitch + clamp(desPitch - bot.body.pitch, -slew, slew), -1.2, 1.2);

      // fire only with real sight, after the reaction delay, not while reloading, aim settled
      if (playing && bot.seen && tgt && bot.reactCd <= 0 && bot.reloadCd <= 0 && bot.burstCd <= 0 && bot.fireCd <= 0) {
        if (Math.abs(normAngle(bot.body.yaw - trueYaw)) < 0.13) this.botTryShoot(bot, tgt, dist, eye);
      }

      // ── jump ONLY to bunny-hop a long, clear sprint — never in a fight, never near a wall ──
      // Long trek toward the target + fully open lane ahead + already at running speed. Everything
      // else (close combat, holding, standing, dodging) stays grounded so hops read as intentional.
      const spd = Math.hypot(bot.body.vel.x, bot.body.vel.z);
      const maxSpd = MOVE.groundSpeed * this.cfg.speed;
      const jump = playing && bot.body.onGround && rushing && sprint
        && dist > 22 && steer.open && spd > maxSpd * 0.8;

      // map the (steered) world move into the body's yaw frame — aim and travel stay independent
      const s = Math.sin(bot.body.yaw), c = Math.cos(bot.body.yaw);
      const fwd = -s * steer.x - c * steer.z;
      const right = c * steer.x - s * steer.z;

      const input: Input = playing
        ? { fwd, right, jump, sprint }
        : { fwd: 0, right: 0, jump: false, sprint: false };
      bot.body.update(dt, input, this.cfg.speed);
      r.setPose(bot.body.pos, bot.body.yaw, true, bot.body.onGround);
    }
  }

  botTryShoot(bot: BotAI, tgt: Vec3, dist: number, eye: Vec3): void {
    if (bot.reloadCd > 0) return; // mid-reload — can't shoot
    const tune = BOT_TUNING[this.cfg.difficulty];
    const wid = this.botWeapon(bot);
    const def = WEAPONS[wid];
    if (def.melee) { // knife — only up close
      if (dist < 2.2) this.botDealDamage(bot, def, wid, false);
      bot.fireCd = 0.85 * tune.rate;
      return;
    }
    // fire along where the bot is *actually* looking — with wobble, tracers can miss like a human
    const dir = bot.body.aimDir();
    const wall = this.map.raycast(eye, dir, def.range);
    const reach = Math.min(wall?.dist ?? def.range, def.range);
    this.net.broadcast({ t: "shot", id: bot.id, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], w: wid });
    this.tracers.spawn(
      { x: eye.x + dir.x * 0.6, y: eye.y - 0.1, z: eye.z + dir.z * 0.6 },
      { x: eye.x + dir.x * reach, y: eye.y + dir.y * reach, z: eye.z + dir.z * reach },
    );
    const rel = this.relAudio(eye);
    sfx.shot(wid, rel.pan, rel.dist);
    // hit resolution: needs a clear line to the target, then a difficulty/range/weapon roll
    const tx = tgt.x - eye.x, ty = (tgt.y + 1.0) - eye.y, tz = tgt.z - eye.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    const blocked = this.map.raycast(eye, { x: tx / len, y: ty / len, z: tz / len }, len - 0.5);
    const moving = Math.hypot(bot.body.vel.x, bot.body.vel.z) > 3;
    const wf = (def.scope ? 0.72 : def.auto ? 1 : 0.9) * (moving ? 0.7 : 1); // scoped/moving is harder
    const pHit = clamp((tune.aim - dist / 70) * wf, 0.05, tune.aim);
    if (!blocked && Math.random() < pHit) this.botDealDamage(bot, def, wid, Math.random() < 0.12 * tune.aim / 0.72);
    // cadence from the real weapon; autos spray in bursts with a breather between
    if (def.auto) {
      bot.fireCd = (60 / def.rpm) * tune.rate * (0.9 + Math.random() * 0.4);
      if (Math.random() < 0.16) bot.burstCd = 0.35 + Math.random() * 0.5;
    } else {
      bot.fireCd = Math.max(0.5, 60 / def.rpm) * tune.rate * (0.85 + Math.random() * 0.5);
    }
    // ammo bookkeeping (non-gungame): spend a round, then reload — or, if the enemy is close,
    // swap to a loaded sidearm instead of eating the reload time.
    if (this.mode !== "gungame") {
      bot.mag--;
      if (bot.mag <= 0) {
        if (dist < 12) {
          const alt = bot.arsenal.find((w) => w !== wid && !WEAPONS[w].melee && !WEAPONS[w].scope);
          if (alt) { this.botEquip(bot, alt); return; }
        }
        bot.reloadCd = def.reloadTime;
      }
    }
  }

  botDealDamage(bot: BotAI, def: WeaponDef, wid: WeaponId, hs: boolean): void {
    if (!bot.targetId) return;
    let dmg = def.damage * 0.5 * BOT_TUNING[this.cfg.difficulty].dmg;
    if (hs) dmg *= def.headMult;
    this.hostApplyHit(bot.id, bot.targetId, Math.max(1, Math.round(dmg)), hs, wid);
  }

  /** host: slot a mid-match joiner into the active mode */
  assignLateJoiner(id: string): void {
    if (this.mode === "tdm") {
      let a = 0, b = 0;
      for (const p of this.net.players) {
        if (p.id === id) continue;
        if (this.teams[p.id] === 1) b++; else if (this.teams[p.id] === 0) a++;
      }
      this.teams[id] = a <= b ? 0 : 1; // fill the smaller side
    } else if (this.mode === "prophunt") {
      this.teams[id] = ROLE_SEEK; // mid-round joiners hunt
    } else if (this.mode === "gungame") {
      this.tiers[id] = this.tiers[id] ?? 0;
    }
  }

  /** host: change the lobby's game mode and tell everyone */
  setMode(id: ModeId): void {
    if (!this.net.isHost || this.phase !== "lobby") return;
    this.mode = id;
    this.net.broadcast({ t: "mode", mode: id });
    this.refreshLobby();
  }

  refreshLobby(): void {
    this.hud.lobby(this.net.lobbyCode, this.net.players, this.net.isHost, this.mode, this.cfg, this.net.myId, this.platforms);
    this.hud.setOffline(this.net.offline);
    this.refreshLobbyAvatars();
  }

  // ─── 3D lobby ─────────────────────────────────────────────────────────────────

  /** main menu: same 3D showcase as the lobby (swaying camera + one idling operator
   *  on the stage) so create/join sits over the same scene, not a flat gradient. */
  enterMenu(): void {
    this.exitLobby();
    this.menuView = true;
    this.ws.showViewmodel(false);
    if (this.selfAvatar) this.selfAvatar.isActive = false;
    if (this.selfOperator) this.selfOperator.entity.isActive = false;
    if (!this.menuAvatar && this.lobbyStageRoot) {
      // stand the operator off-centre-right so the menu panel (left) doesn't cover it
      const x = 1.8, z = -6;
      const e = this.buildAvatar(this.lobbyStageRoot, 0);
      e.transform.setPosition(x, this.map.floorY(x, z) + 0.05, z);
      e.transform.setRotation(0, 0, 0);
      this.menuAvatar = e;
    }
  }

  exitMenu(): void {
    this.menuView = false;
    if (this.menuAvatar) { this.menuAvatar.destroy(); this.menuAvatar = null; }
  }

  /** keep the browser tab title in sync with the current context — always prefixed
   *  "SlopWars", with a pretty subtitle for the screen / gamemode + round. Called each
   *  frame; only writes document.title when it actually changed. */
  private lastTitle = "";
  private syncTitle(): void {
    let sub: string;
    if (this.inGame) {
      sub = `${MODES[this.mode].name} [${this.round}/${this.cfg.rounds}]`;
    } else {
      switch (document.body.dataset.screen) {
        case "loading": sub = "Loading…"; break;
        case "lobby":   sub = `Lobby [${this.net.players.length}]`; break;
        default:        sub = "Menu"; break; // main menu / end screen
      }
    }
    const title = `SlopWars · ${sub}`;
    if (title !== this.lastTitle) { this.lastTitle = title; document.title = title; }
  }

  enterLobby(): void {
    this.exitMenu();
    this.lobbyView = true;
    this.ws.showViewmodel(false);
    if (this.selfAvatar) this.selfAvatar.isActive = false;
    if (this.selfOperator) this.selfOperator.entity.isActive = false;
    document.body.classList.remove("hider");
    this.refreshLobbyAvatars();
  }

  exitLobby(): void {
    this.lobbyView = false;
    for (const e of this.lobbyAvatars.values()) e.destroy();
    this.lobbyAvatars.clear();
    this.lobbyAvatarSig = "";
  }

  /** rebuild the row of player avatars standing on the lobby stage. Skips the
   *  (now-heavy, skinned) rebuild when the player set is unchanged — refreshLobby
   *  fires on every match-rule edit too, and those don't touch the roster. */
  refreshLobbyAvatars(): void {
    if (!this.lobbyStageRoot) return;
    const players = this.net.players;
    const sig = players.map((p) => `${p.id}:${p.color}`).join(",");
    if (sig === this.lobbyAvatarSig && this.lobbyAvatars.size === players.length) return;
    this.lobbyAvatarSig = sig;
    for (const e of this.lobbyAvatars.values()) e.destroy();
    this.lobbyAvatars.clear();
    const n = players.length;
    players.forEach((p, i) => {
      const x = (i - (n - 1) / 2) * 1.3;
      const z = -6;
      const e = this.buildAvatar(this.lobbyStageRoot, p.color);
      e.transform.setPosition(x, this.map.floorY(x, z) + 0.05, z);
      e.transform.setRotation(0, 0, 0); // the rigged operator already faces the camera (+Z)
      this.lobbyAvatars.set(p.id, e);
    });
  }

  /** lobby showcase avatar: the rigged operator model, idling. Shows its own
   *  standard textures (no team tint — it read badly on the dark kit, matching the
   *  in-match avatar). Returns an empty holder if the character model never loaded. */
  buildAvatar(parent: Entity, _color: number): Entity {
    const root = parent.createChild("avatar");
    const char = instantiate(this.models["operator"]);
    if (!char) return root;
    root.addChild(char);
    // the lobby stage holds only a handful of static, on-screen avatars, so — unlike
    // the in-match crowd (shadows off for perf) — they can afford to cast shadows.
    for (const r of char.getComponentsIncludeChildren(SkinnedMeshRenderer, [])) r.castShadows = true;
    for (const r of char.getComponentsIncludeChildren(MeshRenderer, [])) r.castShadows = true;
    // idle so the avatar isn't a frozen T-pose
    const anim = char.getComponentsIncludeChildren(Animator, [])[0] ?? char.getComponent(Animator);
    if (anim?.findAnimatorState("Idle")) anim.play("Idle");
    return root;
  }

  /** gentle swaying camera looking at the avatar line */
  updateLobbyCamera(now: number): void {
    const sway = Math.sin(now * 0.4) * 1.6;
    this.camEntity.transform.setPosition(sway, 2.8, 2.0);
    this.camEntity.transform.lookAt(this.lobbyTarget, this.worldUp);
  }

  startVoice(): void {
    if (!this.net.peer) return;
    void this.voice.start(this.net.peer, (real) => this.net.pidOf(real)).then((ok) => {
      this.hud.voice(ok ? "on" : "off");
      if (!this.net.isHost) {
        // new joiner calls everyone already present
        for (const p of this.net.players) {
          if (p.id !== this.net.myId) this.voice.call(this.net.realId(p.id));
        }
      }
    });
  }

  enterGame(): void {
    this.inGame = true;
    this.alive = true;
    this.myHp = MAX_HP;
    this.exitMenu();
    this.exitLobby();
    this.ws.showViewmodel(true);
    sfx.stopTheme();
    sfx.stopInterlude();
    this.updateAmbientWater();
    this.hud.show("game");
    this.hud.hp(this.myHp);
    this.refreshAmmoHud();
    this.hud.crosshair(true);
    this.hud.clickToPlay(this.myPlatform === "keyboard");
    this.announcePlatform(); // let peers know our current input device on match entry
  }

  refreshAmmoHud(): void {
    const a = this.ws.ammo[this.ws.current];
    this.hud.ammo(this.ws.current, a.mag, a.reserve, this.ws.reloading > 0);
    this.touch.setWeapon(this.ws.current);
    this.touch.setAvailable(LOADOUT.map((id) => this.ws.available(id))); // drop spent throwables from the strip
  }
}

/** yaw (rad) of the horizontal bearing from `eye` to `p`, in the game's yaw convention
 *  (forward = (−sin yaw, −cos yaw)) — so it composes directly with body.yaw. */
function bearingYaw(eye: Vec3, p: Vec3): number {
  return Math.atan2(-(p.x - eye.x), -(p.z - eye.z));
}
/** pitch (rad) of the bearing from `eye` to `p` — matches body.pitch (aimDir.y = sin pitch). */
function bearingPitch(eye: Vec3, p: Vec3): number {
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return Math.asin(clamp(dy / len, -1, 1));
}

function falloff(def: WeaponDef, dist: number): number {
  const [fs, fe, fmin] = def.falloff;
  if (dist <= fs) return 1;
  if (dist >= fe) return fmin;
  return 1 - (1 - fmin) * ((dist - fs) / (fe - fs));
}

const game = new Game();
void game.start();
// dev-only handle for debugging in the console (stripped from production builds)
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
