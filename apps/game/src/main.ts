// ─── Bootstrap + game orchestration ──────────────────────────────────────────
import {
  AmbientLight, Animator, BackgroundMode, BlinnPhongMaterial, BloomEffect, Camera, Color,
  DirectLight, Engine, Entity, FogMode, MSAASamples, MeshRenderer, PostProcess,
  PrimitiveMesh, Quaternion, ShadowResolution, ShadowType, SkinnedMeshRenderer, SkyBoxMaterial,
  TextureCube, TonemappingEffect, TonemappingMode, UnlitMaterial, Vector3,
} from "@galacean/engine";
import { sfx } from "./audio";
import { loadHDRCube } from "./assets";
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
  BOT_TUNING, DEFAULT_CONFIG, GamePhase, GameSnapshot, INTERMISSION, MatchConfig, MAX_HP, ModeId, Msg,
  PICKUP_HEAL, PICKUP_RADIUS, PICKUP_RESPAWN, PlayerState, POWERUPS, POWERUP_INTERVAL,
  POWERUP_RADIUS, PowerupKind, QUAD_MULT, RAPID_MULT, SPEED_MULT, TICK_RATE,
  Vec3, WEAPONS, WeaponDef, WeaponId, DeathCause, LOADOUT, clamp, rand, randomPowerup,
} from "./types";
import {
  DEFAULT_MODE, GUNGAME_FINAL, MODES, PROPHUNT_PREP, ROLE_HIDE, ROLE_SEEK,
  TEAM_COLORS, TEAM_NAMES, seekerCount, tierWeapon,
} from "./modes";
import { Voice } from "./voice";
import { TouchControls } from "./touch";
import { Settings } from "./settings";
import { TracerPool, WeaponSystem } from "./weapons";

