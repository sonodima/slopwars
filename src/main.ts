// ─── Bootstrap + game orchestration ──────────────────────────────────────────
import {
  AmbientLight, BackgroundMode, BlinnPhongMaterial, BloomEffect, Camera, Color,
  DirectLight, Engine, Entity, FogMode, MSAASamples, MeshRenderer, PostProcess,
  PrimitiveMesh, Quaternion, ShadowResolution, ShadowType, SkyBoxMaterial,
  TextureCube, TonemappingEffect, TonemappingMode, UnlitMaterial, Vector3, WebGLEngine,
} from "@galacean/engine";
import { sfx } from "./audio";
import { loadHDRCube } from "./assets";
import { Hud } from "./hud";
import { GameMap } from "./map";
import { resolveTextures } from "./textures";
import { GameModels } from "./models";
import { MapEnv } from "./maps/schema";
import {
  DEFAULT_MAP, mapById, mapMetas, pickVotedMap, randomMapId, tallyVotes,
} from "./maps";
import { HE_DAMAGE, HE_RADIUS, MOL_RADIUS, MOL_TICK_DMG, NadeKind, Projectiles } from "./nades";
import { Net, colorFor } from "./net";
import { Input, PlayerBody } from "./player";
import { RemotePlayer } from "./remote";
import { MODEL_LOAD_COUNT, loadModels } from "./models";
import {
  GamePhase, GameSnapshot, INTERMISSION, MAX_HP, Msg, PICKUP_HEAL, PICKUP_RADIUS,
  PICKUP_RESPAWN, PlayerState, POWERUPS, POWERUP_INTERVAL, POWERUP_RADIUS, PowerupKind,
  QUAD_MULT, RAPID_MULT, RESPAWN_TIME, ROUNDS_PER_GAME, ROUND_TIME, SPEED_MULT, TICK_RATE,
  Vec3, WEAPONS, WeaponDef, WeaponId, LOADOUT, clamp, rand, randomPowerup,
} from "./types";
import { Voice } from "./voice";
import { TracerPool, WeaponSystem } from "./weapons";

class Game {
  engine!: Engine;
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

  // map rotation + voting
  currentMapId = DEFAULT_MAP;
  mapVotes: Record<string, string> = {}; // host: playerId → map id
  myVote: string | null = null;
  lastVoteCounts: Record<string, number> = {};
  body!: PlayerBody;
  ws!: WeaponSystem;
  tracers!: TracerPool;
  nades!: Projectiles;
  hud = new Hud();
  net = new Net();
  voice = new Voice();

  remotes = new Map<string, RemotePlayer>();
  names = new Map<string, string>();

  // 3D lobby scene
  lobbyView = false;
  lobbyStageRoot!: Entity;
  lobbyAvatars = new Map<string, Entity>();
  private lobbyTarget = new Vector3(0, 1.3, -6);
  private worldUp = new Vector3(0, 1, 0);

  // authoritative (host) / mirrored (guest)
  phase: GamePhase = "lobby";
  round = 0;
  timeLeft = 0;
  scores: Record<string, { k: number; d: number }> = {};
  hpMap: Record<string, number> = {}; // host only

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

  async start(): Promise<void> {
    const engine = await WebGLEngine.create({ canvas: "game-canvas" });
    this.engine = engine;
    engine.canvas.resizeByClientSize();
    window.addEventListener("resize", () => engine.canvas.resizeByClientSize());

    const scene = engine.sceneManager.activeScene;
    const root = scene.createRootEntity("root");
    this.root = root;
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
    cam.msaaSamples = MSAASamples.FourX;

    const ppE = root.createChild("post");
    const pp = ppE.addComponent(PostProcess);
    const bloom = pp.addEffect(BloomEffect);
    bloom.enabled = true;
    bloom.threshold.value = 1.0;
    bloom.intensity.value = 0.55;
    bloom.scatter.value = 0.6;
    const tone = pp.addEffect(TonemappingEffect);
    tone.enabled = true;
    tone.mode.value = TonemappingMode.ACES;

    // ── load models with progress (textures + HDRI load lazily, per map) ──
    this.hud.show("loading");
    const total = MODEL_LOAD_COUNT + 1; // models + first map's texture/sky bundle
    let loaded = 0;
    const bump = (): void => this.hud.loadingProgress(++loaded / total);
    this.models = await loadModels(engine, bump);

    // ── HDRI skybox material shell (its texture is set per-map by loadMap) ──
    const skyMat = new SkyBoxMaterial(engine);
    skyMat.textureDecodeRGBM = true;
    scene.background.sky.material = skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);
    amb.specularTextureDecodeRGBM = true;
    this.skyMat = skyMat;

