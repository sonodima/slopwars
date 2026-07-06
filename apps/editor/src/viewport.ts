// ─── 3D viewport: fly camera + selection + transform gizmos ──────────────────
// Reuses the game's exact rendering stack (GameMap + MapBuilder + the object
// registry + catalog-driven loaders) so the preview is faithful. On top of the
// WebGL canvas sits a 2D overlay canvas that draws object markers and the active
// transform gizmo; all projection/picking math is done manually from the camera
// basis so it doesn't depend on engine screen-space conventions.
import {
  AmbientLight, BackgroundMode, BoundingBox, Camera, Color, DirectLight, Entity,
  FogMode, MeshRenderer, ShadowResolution, ShadowType, SkyBoxMaterial, TextureCube, Vector3, WebGLEngine,
} from "@galacean/engine";
import type { MapDef, Placement, Tuple3 } from "@slopwars/shared";
import { placeRot, placeScale } from "@slopwars/shared";
import { GameMap } from "@game/map";
import { GameModels, loadModels } from "@game/models";
import { resolveTextures, type MapTextures } from "@game/textures";
import { mapTextureFolders } from "@game/objects";
import { loadHDRCube } from "@game/assets";
import "@game/objects"; // side effect: register built-in object types
import { state } from "./state";

/** an axis-aligned world box, min/max as plain tuples */
interface Box { min: Tuple3; max: Tuple3 }

/** transform tools (no "select" — clicking always selects; a tool just decides
 *  which gizmo shows). */
export type Tool = "move" | "rotate" | "scale";
/** which gizmo handle a drag grabbed: an axis, a plane, or uniform (screen) */
type Handle = "x" | "y" | "z" | "xyz";

export interface PerfStats { fps: number; tris: number; objects: number; draws: number }

const DEG = Math.PI / 180;
const AXIS_COL: Record<Handle, string> = { x: "#e5484d", y: "#5bd15b", z: "#3b82f6", xyz: "#d6d6d6" };
const AXIS_IDX: Record<Handle, number> = { x: 0, y: 1, z: 2, xyz: 0 };

export class Viewport {
  ready = false;
  tool: Tool = "move";
  /** called after a gizmo edit finishes (so the inspector can refresh) */
  onEditCommit: (() => void) | null = null;

  private engine!: WebGLEngine;
  private root!: Entity;
  private camE!: Entity;
  private camera!: Camera;
  private sun!: DirectLight;
  private amb!: AmbientLight;
  private skyMat!: SkyBoxMaterial;
  private hdriCache = new Map<string, Promise<TextureCube>>();
  private models!: GameModels;
  private map = new GameMap();

  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private octx!: CanvasRenderingContext2D;

  // per-object-index → entities produced for it (for 3D picking + highlighting)
  private objEntities: Entity[][] = [];
  // cached resolved textures so a live drag can rebuild synchronously each frame
  private texCache: MapTextures | null = null;
  private texKey = "";
  // set while a transform drag mutates the map; consumed in the frame loop so the
  // rebuild is throttled to one per frame (the object follows the cursor live)
  private liveDirty = false;

  // free-fly camera (position + yaw/pitch), Unreal-style RMB-to-fly
  private pos = new Vector3(0, 24, 52);
  private yaw = 0;      // radians; 0 → looking toward -Z
  private pitch = -0.4;
  private keys = new Set<string>();
  private flying = false;
  private speed = 4.5;   // fly speed (m/s baseline; Shift = faster)

  // gizmo handle the pointer is hovering (for highlight), recomputed each frame
  private hover: Handle | null = null;
  // snapshot captured when a gizmo handle is grabbed; drives axis-constrained edits
  private drag: {
    handle: Handle;
    startVec: Tuple3;          // pos / scale / rot at grab time
    unit: [number, number];    // screen-space axis direction (unit)
    wpp: number;               // world units per screen pixel along the axis
    cx: number; cy: number;    // gizmo centre in screen px
    startAngle: number;        // pointer angle around centre (rotate)
    startPx: number; startPy: number;
  } | null = null;