interface BotAI {
  id: string;
  body: PlayerBody;
  fireCd: number;
  retargetCd: number;
  targetId: string | null;
  strafe: number;
  strafeCd: number;
  jumpCd: number;
}

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
  tracers!: TracerPool;
  nades!: Projectiles;
  // dynamic-prop simulation — PhysX rigid bodies when available, else the custom
  // fallback. Starts as the fallback; init() swaps in PhysX after the engine is up.
  physics: PropSim = new PhysicsWorld(this.map);
  hud = new Hud();
  net = new Net();
  voice = new Voice();
  touch = new TouchControls();
  touchMode = false; // true once a touch input is seen (drives virtual controls)
  settings = new Settings();

  // ── AI opponents (host-driven; may coexist with human guests) ──
  bots = new Map<string, BotAI>();

  // ── host match rules (mirrored to guests) ──
  cfg: MatchConfig = { ...DEFAULT_CONFIG };
  leaving = false; // set during an intentional leave (suppresses the unload prompt)

  // third-person self avatar (a Prop-Hunt crate — the only third-person case)
  selfAvatar!: Entity;

  remotes = new Map<string, RemotePlayer>();
  names = new Map<string, string>();

  // 3D lobby scene
  lobbyView = false;
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
    const total = MODEL_LOAD_COUNT + 1; // models + first map's texture/sky bundle
    let loaded = 0;
    const bump = (name?: string): void => {
      this.hud.loadingProgress(++loaded / total);
      if (name) this.hud.loadingLabel(name);
    };
    this.models = await loadModels(engine, bump);

    // ── HDRI skybox material shell (its texture is set per-map by loadMap) ──
    const skyMat = new SkyBoxMaterial(engine);
    skyMat.textureDecodeRGBM = true;
    scene.background.sky.material = skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);
    amb.specularTextureDecodeRGBM = true;
    this.skyMat = skyMat;

    // ── map (resolves textures + sky, builds geometry/env/pickups) ──
    this.hud.loadingLabel("map & textures");
    await loadMapPool();                 // fetch maps/*.json into the registry
    await this.loadMap(DEFAULT_MAP);
    bump("ready");

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
    this.nades = new Projectiles(engine, root, this.map);
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

    this.hud.show("menu");
    // theme music starts on first user gesture (autoplay policy)
    window.addEventListener("pointerdown", () => {
      sfx.unlock();
      if (!this.inGame) sfx.startTheme();
    }, { once: true });

  }

  /** register the PWA service worker (installable / offline shell) in prod only */
  registerServiceWorker(): void {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  bindInput(): void {
    const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.keys.clear(); this.fireHeld = false; }
      if (this.inGame && !this.touchMode) {
        this.hud.clickToPlay(!this.locked);
        // Pressing Esc exits pointer lock *and* the browser swallows that Escape
        // keydown, so the pause menu can never open from the keydown handler while
        // locked. Open it here on any in-game unlock (Esc / alt-tab). Skipped while
        // leaving, or when it's already open.
        if (!this.locked && !this.leaving && !this.settings.isOpen()) this.openSettings();
      }
    });
    canvas.addEventListener("click", () => {
      if (this.touchMode) return; // touch mode drives look/fire without pointer lock
      if (this.inGame && !this.locked) canvas.requestPointerLock();
    });
    document.getElementById("click-to-play")!.addEventListener("click", () => {
      if (this.inGame && !this.locked && !this.touchMode) canvas.requestPointerLock();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.inGame) return;
      const sens = 0.0022 * this.settings.state.sensitivity * (this.ws.scoped ? 0.35 : 1);
      this.body.look(e.movementX, e.movementY, sens);
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.locked || !this.inGame || this.hud.chatOpen) return;
      if (e.button === 0) { this.fireHeld = true; this.triedFireQueued = true; }
      if (e.button === 2 && this.ws.def().scope && this.alive && !this.thirdPersonActive()) {
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
      if (e.code === "KeyR") this.ws.reload();
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

  /** true when the camera should sit behind the avatar. Only Prop-Hunt hiders
   *  (who are disguised props) play in third-person; everyone else is first. */
  thirdPersonActive(): boolean {
    return this.inGame && this.mode === "prophunt" && this.myRole === ROLE_HIDE;
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
    const third = this.thirdPersonActive();
    // hiders never show a first-person viewmodel; everyone else does (first-person)
    this.ws.showViewmodel(!third);

    if (!third || !this.alive) {
      // first person: camera at the eye, avatar hidden
      this.camEntity.transform.setPosition(this.body.pos.x, eye, this.body.pos.z);
      if (this.selfAvatar) this.selfAvatar.isActive = false;
      return;
    }

    // third person (Prop-Hunt hider): pull the camera back along the aim
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

    // show the crate disguise standing at the player's feet
    const a = this.selfAvatar;
    a.isActive = true;
    a.transform.setPosition(this.body.pos.x, this.body.pos.y, this.body.pos.z);
    a.transform.setRotation(0, (this.body.yaw * 180) / Math.PI, 0);
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
    this.ws.select("ak47");
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
    this.settings.onChange = () => this.applySettings();
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
      const sens = 0.005 * this.settings.state.sensitivity * (this.ws.scoped ? 0.35 : 1);
      this.body.look(dx, dy, sens);
    };
    t.onFire = (down) => {
      if (this.hud.chatOpen) { this.fireHeld = false; return; }
      this.fireHeld = down;
      if (down) this.triedFireQueued = true;
    };
    t.onJump = (down) => { if (down) this.keys.add("Space"); else this.keys.delete("Space"); };
    t.onCrouch = (down) => { if (down) this.keys.add("ControlLeft"); else this.keys.delete("ControlLeft"); };
    t.onScore = (down) => { this.sbOpen = down; };
    t.onScope = () => {
      if (this.ws.def().scope && this.alive && !this.thirdPersonActive()) { this.ws.setScope(!this.ws.scoped); this.applyScopeFov(); }
    };
    t.onReload = () => { if (this.alive) this.ws.reload(); };
    t.onWeapon = (i) => { if (this.alive && this.canSwitchWeapon()) { this.ws.select(LOADOUT[i]); this.applyScopeFov(); } };
    t.onChat = () => { this.keys.clear(); this.fireHeld = false; this.hud.openChat(); };
    t.onMic = () => {
      if (this.voice.micOk) { this.voice.setMuted(!this.voice.muted); this.hud.voice(this.voice.muted ? "muted" : "on"); }
    };
    t.build();

    // Adapt to the input device: switch to virtual controls the moment a touch
    // is seen, and back to mouse/keyboard on real mouse input (last one wins).
    // Desktop play is never altered — the touch overlay stays hidden + inert.
    const setMode = (on: boolean): void => {
      if (on === this.touchMode) return;
      this.touchMode = on;
      document.body.classList.toggle("touch", on);
      this.touch.setEnabled(on);
      this.touch.setWeapon(this.ws.current);
      if (on && this.inGame) { this.hud.clickToPlay(false); document.exitPointerLock(); }
    };
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") setMode(true);
      else if (e.pointerType === "mouse") setMode(false);
    }, { capture: true });
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && (e.movementX || e.movementY)) setMode(false);
    }, { capture: true });
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  tick(dt: number, now: number): void {
    // positional map sounds fade by the camera's distance to each emitter
    if (this.map.root) {
      const cp = this.camEntity.transform.worldPosition;
      this.map.tickSounds({ x: cp.x, y: cp.y, z: cp.z });
    }
    if (this.inGame) {
      const kFwd = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const kRight = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const inp: Input = {
        fwd: clamp(kFwd + this.touch.moveY, -1, 1),
        right: clamp(kRight + this.touch.moveX, -1, 1),
        jump: this.keys.has("Space"),
        crouch: this.keys.has("ControlLeft") || this.keys.has("KeyC"),
        sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.touch.sprint,
      };
      // prop hunt: seekers are frozen during the hide window; hiders are unarmed props
      const frozen = this.mode === "prophunt" && this.myRole === ROLE_SEEK && this.inPrepPhase();
      const isHider = this.mode === "prophunt" && this.myRole === ROLE_HIDE;
      const canPlay = this.alive && this.phase === "play" && !frozen;
      const speedBuff = this.buff?.kind === "speed" ? SPEED_MULT : 1;
      this.body.update(dt, canPlay ? inp : { fwd: 0, right: 0, jump: false, crouch: false, sprint: false }, this.ws.def().moveFactor * speedBuff * this.cfg.speed);

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

      // respawn overlay
      if (!this.alive) {
        const t = this.respawnAt - now;
        this.hud.respawnOverlay(t > 0 ? t : null);
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
      this.hud.scoreboard(this.sbOpen || this.phase === "inter", this.net.players, this.scores, this.net.myId);
      this.updateModeVisuals();
      this.updateModeHud();
    } else if (this.lobbyView) {
      this.updateLobbyCamera(now);
    }
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
      cr: this.body.crouched ? 1 : 0,
      w: this.ws.current,
      hp: this.alive ? this.myHp : 0,
    };
  }

  netTick(now: number): void {
    if (this.net.isHost) {
      const ps: PlayerState[] = [this.myState()];
      for (const r of this.remotes.values()) {
        ps.push({ id: r.id, p: [r.pos.x, r.pos.y, r.pos.z], yaw: r.yaw, pitch: 0, cr: r.crouched ? 1 : 0, w: r.weapon, hp: this.hpMap[r.id] ?? 0 });
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
    this.resolveRay(o, d, def, 1, this.net.myId, true);
  }

  /** trace one segment; may recurse once through a wall (wallbang) */
  resolveRay(o: Vec3, d: Vec3, def: WeaponDef, dmgScale: number, shooterId: string, localShooter: boolean, depth = 0, baseDist = 0): void {
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
        if (!def.melee) this.tracers.spawn({ x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 }, pp);
        this.tracers.impact(pp);
        const rel = this.relAudio(pp);
        sfx.impact(rel.pan, rel.dist);
      }
      return;
    }
    if (bh) {
      const bp: Vec3 = { x: o.x + d.x * bh.dist, y: o.y + d.y * bh.dist, z: o.z + d.z * bh.dist };
      if (localShooter) {
        if (!def.melee) this.tracers.spawn({ x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 }, bp);
        this.tracers.impact(bp);
        const rel = this.relAudio(bp);
        sfx.impact(rel.pan, rel.dist);
        this.reportBarrelHit(bh.index, Math.max(1, Math.round(def.damage * dmgScale * this.dmgMult)));
      }
      return;
    }

    const end: Vec3 = { x: o.x + d.x * Math.min(vDist, wallDist), y: o.y + d.y * Math.min(vDist, wallDist), z: o.z + d.z * Math.min(vDist, wallDist) };
    if (localShooter) {
      const mo: Vec3 = { x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 };
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

  // ─── grenades ───────────────────────────────────────────────────────────────

  throwNade(kind: NadeKind): void {
    const d = this.body.aimDir();
    const o: Vec3 = { x: this.body.pos.x + d.x * 0.35, y: this.body.eyeY - 0.05, z: this.body.pos.z + d.z * 0.35 };
    const spd = kind === "he" ? 16 : 14;
    const v: Vec3 = { x: d.x * spd, y: d.y * spd + 3.2, z: d.z * spd };
    this.nades.throw_(kind, o, v, this.net.myId, true);
    const m: Msg = { t: "nade", id: this.net.myId, k: kind, o: [o.x, o.y, o.z], v: [v.x, v.y, v.z] };
    if (this.net.isHost) this.net.broadcast(m);
    else this.net.send(m);
    // last one thrown → back to rifle (but keep the gungame/prophunt weapon lock)
    if (this.ws.ammo[kind].mag <= 0) window.setTimeout(() => {
      if (this.alive && this.ws.current === kind) {
        if (this.mode === "gungame") this.applyTier(this.tiers[this.net.myId] ?? 0);
        else if (this.canSwitchWeapon()) { this.ws.select("ak47"); this.applyScopeFov(); }
      }
    }, 500);
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
      this.pushGame();
      const respawn = MODES[this.mode].respawn;
      // prop hunt: dead hiders don't respawn (they stay out for the round)
      const noRespawn = this.mode === "prophunt" && this.teams[victim] === ROLE_HIDE;
      if (!noRespawn) window.setTimeout(() => this.hostSpawn(victim), respawn * 1000);
    }
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
    if (bot) { bot.body.teleport(sp.p, sp.yaw); bot.targetId = null; bot.fireCd = 0.4; }
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
    document.body.classList.remove("hider");
    document.exitPointerLock();
    this.hud.end(this.net.players, this.scores, this.net.isHost, this.resultTitle());
    this.hud.show("end");
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
        if (this.net.isHost) this.net.broadcast({ t: "chat", id: from, txt: m.txt }, fromId);
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
        this.respawnAt = performance.now() / 1000 + MODES[this.mode].respawn;
        this.hud.crosshair(false);
        this.ws.setScope(false);
        this.applyScopeFov();
        this.clearBuff();
        sfx.death();
      } else {
        const r = this.remotes.get(m.v);
        if (r) r.alive = false;
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
      if (this.net.isHost) this.net.broadcast(m);
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
      this.ensureRemote(id, name);
      const body = new PlayerBody(this.map);
      body.gravityScale = this.cfg.gravity;
      body.teleport({ x: rand(-6, 6), y: 4, z: rand(-6, 6) }, rand(0, 360));
      this.bots.set(id, { id, body, fireCd: 0, retargetCd: 0, targetId: null, strafe: 1, strafeCd: 0, jumpCd: 0 });
      this.net.broadcast({ t: "pjoin", p: info }); // let guests see the bot
    }
  }

  clearBots(): void {
    for (const b of this.bots.values()) {
      const r = this.remotes.get(b.id);
      if (r) { r.entity.destroy(); this.remotes.delete(b.id); }
      this.net.players = this.net.players.filter((p) => p.id !== b.id);
      delete this.scores[b.id];
      delete this.hpMap[b.id];
      this.net.broadcast({ t: "pleave", id: b.id });
    }
    this.bots.clear();
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

  /** drive every bot: target, move, aim, shoot (host authority, all local) */
  updateBots(dt: number, _now: number): void {
    for (const bot of this.bots.values()) {
      const r = this.remotes.get(bot.id);
      if (!r) continue;
      if ((this.hpMap[bot.id] ?? 0) <= 0) { r.setPose(bot.body.pos, bot.body.yaw, false, false); continue; }

      const role = this.teams[bot.id];
      const isHider = this.mode === "prophunt" && role === ROLE_HIDE;
      const frozen = this.mode === "prophunt" && role === ROLE_SEEK && this.inPrepPhase();
      const playing = this.phase === "play" && !frozen;

      bot.retargetCd -= dt;
      if (bot.retargetCd <= 0 || !this.botTargetAlive(bot.targetId)) {
        bot.targetId = isHider ? null : this.botPickTarget(bot);
        bot.retargetCd = 0.8 + Math.random() * 0.8;
      }
      const tgt = bot.targetId ? this.entityPos(bot.targetId) : null;
      const eye: Vec3 = { x: bot.body.pos.x, y: bot.body.eyeY, z: bot.body.pos.z };

      let fwd = 0, right = 0, jump = false, sprint = false;
      if (tgt && !isHider) {
        const dx = tgt.x - bot.body.pos.x, dz = tgt.z - bot.body.pos.z;
        const dist = Math.hypot(dx, dz);
        bot.body.yaw = Math.atan2(-dx, -dz);
        bot.body.pitch = clamp(Math.atan2((tgt.y + 1.0) - eye.y, Math.max(0.5, dist)), -1.2, 1.2);
        fwd = dist > 10 ? 1 : dist < 5 ? -0.5 : 0.25;
        sprint = dist > 16;
        bot.strafeCd -= dt;
        if (bot.strafeCd <= 0) { bot.strafe = Math.random() < 0.5 ? -1 : 1; bot.strafeCd = 0.5 + Math.random(); }
        right = bot.strafe * 0.7;
        bot.jumpCd -= dt;
        if (bot.jumpCd <= 0) { jump = Math.random() < 0.25; bot.jumpCd = 1 + Math.random() * 2.5; }
        bot.fireCd -= dt;
        if (playing && bot.fireCd <= 0) this.botTryShoot(bot, tgt, dist, eye);
      } else {
        // wander (hiders, or nobody to shoot)
        bot.strafeCd -= dt;
        if (bot.strafeCd <= 0) { bot.body.yaw += (Math.random() - 0.5) * 1.6; bot.strafeCd = 1 + Math.random() * 2; }
        fwd = 0.6;
        bot.body.pitch *= 0.9;
      }

      const input: Input = playing
        ? { fwd, right, jump, crouch: false, sprint }
        : { fwd: 0, right: 0, jump: false, crouch: false, sprint: false };
      bot.body.update(dt, input, this.cfg.speed);
      r.setPose(bot.body.pos, bot.body.yaw, false, true);
    }
  }

  botTryShoot(bot: BotAI, tgt: Vec3, dist: number, eye: Vec3): void {
    const tune = BOT_TUNING[this.cfg.difficulty];
    const wid: WeaponId = this.mode === "gungame" ? tierWeapon(this.tiers[bot.id] ?? 0) : "ak47";
    const def = WEAPONS[wid];
    if (def.melee) { // knife — only up close
      if (dist < 2.2) this.botDealDamage(bot, def, wid, false);
      bot.fireCd = 0.8 * tune.rate;
      return;
    }
    const tx = tgt.x - eye.x, ty = (tgt.y + 1.0) - eye.y, tz = tgt.z - eye.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    const dir: Vec3 = { x: tx / len, y: ty / len, z: tz / len };
    const wall = this.map.raycast(eye, dir, len);
    if (wall && wall.dist < len - 0.5) { bot.fireCd = 0.25; return; } // no line of sight
    // let guests render the bot's shot (tracer + spatial audio)
    this.net.broadcast({ t: "shot", id: bot.id, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], w: wid });
    // muzzle flash feedback: tracer + spatial shot
    const reach = Math.min(len, def.range);
    this.tracers.spawn(
      { x: eye.x + dir.x * 0.6, y: eye.y - 0.1, z: eye.z + dir.z * 0.6 },
      { x: eye.x + dir.x * reach, y: eye.y + dir.y * reach, z: eye.z + dir.z * reach },
    );
    const rel = this.relAudio(eye);
    sfx.shot(wid, rel.pan, rel.dist);
    // accuracy that falls off with range, scaled by bot difficulty
    const pHit = clamp(tune.aim - dist / 60, 0.08, tune.aim);
    if (Math.random() < pHit) this.botDealDamage(bot, def, wid, Math.random() < 0.12 * tune.aim / 0.72);
    bot.fireCd = (def.auto ? 0.5 : 0.95) * tune.rate * (0.8 + Math.random() * 0.7);
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
    this.hud.lobby(this.net.lobbyCode, this.net.players, this.net.isHost, this.mode, this.cfg);
    this.hud.setOffline(this.net.offline);
    this.refreshLobbyAvatars();
  }

  // ─── 3D lobby ─────────────────────────────────────────────────────────────────

  enterLobby(): void {
    this.lobbyView = true;
    this.ws.showViewmodel(false);
    if (this.selfAvatar) this.selfAvatar.isActive = false;
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
    this.exitLobby();
    this.ws.showViewmodel(true);
    sfx.stopTheme();
    sfx.stopInterlude();
    this.updateAmbientWater();
    this.hud.show("game");
    this.hud.hp(this.myHp);
    this.refreshAmmoHud();
    this.hud.crosshair(true);
    this.hud.clickToPlay(!this.touchMode);
  }

  refreshAmmoHud(): void {
    const a = this.ws.ammo[this.ws.current];
    this.hud.ammo(this.ws.current, a.mag, a.reserve, this.ws.reloading > 0);
    this.touch.setWeapon(this.ws.current);
  }
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