    // ── map (resolves textures + sky, builds geometry/env/pickups) ──
    await this.loadMap(DEFAULT_MAP);
    bump();

    // ── player + weapons + fx ──
    this.body = new PlayerBody(this.map);
    this.body.teleport({ x: 0, y: 0.1, z: -18 }, 180);
    this.lobbyStageRoot = root.createChild("lobby-avatars");
    this.ws = new WeaponSystem(engine, this.camEntity, this.models);
    this.ws.onShoot = (def, spread) => {
      if (def.throwable) this.throwNade(def.id as NadeKind);
      else this.fireHitscan(def, spread);
    };
    this.ws.onAmmoChange = () => this.refreshAmmoHud();
    this.tracers = new TracerPool(engine, root);
    this.nades = new Projectiles(engine, root, this.map);
    this.nades.onBounce = (p) => { const r = this.relAudio(p); sfx.nadeBounce(r.pan, r.dist); };
    this.nades.onBoom = (p) => { const r = this.relAudio(p); sfx.explosion(r.pan, r.dist); };
    this.nades.onBreak = (p) => { const r = this.relAudio(p); sfx.shatter(r.pan, r.dist); };
    this.nades.onIgnite = (p, dur) => { const r = this.relAudio(p); sfx.fire(dur, r.pan, r.dist); };
    this.nades.onExplode = (c, _owner, local) => { if (local) this.explodeDamage(c); };
    this.nades.onFireTick = (c, _owner, local) => { if (local) this.fireTickDamage(c); };

    window.addEventListener("beforeunload", () => this.net.leave());
    this.bindInput();
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

  // ─── input ──────────────────────────────────────────────────────────────────

