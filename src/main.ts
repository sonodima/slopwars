// ─── Bootstrap + game orchestration ──────────────────────────────────────────
import {
  AmbientLight, BackgroundMode, BloomEffect, Camera, Color, DirectLight, Engine,
  Entity, FogMode, MSAASamples, MeshRenderer, PostProcess, PrimitiveMesh,
  Quaternion, ShadowResolution, ShadowType, SkyBoxMaterial,
  TonemappingEffect, TonemappingMode, UnlitMaterial, WebGLEngine,
} from "@galacean/engine";
import { sfx } from "./audio";
import { loadHDRCube } from "./assets";
import { Hud } from "./hud";
import { GameMap } from "./map";
import { HE_DAMAGE, HE_RADIUS, MOL_RADIUS, MOL_TICK_DMG, NadeKind, Projectiles } from "./nades";
import { Net, colorFor } from "./net";
import { Input, PlayerBody } from "./player";
import { RemotePlayer } from "./remote";
import { MODEL_LOAD_COUNT, loadModels } from "./models";
import { TEXTURE_LOAD_COUNT, loadMapTextures } from "./textures";
import {
  GamePhase, GameSnapshot, INTERMISSION, MAX_HP, Msg, PICKUP_HEAL, PICKUP_RADIUS,
  PICKUP_RESPAWN, PlayerState, RESPAWN_TIME, ROUNDS_PER_GAME,
  ROUND_TIME, TICK_RATE, Vec3, WEAPONS, WeaponDef, WeaponId, LOADOUT, clamp, rand,
} from "./types";
import { Voice } from "./voice";
import { TracerPool, WeaponSystem } from "./weapons";

class Game {
  engine!: Engine;
  camera!: Camera;
  camEntity!: Entity;
  map = new GameMap();
  body!: PlayerBody;
  ws!: WeaponSystem;
  tracers!: TracerPool;
  nades!: Projectiles;
  hud = new Hud();
  net = new Net();
  voice = new Voice();

  remotes = new Map<string, RemotePlayer>();
  names = new Map<string, string>();

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
    // sky (HDRI) + image-based ambient applied after assets load, below

    // ── lights ──
    const sunE = root.createChild("sun");
    sunE.transform.setPosition(0, 30, 0);
    sunE.transform.setRotation(-52, -38, 0);
    const sun = sunE.addComponent(DirectLight);
    sun.color = new Color(1.35, 1.22, 1.0, 1);
    sun.shadowType = ShadowType.SoftHigh;
    sun.shadowStrength = 0.82;
    scene.shadowResolution = ShadowResolution.High;
    scene.shadowDistance = 70;
    scene.shadowFadeBorder = 0.15;

    const amb: AmbientLight = scene.ambientLight;
    amb.diffuseSolidColor = new Color(0.55, 0.6, 0.72, 1);
    amb.diffuseIntensity = 0.62;
    amb.specularIntensity = 0.85; // specularTexture set from HDRI after load

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

    // ── load assets (textures, HDRI sky, models) with progress ──
    this.hud.show("loading");
    const total = TEXTURE_LOAD_COUNT + 1 + MODEL_LOAD_COUNT;
    let loaded = 0;
    const bump = (): void => this.hud.loadingProgress(++loaded / total);
    const [tex, sky, models] = await Promise.all([
      loadMapTextures(engine, bump),
      loadHDRCube(engine, "hdri/sky.hdr").then((c) => { bump(); return c; }),
      loadModels(engine, bump),
    ]);