  // perf stats (rolling fps)
  private perf: PerfStats = { fps: 0, tris: 0, objects: 0, draws: 0 };
  private frameTimes: number[] = [];
  private lastFrameT = 0;
  onPerf: ((p: PerfStats) => void) | null = null;

  // drag state
  private dragging = false;
  private dragKind: "camera" | "transform" | null = null;
  // virtual pointer in canvas-local pixels — kept in sync from movementX/Y so
  // transform math still works while the real cursor is pointer-locked/hidden
  private px = 0;
  private py = 0;

  async init(canvasId: string): Promise<void> {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const engine = await WebGLEngine.create({ canvas: this.canvas });
    this.engine = engine;
    engine.canvas.resizeByClientSize();

    const scene = engine.sceneManager.activeScene;
    this.root = scene.createRootEntity("root");

    const sunE = this.root.createChild("sun");
    sunE.transform.setRotation(-50, -35, 0);
    this.sun = sunE.addComponent(DirectLight);
    this.sun.color = new Color(1.3, 1.22, 1.05, 1);

    this.amb = scene.ambientLight;
    this.amb.diffuseSolidColor = new Color(0.5, 0.55, 0.66, 1);
    this.amb.diffuseIntensity = 0.75;
    this.skyMat = new SkyBoxMaterial(engine);

    this.camE = this.root.createChild("camera");
    this.camera = this.camE.addComponent(Camera);
    this.camera.fieldOfView = 55;
    this.camera.nearClipPlane = 0.05;
    this.camera.farClipPlane = 600;

    this.setupOverlay();
    this.models = await loadModels(engine);
    this.bindInput();
    this.bindResize();
    engine.run();
    this.applyCamera();
    this.ready = true;
    requestAnimationFrame(this.frame);
  }