  bindInput(): void {
    const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.inGame) this.hud.clickToPlay(!this.locked);
      if (!this.locked) { this.keys.clear(); this.fireHeld = false; }
    });
    canvas.addEventListener("click", () => {
      if (this.inGame && !this.locked) canvas.requestPointerLock();
    });
    document.getElementById("click-to-play")!.addEventListener("click", () => {
      if (this.inGame && !this.locked) canvas.requestPointerLock();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.inGame) return;
      const sens = 0.0022 * (this.ws.scoped ? 0.35 : 1);
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
      if (!this.locked || !this.inGame || !this.alive) return;
      this.ws.cycle(e.deltaY > 0 ? 1 : -1);
      this.applyScopeFov();
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
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
      if (wi >= 0 && this.alive) { this.ws.select(LOADOUT[wi]); this.applyScopeFov(); }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Tab") this.sbOpen = false;
      this.keys.delete(e.code);
    });
  }

  applyScopeFov(): void {
    this.camera.fieldOfView = this.ws.scoped ? 22 : 75;
    this.hud.scope(this.ws.scoped);
    this.hud.crosshair(!this.ws.scoped && this.alive);
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  tick(dt: number, now: number): void {
    if (this.inGame) {
      const inp: Input = {
        fwd: (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0),
        right: (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0),
        jump: this.keys.has("Space"),
        crouch: this.keys.has("ControlLeft") || this.keys.has("KeyC"),
        sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      };
      const canPlay = this.alive && this.phase === "play";
      const speedBuff = this.buff?.kind === "speed" ? SPEED_MULT : 1;
      this.body.update(dt, canPlay ? inp : { fwd: 0, right: 0, jump: false, crouch: false, sprint: false }, this.ws.def().moveFactor * speedBuff);

      if (this.body.jumped) sfx.jump();
      if (this.body.landed) sfx.land();
      const moving = this.body.horizontalSpeed() > 1.5;
      if (moving && this.body.onGround && canPlay) {
        this.stepAcc += dt * this.body.horizontalSpeed();
        if (this.stepAcc > 3.2) { this.stepAcc = 0; sfx.footstep(); }
      }

      // fire
      if (canPlay && (this.fireHeld || this.triedFireQueued)) {
        if (this.ws.def().auto || this.triedFireQueued) {
          this.ws.tryFire(this.body.horizontalSpeed(), this.body.onGround);
        }
      }
      this.triedFireQueued = false;

      this.ws.update(dt, moving, this.body.onGround);
      this.tracers.update(dt);
      this.nades.update(dt, now);

      // camera transform
      const eye = this.body.eyeY;
      this.camEntity.transform.setPosition(this.body.pos.x, eye, this.body.pos.z);
      Quaternion.rotationYawPitchRoll(this.body.yaw, this.body.pitch + this.ws.recoilPitch, 0, this.q);
      this.camEntity.transform.rotationQuaternion = this.q;

      // remotes + proximity voice
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

      this.hud.timer(this.phase, this.round, this.timeLeft);
      this.hud.scoreboard(this.sbOpen || this.phase === "inter", this.net.players, this.scores, this.net.myId);
    } else if (this.lobbyView) {
      this.updateLobbyCamera(now);
    }
    this.hud.update(dt);

    // stats overlay
    this.fpsE += (1 / Math.max(dt, 1e-4) - this.fpsE) * 0.08;
    this.statAcc += dt;
    if (this.statAcc >= 0.25 && this.inGame) {
      this.statAcc = 0;
      const tris = this.map.tris + this.remotes.size * 48 + 220;
      this.hud.stats(
        `<b>${this.fpsE.toFixed(0)}</b> fps · ${(1000 / this.fpsE).toFixed(1)} ms<br>` +
        `${(tris / 1000).toFixed(1)}k tris · ${this.map.solids.length} solids<br>` +
        `ping ${this.net.isHost ? "host" : this.ping.toFixed(0) + " ms"} · ` +
        `spd ${this.body.horizontalSpeed().toFixed(1)} u/s`
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

  reportHit(victimId: string, dmg: number, hs: boolean, w: WeaponId): void {
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
    // last one thrown → back to rifle
    if (this.ws.ammo[kind].mag <= 0) window.setTimeout(() => {
      if (this.alive && this.ws.current === kind) { this.ws.select("ak47"); this.applyScopeFov(); }
    }, 500);
  }

  explodeDamage(c: Vec3): void {
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
      this.reportHit(t.id, dmg, false, "he");
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
    this.explodeDamage(c); // host applies HE-like area damage
    this.net.broadcast({ t: "bexp", i });
  }

  spawnBarrelFx(c: Vec3): void {
    this.nades.explodeFx(c);
  }

  // ─── host authority ─────────────────────────────────────────────────────────

  hostApplyHit(attacker: string, victim: string, dmg: number, hs: boolean, w: WeaponId): void {
    if (this.phase !== "play") return;
    const hp = this.hpMap[victim];
    if (hp === undefined || hp <= 0) return;
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
      this.pushGame();
      window.setTimeout(() => this.hostSpawn(victim), RESPAWN_TIME * 1000);
    }
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
    const m: Msg = { t: "spawn", id, p: [sp.p.x, sp.p.y, sp.p.z], yaw: sp.yaw };
    this.net.broadcast(m);
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
          if (this.round >= ROUNDS_PER_GAME) {
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
    // round 1 = random map; later rounds = plurality of the interlude vote
    const mapId = n === 1 ? randomMapId() : pickVotedMap(this.mapVotes);
    await this.loadMap(mapId);
    this.mapVotes = {};
    this.myVote = null;
    this.hud.vote(null);

    this.phase = "play";
    this.round = n;
    this.timeLeft = ROUND_TIME;
    this.pkTimers = this.map.pickupSpots.map(() => 0);
    for (const e of this.pkEntities) e.isActive = true;
    this.pwSpawnAcc = 0;
    for (let i = 0; i < this.pwActive.length; i++) { this.pwActive[i] = null; if (this.pwEntities[i]) this.pwEntities[i].isActive = false; }
    this.clearBuff();
    for (const p of this.net.players) this.hpMap[p.id] = MAX_HP;
    this.pushGame();
    for (const p of this.net.players) this.hostSpawn(p.id);
    sfx.stopInterlude();
    this.hud.banner(`${this.map.meta.name} · Round ${n} — go!`);
    sfx.roundStart();
  }

  pushGame(): void {
    const g = this.gameSnap();
    this.net.broadcast({ t: "game", g });
    this.applyGame(g);
  }

  gameSnap(): GameSnapshot {
    return { phase: this.phase, round: this.round, timeLeft: this.timeLeft, scores: this.scores, pk: this.pkTimers.map((t) => Math.ceil(t)), map: this.currentMapId };
  }

  applyGame(g: GameSnapshot): void {
    const prevPhase = this.phase;
    // guests follow the host's loaded map
    if (!this.net.isHost && g.map && g.map !== this.currentMapId) void this.loadMap(g.map);
    this.phase = g.phase;
    this.round = g.round;
    this.timeLeft = g.timeLeft;
    this.scores = g.scores;
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
    document.exitPointerLock();
    this.hud.end(this.net.players, this.scores, this.net.isHost);
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
    const tex = await resolveTextures(this.engine, def.textures);
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.currentMapId = id;
    await this.applyEnv(def.env);
    this.buildPickups(this.root);
    this.buildPowerups(this.root);
    this.updateAmbientWater();
  }

  /** apply a map's skybox / fog / lighting identity (awaits its HDRI if any) */
  async applyEnv(env: MapEnv): Promise<void> {
    const scene = this.engine.sceneManager.activeScene;
    this.sunE.transform.setRotation(env.sun.rot[0], env.sun.rot[1], env.sun.rot[2]);
    this.sun.color = new Color(env.sun.color[0], env.sun.color[1], env.sun.color[2], 1);
    this.sun.shadowStrength = env.sun.strength;
    this.amb.diffuseSolidColor = new Color(env.ambient.color[0], env.ambient.color[1], env.ambient.color[2], 1);
    this.amb.diffuseIntensity = env.ambient.intensity;
    this.amb.specularIntensity = env.ambient.specular ?? 0.85;
    if (env.fog) {
      scene.fogMode = FogMode.Linear;
      scene.fogColor = new Color(env.fog.color[0], env.fog.color[1], env.fog.color[2], 1);
      scene.fogStart = env.fog.start;
      scene.fogEnd = env.fog.end;
    } else {
      scene.fogMode = FogMode.None;
    }
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
      if (!this.inGame && this.phase === "lobby") {
        this.hud.connecting(false);
        this.hud.menuError(err.includes("Could not connect") || err.includes("peer-unavailable") ? "Lobby not found." : err);
        this.hud.show("menu");
      } else if (!this.net.isHost && err.includes("Lost connection")) {
        // host gone → whole lobby dead; back to menu
        this.inGame = false;
        this.exitLobby();
        document.exitPointerLock();
        this.hud.menuError("Host left — lobby closed.");
        this.hud.connecting(false);
        this.hud.show("menu");
        window.setTimeout(() => location.reload(), 1200);
      } else {
        this.hud.banner("Connection lost");
      }
    };

    n.onMessage = (m, fromId) => this.handleMsg(m, fromId);
  }

  ensureRemote(id: string, name: string): RemotePlayer {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemotePlayer(this.engine, this.engine.sceneManager.activeScene.getRootEntity()!, id, name, colorFor(id));
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
        this.hud.chatMsg(this.names.get(from) ?? "?", colorFor(from), m.txt);
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
        this.respawnAt = performance.now() / 1000 + RESPAWN_TIME;
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
        this.ws.select("ak47");
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
      this.net.broadcast({ t: "start" });
      this.enterGame();
      void this.hostStartRound(1);
    };

    this.hud.onChat = (txt) => {
      this.hud.chatMsg(this.names.get(this.net.myId) ?? "me", colorFor(this.net.myId), txt);
      const m: Msg = { t: "chat", id: this.net.myId, txt };
      if (this.net.isHost) this.net.broadcast(m);
      else this.net.send(m);
    };

    this.hud.onPlayAgain = () => {
      if (!this.net.isHost) return;
      for (const id of Object.keys(this.scores)) this.scores[id] = { k: 0, d: 0 };
      this.net.broadcast({ t: "start" });
      this.enterGame();
      void this.hostStartRound(1);
    };

    this.hud.onVote = (id) => this.castVote(id);
  }

  refreshLobby(): void {
    this.hud.lobby(this.net.lobbyCode, this.net.players, this.net.isHost);
    this.refreshLobbyAvatars();
  }

  // ─── 3D lobby ─────────────────────────────────────────────────────────────────

  enterLobby(): void {
    this.lobbyView = true;
    this.ws.showViewmodel(false);
    this.refreshLobbyAvatars();
  }

  exitLobby(): void {
    this.lobbyView = false;
    for (const e of this.lobbyAvatars.values()) e.destroy();
    this.lobbyAvatars.clear();
  }

  /** rebuild the row of player avatars standing on the lobby stage */
  refreshLobbyAvatars(): void {
    if (!this.lobbyStageRoot) return;
    for (const e of this.lobbyAvatars.values()) e.destroy();
    this.lobbyAvatars.clear();
    const players = this.net.players;
    const n = players.length;
    players.forEach((p, i) => {
      const x = (i - (n - 1) / 2) * 1.3;
      const z = -6;
      const e = this.buildAvatar(this.lobbyStageRoot, p.color);
      e.transform.setPosition(x, this.map.floorY(x, z) + 0.05, z);
      e.transform.setRotation(0, 180, 0); // face south toward the camera
      this.lobbyAvatars.set(p.id, e);
    });
  }

  /** stylized box character (lobby showcase) */
  buildAvatar(parent: Entity, color: number): Entity {
    const e = parent.createChild("avatar");
    const c = new Color(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1);
    const body = new BlinnPhongMaterial(this.engine); body.baseColor = c;
    const dark = new BlinnPhongMaterial(this.engine); dark.baseColor = new Color(0.15, 0.14, 0.13, 1);
    const skin = new BlinnPhongMaterial(this.engine); skin.baseColor = new Color(0.85, 0.65, 0.5, 1);
    const mk = (x: number, y: number, z: number, w: number, h: number, d: number, m: BlinnPhongMaterial): void => {
      const p = e.createChild("p");
      p.transform.setPosition(x, y, z);
      const r = p.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(this.engine, w, h, d);
      r.setMaterial(m);
      r.castShadows = true;
    };
    mk(0, 0.45, 0, 0.5, 0.9, 0.32, dark);   // legs
    mk(0, 1.22, 0, 0.62, 0.64, 0.36, body); // torso
    mk(0, 1.72, 0, 0.3, 0.3, 0.3, skin);    // head
    mk(0.28, 1.3, -0.35, 0.06, 0.08, 0.55, dark); // gun
    return e;
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
    this.hud.clickToPlay(true);
  }

  refreshAmmoHud(): void {
    const a = this.ws.ammo[this.ws.current];
    this.hud.ammo(this.ws.current, a.mag, a.reserve, this.ws.reloading > 0);
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