    // ── HDRI skybox + image-based ambient ──
    const skyMat = new SkyBoxMaterial(engine);
    skyMat.texture = sky;
    skyMat.textureDecodeRGBM = true;
    scene.background.mode = BackgroundMode.Sky;
    scene.background.sky.material = skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);
    amb.specularTexture = sky;
    amb.specularTextureDecodeRGBM = true;

    // ── map ──
    this.map.build(engine, root, tex, models);

    // ── player + weapons + fx ──
    this.body = new PlayerBody(this.map);
    this.body.teleport({ x: 0, y: 0.1, z: -18 }, 180);
    this.buildPickups(root);
    this.ws = new WeaponSystem(engine, this.camEntity, models);
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
        crouch: this.keys.has("ControlLeft") || this.keys.has("KeyC") || this.keys.has("ShiftLeft"),
      };
      const canPlay = this.alive && this.phase === "play";
      this.body.update(dt, canPlay ? inp : { fwd: 0, right: 0, jump: false, crouch: false }, this.ws.def().moveFactor);

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

      // pickups: spin/bob + host claim detection
      this.pkSpin += dt * 2.2;
      for (let i = 0; i < this.pkEntities.length; i++) {
        const e = this.pkEntities[i];
        if (!e.isActive) continue;
        const sp = this.map.pickupSpots[i];
        e.transform.setPosition(sp.x, sp.y + Math.sin(this.pkSpin + i) * 0.12, sp.z);
        e.transform.setRotation(0, (this.pkSpin * 180) / Math.PI, 0);
      }
      if (this.net.isHost && this.phase === "play") this.hostCheckPickups();

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

    const end: Vec3 = { x: o.x + d.x * Math.min(vDist, wallDist), y: o.y + d.y * Math.min(vDist, wallDist), z: o.z + d.z * Math.min(vDist, wallDist) };
    if (localShooter) {
      const mo: Vec3 = { x: o.x + d.x * 0.8, y: o.y - 0.12, z: o.z + d.z * 0.8 };
      if (!def.melee) this.tracers.spawn(mo, end);
    }

    if (victim) {
      let dmg = def.damage * dmgScale * falloff(def, baseDist + vDist);
      if (vHead) dmg *= def.headMult;
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
            sfx.beep();
          }
        } else {
          this.hostStartRound(this.round + 1);
        }
      }
    }
  }

  hostStartRound(n: number): void {
    this.phase = "play";
    this.round = n;
    this.timeLeft = ROUND_TIME;
    this.pkTimers = this.map.pickupSpots.map(() => 0);
    for (const e of this.pkEntities) e.isActive = true;
    for (const p of this.net.players) this.hpMap[p.id] = MAX_HP;
    this.pushGame();
    for (const p of this.net.players) this.hostSpawn(p.id);
    this.hud.banner(`Round ${n} — go!`);
    sfx.beep(true);
  }

  pushGame(): void {
    const g = this.gameSnap();
    this.net.broadcast({ t: "game", g });
    this.applyGame(g);
  }

  gameSnap(): GameSnapshot {
    return { phase: this.phase, round: this.round, timeLeft: this.timeLeft, scores: this.scores, pk: this.pkTimers.map((t) => Math.ceil(t)) };
  }

  applyGame(g: GameSnapshot): void {
    const prevPhase = this.phase;
    this.phase = g.phase;
    this.round = g.round;
    this.timeLeft = g.timeLeft;
    this.scores = g.scores;
    if (!this.net.isHost && g.pk) {
      for (let i = 0; i < this.pkEntities.length; i++) this.pkEntities[i].isActive = (g.pk[i] ?? 0) <= 0;
    }
    if (!this.net.isHost) {
      if (prevPhase !== "inter" && g.phase === "inter") { this.hud.banner(`Round ${g.round} over`); sfx.beep(); }
      if (prevPhase !== "play" && g.phase === "play") { this.hud.banner(`Round ${g.round} — go!`); sfx.beep(true); }
      if (g.phase === "over" && prevPhase !== "over") this.enterEnd();
    }
  }

  enterEnd(): void {
    this.inGame = false;
    document.exitPointerLock();
    this.hud.end(this.net.players, this.scores, this.net.isHost);
    this.hud.show("end");
    sfx.death();
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
        else this.hud.show("lobby");
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
      this.hostStartRound(1);
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
      this.hostStartRound(1);
    };
  }

  refreshLobby(): void {
    this.hud.lobby(this.net.lobbyCode, this.net.players, this.net.isHost);
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