  /** keep the WebGL drawing buffer matched to the canvas's on-screen size so the
   *  image is resized (not stretched) when the editor layout changes */
  private bindResize(): void {
    const resize = (): void => { if (this.ready || this.engine) this.engine.canvas.resizeByClientSize(); };
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(resize).observe(this.canvas.parentElement ?? this.canvas);
    }
    window.addEventListener("resize", resize);
  }

  async render(def: MapDef): Promise<void> {
    if (!this.ready) return;
    const folders = mapTextureFolders(def);
    const key = folders.slice().sort().join(",");
    if (key !== this.texKey || !this.texCache) {
      this.texCache = await resolveTextures(this.engine, folders);
      this.texKey = key;
    }
    this.rebuild(def, this.texCache);
  }

  /** synchronous rebuild with already-resolved textures (used by live drags) */
  private rebuild(def: MapDef, tex: MapTextures): void {
    this.objEntities = [];
    this.map.onBuildEntity = (i, e) => { (this.objEntities[i] ??= []).push(e); };
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.applyEnv(def);
  }

  /** immediate re-render during a drag (textures already cached from render()) */
  private renderLive(): void {
    if (!this.ready || !this.texCache || !state.map) return;
    this.rebuild(state.map, this.texCache);
  }

  setTool(t: Tool): void { this.tool = t; }

  /** editor-only graphics preset (shadows + shadow resolution). Not persisted
   *  and independent of the game's own quality settings. */
  setGraphics(preset: "low" | "medium" | "high"): void {
    if (!this.sun) return;
    const scene = this.engine.sceneManager.activeScene;
    if (preset === "low") {
      this.sun.shadowType = ShadowType.None;
    } else if (preset === "medium") {
      this.sun.shadowType = ShadowType.SoftLow;
      this.sun.shadowStrength = 0.85;
      scene.shadowResolution = ShadowResolution.Medium;
    } else {
      this.sun.shadowType = ShadowType.SoftHigh;
      this.sun.shadowStrength = 0.9;
      scene.shadowResolution = ShadowResolution.High;
    }
  }

  /** ground point (y=0) under a client pixel — for drag-drop placement */
  dropGround(clientX: number, clientY: number): Tuple3 | null {
    const rc = this.rect();
    return this.groundPoint(clientX - rc.left, clientY - rc.top, 0);
  }

  /** frame the camera on a world point */
  focus(x: number, y: number, z: number): void {
    if (!this.ready) return;
    this.pos.set(x + 14, y + 12, z + 14);
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z;
    this.yaw = Math.atan2(dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.applyCamera();
  }

  // ── env (mirrors the game's applyEnv so the preview is faithful) ───────────
  private envToken = 0;   // guards against a stale HDRI load applying out of order
  private applyEnv(def: MapDef): void {
    const scene = this.engine.sceneManager.activeScene;
    const e = def.env;
    this.sun.color = new Color(e.sun.color[0], e.sun.color[1], e.sun.color[2], 1);
    this.sun.entity.transform.setRotation(e.sun.rot[0], e.sun.rot[1], e.sun.rot[2]);
    this.amb.diffuseSolidColor = new Color(e.ambient.color[0], e.ambient.color[1], e.ambient.color[2], 1);
    this.amb.diffuseIntensity = Math.max(0.05, e.ambient.intensity);
    this.amb.specularIntensity = e.ambient.specular ?? 0.85;

    if (e.fog) {
      scene.fogMode = FogMode.Linear;
      scene.fogColor = new Color(e.fog.color[0], e.fog.color[1], e.fog.color[2], 1);
      scene.fogStart = e.fog.start; scene.fogEnd = e.fog.end;
    } else { scene.fogMode = FogMode.None; }

    const token = ++this.envToken;
    if (e.sky.hdri) {
      const path = e.sky.hdri;
      let p = this.hdriCache.get(path);
      if (!p) { p = loadHDRCube(this.engine, path); this.hdriCache.set(path, p); }
      void p.then((cube) => {
        if (token !== this.envToken) return;   // a newer env replaced this one
        this.skyMat.texture = cube;
        this.amb.specularTexture = cube;
        scene.background.mode = BackgroundMode.Sky;
        scene.background.sky.material = this.skyMat;
      }).catch(() => { /* fall back to solid on load failure */ });
    } else {
      this.amb.specularTexture = null as unknown as TextureCube;
      const s = e.sky.solid ?? [0.04, 0.045, 0.05];
      scene.background.mode = BackgroundMode.SolidColor;
      scene.background.solidColor = new Color(s[0], s[1], s[2], 1);
    }
  }

  // ── camera basis + manual projection/picking ───────────────────────────────
  private forward(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }
  private basis(): { f: number[]; r: number[]; u: number[] } {
    const f = this.forward();
    const r = norm([-f[2], 0, f[0]]);   // normalize(cross(f, worldUp))
    const u = norm(cross(r, f));         // camera up
    return { f, r, u };
  }
  private applyCamera(): void {
    const f = this.forward();
    this.camE.transform.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.camE.transform.lookAt(new Vector3(this.pos.x + f[0], this.pos.y + f[1], this.pos.z + f[2]), new Vector3(0, 1, 0));
  }
  private rect(): DOMRect { return this.canvas.getBoundingClientRect(); }

  /** world → overlay pixel; visible=false if behind the camera */
  private project(w: Tuple3): { x: number; y: number; visible: boolean } {
    const { f, r, u } = this.basis();
    const rel = [w[0] - this.pos.x, w[1] - this.pos.y, w[2] - this.pos.z];
    const fz = dot(rel, f);
    if (fz <= 0.02) return { x: 0, y: 0, visible: false };
    const rc = this.rect();
    const aspect = rc.width / rc.height;
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const ndcx = (dot(rel, r) / fz) / (tanF * aspect);
    const ndcy = (dot(rel, u) / fz) / tanF;
    return { x: (ndcx * 0.5 + 0.5) * rc.width, y: (1 - (ndcy * 0.5 + 0.5)) * rc.height, visible: true };
  }

  /** overlay pixel → point on the horizontal plane y=planeY (null if parallel) */
  private groundPoint(px: number, py: number, planeY: number): Tuple3 | null {
    const { f, r, u } = this.basis();
    const rc = this.rect();
    const aspect = rc.width / rc.height;
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const ndcx = (px / rc.width) * 2 - 1;
    const ndcy = 1 - (py / rc.height) * 2;
    const dir = norm([
      f[0] + r[0] * ndcx * tanF * aspect + u[0] * ndcy * tanF,
      f[1] + r[1] * ndcx * tanF * aspect + u[1] * ndcy * tanF,
      f[2] + r[2] * ndcx * tanF * aspect + u[2] * ndcy * tanF,
    ]);
    if (Math.abs(dir[1]) < 1e-4) return null;
    const t = (planeY - this.pos.y) / dir[1];
    if (t <= 0) return null;
    return [this.pos.x + dir[0] * t, planeY, this.pos.z + dir[2] * t];
  }

  // ── overlay + per-frame ────────────────────────────────────────────────────
  private setupOverlay(): void {
    const o = document.createElement("canvas");
    o.className = "viewport-overlay";
    this.canvas.parentElement!.appendChild(o);
    this.overlay = o;
    this.octx = o.getContext("2d")!;
  }

  private frame = (): void => {
    // fly integration
    if (this.flying) {
      const { f, r } = this.basis();
      const dt = 1 / 60;
      const kf = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
      const kr = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      const ku = (this.keys.has("KeyE") ? 1 : 0) - (this.keys.has("KeyQ") ? 1 : 0);
      const sp = this.speed * (this.keys.has("ShiftLeft") ? 2.4 : 1) * dt;
      this.pos.x += (f[0] * kf + r[0] * kr) * sp;
      this.pos.y += (f[1] * kf + ku) * sp;
      this.pos.z += (f[2] * kf + r[2] * kr) * sp;
      if (kf || kr || ku) this.applyCamera();
    }
    // live transform: rebuild at most once per frame so the object follows the drag
    if (this.liveDirty) { this.liveDirty = false; this.renderLive(); }
    this.updatePerf();
    this.drawOverlay();
    requestAnimationFrame(this.frame);
  };

  /** rolling FPS + scene counters, pushed to the toolbar overlay */
  private updatePerf(): void {
    const now = performance.now();
    if (this.lastFrameT) {
      this.frameTimes.push(now - this.lastFrameT);
      if (this.frameTimes.length > 40) this.frameTimes.shift();
    }
    this.lastFrameT = now;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / (this.frameTimes.length || 1);
    this.perf.fps = avg ? Math.round(1000 / avg) : 0;
    this.perf.tris = this.map.tris;
    this.perf.objects = state.map?.objects.length ?? 0;
    this.perf.draws = this.objEntities.reduce((n, e) => n + (e?.length ?? 0), 0);
    this.onPerf?.(this.perf);
  }

  private drawOverlay(): void {
    const rc = this.rect();
    if (this.overlay.width !== Math.round(rc.width) || this.overlay.height !== Math.round(rc.height)) {
      this.overlay.width = Math.round(rc.width); this.overlay.height = Math.round(rc.height);
    }
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const map = state.map; if (!map) return;

    // object markers
    for (let i = 0; i < map.objects.length; i++) {
      const o = map.objects[i];
      const p = this.project(o.at);
      if (!p.visible) continue;
      const selected = state.selIndex === i;
      ctx.beginPath();
      ctx.arc(p.x, p.y, selected ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#f5a623" : markerColor(o.type);
      ctx.globalAlpha = selected ? 1 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // highlight + gizmo on the selected object
    const sel = state.selIndex >= 0 ? map.objects[state.selIndex] : null;
    if (sel) {
      const box = this.objBox(state.selIndex);
      if (box) this.drawHighlight(box);
      this.drawGizmo(sel);
    }
  }

  /** draw a glowing wireframe box around the selected object's world bounds */
  private drawHighlight(b: Box): void {
    const ctx = this.octx;
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const corners: Tuple3[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const pts = corners.map((c) => this.project(c));
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.save();
    ctx.strokeStyle = "#f5a623";
    ctx.shadowColor = "#f5a623"; ctx.shadowBlur = 8;   // glow
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const [a, d] of edges) {
      const pa = pts[a], pb = pts[d];
      if (!pa.visible || !pb.visible) continue;
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── gizmo geometry ─────────────────────────────────────────────────────────
  private static AXES: { h: Handle; dir: Tuple3 }[] = [
    { h: "x", dir: [1, 0, 0] }, { h: "y", dir: [0, 1, 0] }, { h: "z", dir: [0, 0, 1] },
  ];

  /** world length that keeps the gizmo ~constant on-screen size at the object */
  private gizmoLen(at: Tuple3): number {
    const { f } = this.basis();
    const fz = Math.max(0.5, dot([at[0] - this.pos.x, at[1] - this.pos.y, at[2] - this.pos.z], f));
    const rc = this.rect();
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const pixPerWorld = (rc.height / 2) / (tanF * fz);
    return clamp(96 / pixPerWorld, 0.3, 1e5);
  }

  /** N sampled screen points of the rotation ring in the plane ⟂ to `dir` */
  private ring(at: Tuple3, dir: Tuple3, L: number): { x: number; y: number; visible: boolean }[] {
    const u = norm(Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
    const a = norm(cross(dir, u)), b = norm(cross(dir, a));
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const w: Tuple3 = [
        at[0] + (a[0] * Math.cos(t) + b[0] * Math.sin(t)) * L,
        at[1] + (a[1] * Math.cos(t) + b[1] * Math.sin(t)) * L,
        at[2] + (a[2] * Math.cos(t) + b[2] * Math.sin(t)) * L,
      ];
      pts.push(this.project(w));
    }
    return pts;
  }

  private drawGizmo(o: Placement): void {
    const ctx = this.octx;
    const c = this.project(o.at);
    if (!c.visible) return;
    const L = this.gizmoLen(o.at);

    if (this.tool === "rotate") {
      for (const { h, dir } of Viewport.AXES) {
        const pts = this.ring(o.at, dir, L);
        ctx.beginPath();
        let started = false;
        for (const p of pts) { if (!p.visible) { started = false; continue; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
        const on = this.hover === h || this.drag?.handle === h;
        ctx.strokeStyle = on ? "#ffd257" : AXIS_COL[h]; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
      }
    } else {
      for (const { h, dir } of Viewport.AXES) {
        const tip = this.project([o.at[0] + dir[0] * L, o.at[1] + dir[1] * L, o.at[2] + dir[2] * L]);
        if (!tip.visible) continue;
        const on = this.hover === h || this.drag?.handle === h;
        ctx.strokeStyle = on ? "#ffd257" : AXIS_COL[h];
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = on ? 3 : 2;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
        if (this.tool === "move") {  // arrowhead
          const a = Math.atan2(tip.y - c.y, tip.x - c.x);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(tip.x - 9 * Math.cos(a - 0.4), tip.y - 9 * Math.sin(a - 0.4));
          ctx.lineTo(tip.x - 9 * Math.cos(a + 0.4), tip.y - 9 * Math.sin(a + 0.4));
          ctx.closePath(); ctx.fill();
        } else {                     // scale → box handle
          ctx.fillRect(tip.x - 4, tip.y - 4, 8, 8);
        }
      }
      if (this.tool === "scale") {   // centre = uniform scale
        const on = this.hover === "xyz" || this.drag?.handle === "xyz";
        ctx.fillStyle = on ? "#ffd257" : AXIS_COL.xyz;
        ctx.fillRect(c.x - 5, c.y - 5, 10, 10);
      }
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#f5a623"; ctx.fill();
  }

  /** which gizmo handle (if any) is under a screen pixel, for the active tool */
  private pickHandle(px: number, py: number, o: Placement): Handle | null {
    const c = this.project(o.at);
    if (!c.visible) return null;
    const L = this.gizmoLen(o.at);
    let best = 10, hit: Handle | null = null;   // 10px grab radius
    if (this.tool === "rotate") {
      for (const { h, dir } of Viewport.AXES) {
        for (const p of this.ring(o.at, dir, L)) {
          if (!p.visible) continue;
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < best) { best = d; hit = h; }
        }
      }
      return hit;
    }
    for (const { h, dir } of Viewport.AXES) {
      const tip = this.project([o.at[0] + dir[0] * L, o.at[1] + dir[1] * L, o.at[2] + dir[2] * L]);
      if (!tip.visible) continue;
      const d = distToSeg(px, py, c.x, c.y, tip.x, tip.y);
      if (d < best) { best = d; hit = h; }
    }
    if (this.tool === "scale" && Math.hypot(c.x - px, c.y - py) < 9) hit = "xyz";
    return hit;
  }

  // ── input ──────────────────────────────────────────────────────────────────
  private bindInput(): void {
    const ov = this.canvas;
    ov.addEventListener("contextmenu", (e) => e.preventDefault());
    ov.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", () => this.endDrag());
    // Esc (or any external unlock) while dragging → finish the drag cleanly
    document.addEventListener("pointerlockchange", () => {
      if (!document.pointerLockElement && this.dragging) this.endDrag();
    });
    ov.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { f } = this.basis();
      const step = -Math.sign(e.deltaY) * 3;
      this.pos.x += f[0] * step; this.pos.y += f[1] * step; this.pos.z += f[2] * step;
      this.applyCamera();
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      if (isTyping()) return;
      this.keys.add(e.code);
      if (e.code === "KeyW" && !this.flying) this.emitTool("move");   // Unreal-style W/E/R
      else if (e.code === "KeyE" && !this.flying) this.emitTool("rotate");
      else if (e.code === "KeyR" && !this.flying) this.emitTool("scale");
      else if (e.code === "Digit1") this.emitTool("move");
      else if (e.code === "Digit2") this.emitTool("rotate");
      else if (e.code === "Digit3") this.emitTool("scale");
      else if (e.code === "KeyF" && state.selIndex >= 0) { const o = state.map!.objects[state.selIndex]; this.focus(o.at[0], o.at[1], o.at[2]); }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  private toolListeners = new Set<(t: Tool) => void>();
  onToolChange(fn: (t: Tool) => void): void { this.toolListeners.add(fn); }
  private emitTool(t: Tool): void { this.tool = t; for (const fn of this.toolListeners) fn(t); }

  private onDown(e: PointerEvent): void {
    const rc = this.rect();
    this.px = clamp(e.clientX - rc.left, 0, rc.width);
    this.py = clamp(e.clientY - rc.top, 0, rc.height);
    if (e.button === 2) { this.flying = true; this.beginCamera(); return; }  // RMB → fly
    if (e.button !== 0) return;
    const map = state.map; if (!map) return;
    // grabbing a gizmo handle of the current selection starts an axis-locked edit
    const sel = state.selIndex >= 0 ? map.objects[state.selIndex] : null;
    if (sel) { const h = this.pickHandle(this.px, this.py, sel); if (h) { this.beginTransform(h, sel); return; } }
    // otherwise click selects: prefer the 3D model, fall back to the marker dot
    let hit = this.pick3D(this.px, this.py);
    if (hit < 0) hit = this.pick(this.px, this.py);
    state.select(hit);   // -1 → deselect
  }

  /** RMB fly: capture + hide the cursor so it can't leave the viewport */
  private beginCamera(): void {
    this.dragging = true; this.dragKind = "camera";
    this.canvas.style.cursor = "none";
    try { this.canvas.requestPointerLock?.(); } catch { /* not fatal */ }
  }

  /** grab a gizmo handle → snapshot the transform + screen-space axis basis */
  private beginTransform(h: Handle, o: Placement): void {
    const c = this.project(o.at);
    const L = this.gizmoLen(o.at);
    let unit: [number, number] = [1, 0], wpp = 0;
    if (h !== "xyz") {
      const dir = Viewport.AXES.find((a) => a.h === h)!.dir;
      const tip = this.project([o.at[0] + dir[0] * L, o.at[1] + dir[1] * L, o.at[2] + dir[2] * L]);
      const dxp = tip.x - c.x, dyp = tip.y - c.y, len = Math.hypot(dxp, dyp) || 1;
      unit = [dxp / len, dyp / len]; wpp = L / len;
    }
    const startVec: Tuple3 = (this.tool === "move" ? o.at : this.tool === "scale" ? placeScale(o) : placeRot(o)).slice() as Tuple3;
    this.drag = { handle: h, startVec, unit, wpp, cx: c.x, cy: c.y, startAngle: Math.atan2(this.py - c.y, this.px - c.x), startPx: this.px, startPy: this.py };
    this.dragging = true; this.dragKind = "transform";
    this.canvas.style.cursor = "grabbing";
  }

  private onMove(e: PointerEvent): void {
    const rc = this.rect();
    if (!this.dragging) { this.updateHover(e, rc); return; }
    if (this.dragKind === "camera") {
      this.yaw += e.movementX * 0.0032;
      this.pitch = clamp(this.pitch - e.movementY * 0.0032, -1.5, 1.5);
      this.applyCamera();
      return;
    }
    // transform drag: track the real pointer (no lock) and re-solve the handle
    this.px = clamp(e.clientX - rc.left, 0, rc.width);
    this.py = clamp(e.clientY - rc.top, 0, rc.height);
    this.applyTransformDrag();
  }

  /** hover-highlight the handle under the cursor when idle */
  private updateHover(e: PointerEvent, rc: DOMRect): void {
    const inside = e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom;
    const o = inside && state.selIndex >= 0 ? state.map!.objects[state.selIndex] : null;
    if (!o) { if (this.hover) { this.hover = null; this.canvas.style.cursor = ""; } return; }
    this.px = e.clientX - rc.left; this.py = e.clientY - rc.top;
    const h = this.pickHandle(this.px, this.py, o);
    if (h !== this.hover) { this.hover = h; this.canvas.style.cursor = h ? "grab" : ""; }
  }

  private endDrag(): void {
    if (!this.dragging) return;
    const wasTransform = this.dragKind === "transform";
    this.dragging = false; this.dragKind = null; this.flying = false; this.drag = null;
    this.canvas.style.cursor = "";
    if (document.pointerLockElement === this.canvas) { try { document.exitPointerLock?.(); } catch { /* ignore */ } }
    if (wasTransform) this.onEditCommit?.();
  }

  /** nearest object marker to a pixel, within a threshold (−1 if none) */
  private pick(px: number, py: number): number {
    const map = state.map; if (!map) return -1;
    let best = 16 * 16, idx = -1;
    for (let i = 0; i < map.objects.length; i++) {
      const p = this.project(map.objects[i].at);
      if (!p.visible) continue;
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }

  /** axis-constrained edit driven by the snapshot captured in beginTransform */
  private applyTransformDrag(): void {
    const map = state.map; const d = this.drag;
    if (!map || state.selIndex < 0 || !d) return;
    const o = map.objects[state.selIndex];
    const ddx = this.px - d.startPx, ddy = this.py - d.startPy;
    if (this.tool === "move") {
      const along = (ddx * d.unit[0] + ddy * d.unit[1]) * d.wpp;
      const idx = AXIS_IDX[d.handle];
      const at = d.startVec.slice() as Tuple3; at[idx] = round(d.startVec[idx] + along); o.at = at;
    } else if (this.tool === "scale") {
      const sc = d.startVec.slice() as Tuple3;
      if (d.handle === "xyz") { const f = Math.max(0.02, 1 - ddy / 140); for (let i = 0; i < 3; i++) sc[i] = round2(Math.max(0.02, d.startVec[i] * f)); }
      else { const idx = AXIS_IDX[d.handle]; const f = 1 + (ddx * d.unit[0] + ddy * d.unit[1]) / 70; sc[idx] = round2(Math.max(0.02, d.startVec[idx] * f)); }
      o.scale = sc;
    } else {   // rotate
      const ang = Math.atan2(this.py - d.cy, this.px - d.cx);
      const deg = ((ang - d.startAngle) * 180) / Math.PI;
      const idx = AXIS_IDX[d.handle];
      const sign = d.handle === "y" ? -1 : 1;
      const rot = d.startVec.slice() as Tuple3; rot[idx] = round(d.startVec[idx] + deg * sign); o.rot = rot;
    }
    state.touch();
    this.liveDirty = true;   // rebuild on the next frame so the change is visible live
  }

  // ── 3D picking + selection highlight ───────────────────────────────────────
  /** camera ray through an overlay pixel: origin + normalized direction */
  private pixelRay(px: number, py: number): { o: number[]; d: number[] } {
    const { f, r, u } = this.basis();
    const rc = this.rect();
    const aspect = rc.width / rc.height;
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const ndcx = (px / rc.width) * 2 - 1;
    const ndcy = 1 - (py / rc.height) * 2;
    const d = norm([
      f[0] + r[0] * ndcx * tanF * aspect + u[0] * ndcy * tanF,
      f[1] + r[1] * ndcx * tanF * aspect + u[1] * ndcy * tanF,
      f[2] + r[2] * ndcx * tanF * aspect + u[2] * ndcy * tanF,
    ]);
    return { o: [this.pos.x, this.pos.y, this.pos.z], d };
  }

  /** union world-AABB of an object's rendered geometry (null if it has none) */
  private objBox(index: number): Box | null {
    const ents = this.objEntities[index];
    if (!ents || ents.length === 0) return null;
    const box = new BoundingBox();
    let has = false;
    for (const e of ents) {
      if (e.destroyed) continue;
      for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) {
        if (!r.mesh) continue;
        if (!has) { box.copyFrom(r.bounds); has = true; } else BoundingBox.merge(box, r.bounds, box);
      }
    }
    if (!has) return null;
    const { min, max } = box;
    return { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] };
  }

  /** nearest object whose 3D mesh the pixel ray hits (−1 if the ray misses all) */
  private pick3D(px: number, py: number): number {
    const map = state.map; if (!map) return -1;
    const { o, d } = this.pixelRay(px, py);
    let best = Infinity, idx = -1;
    for (let i = 0; i < map.objects.length; i++) {
      const b = this.objBox(i);
      if (!b) continue;
      const t = rayBox(o, d, b);
      if (t !== null && t < best) { best = t; idx = i; }
    }
    return idx;
  }
}

// ── small vector + misc helpers ───────────────────────────────────────────────
function dot(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: number[], b: number[]): number[] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: number[]): number[] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function round(n: number): number { return Math.round(n * 100) / 100; }
function round2(n: number): number { return Math.round(n * 1000) / 1000; }
function isTyping(): boolean { const el = document.activeElement; return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA"); }

/** shortest distance from point (px,py) to the segment (ax,ay)-(bx,by) */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp((wx * vx + wy * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** ray (origin o, dir d) vs AABB — returns entry distance along d, or null if no
 *  hit in front of the ray (slab method). */
function rayBox(o: number[], d: number[], b: Box): number | null {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < b.min[i] || o[i] > b.max[i]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (b.min[i] - o[i]) * inv;
      let t2 = (b.max[i] - o[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0 ? tmin : null;
}

function markerColor(type: string): string {
  if (type === "spawn") return "#4caf50";
  if (type === "pickup") return "#29b6f6";
  if (type === "powerup") return "#ffca28";
  if (type === "sound") return "#ab47bc";
  if (type === "box" || type === "water") return "#78909c";
  return "#cfc3a8";
}
