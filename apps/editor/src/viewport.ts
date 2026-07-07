// ─── 3D viewport: fly camera + selection + transform gizmos ──────────────────
// Reuses the game's exact rendering stack (GameMap + MapBuilder + the object
// registry + catalog-driven loaders) so the preview is faithful. On top of the
// WebGL canvas sits a 2D overlay canvas that draws object markers and the active
// transform gizmo; all projection/picking math is done manually from the camera
// basis so it doesn't depend on engine screen-space conventions.
import {
  AmbientLight, BackgroundMode, BloomEffect, BoundingBox, Camera, Color, CompareFunction, DirectLight, Entity,
  FogMode, MeshRenderer, MSAASamples, PostProcess, PrimitiveMesh, RenderFace, RenderQueueType,
  SkyBoxMaterial, TextureCube, TonemappingEffect, TonemappingMode, UnlitMaterial, Vector3, WebGLEngine,
} from "@galacean/engine";
import type { MapDef, Placement, ShadowQuality, Tuple3 } from "@slopwars/shared";
import { envSunColor, placeRot, placeScale } from "@slopwars/shared";
import { applyFogFalloff, applyPost, applyShadows } from "@game/rendersettings";
import { GameMap } from "@game/map";
import { GameModels, loadModels } from "@game/models";
import { resolveTextures, type MapTextures } from "@game/textures";
import { mapTextureFolders, objectCategory } from "@game/objects";
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
const AXIS_DIR: Record<Handle, Tuple3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], xyz: [0, 0, 0] };

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
  private bloom!: BloomEffect;
  private tone!: TonemappingEffect;
  // viewport quality ceiling (from the Graphics dropdown); caps the map's shadows
  private cap: ShadowQuality = "ultra";
  private hdriCache = new Map<string, Promise<TextureCube>>();
  private models!: GameModels;
  private map = new GameMap();

  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private octx!: CanvasRenderingContext2D;

  // per-object-index → entities produced for it (for 3D picking + highlighting)
  private objEntities: Entity[][] = [];
  // selection outline: inverted-hull "shell" entities cloned from the selected
  // meshes (see refreshHighlight). Rebuilt whenever the selection or scene changes.
  private outlineEntities: Entity[] = [];
  private outlineCore: UnlitMaterial | null = null;
  private outlineGlow: UnlitMaterial | null = null;
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
  // snapshot captured when a gizmo handle is grabbed; drives axis-constrained edits.
  // `members` is every selected object (start transforms) so a group moves/scales/
  // rotates together around the shared `pivot`.
  private drag: {
    handle: Handle;
    pivot: Tuple3;             // gizmo centre in world (selection centroid)
    members: { o: Placement; at: Tuple3; rot: Tuple3; scale: Tuple3 }[];
    unit: [number, number];    // screen-space axis direction (unit)
    wpp: number;               // world units per screen pixel along the axis
    cx: number; cy: number;    // gizmo centre in screen px
    startAngle: number;        // pointer angle around centre (rotate)
    startPx: number; startPy: number;
    rvec: number[]; uvec: number[]; pwpp: number;   // camera right/up + world/px, for screen-plane (xyz) moves
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
    // preserveDrawingBuffer lets the MCP bridge read the canvas back as a PNG
    const engine = await WebGLEngine.create({ canvas: this.canvas, graphicDeviceOptions: { preserveDrawingBuffer: true } });
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
    // HDRI skybox shell — the sky needs BOTH a material and a mesh to render;
    // without the cube mesh the sky is simply never drawn (why it looked absent).
    this.skyMat = new SkyBoxMaterial(engine);
    this.skyMat.textureDecodeRGBM = true;
    scene.background.sky.material = this.skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);

    this.camE = this.root.createChild("camera");
    this.camera = this.camE.addComponent(Camera);
    this.camera.fieldOfView = 55;
    this.camera.nearClipPlane = 0.05;
    this.camera.farClipPlane = 600;
    this.camera.opaqueTextureEnabled = true;   // transmissive water refracts the scene
    this.camera.enableHDR = true;
    this.camera.enablePostProcess = true;      // bloom + tonemapping, like the game
    this.camera.msaaSamples = MSAASamples.FourX;

    // post stack — its bloom/tonemapping params are set per-map from env.post
    const pp = this.root.createChild("post").addComponent(PostProcess);
    this.bloom = pp.addEffect(BloomEffect);
    this.bloom.enabled = true;
    this.tone = pp.addEffect(TonemappingEffect);
    this.tone.enabled = true;
    this.tone.mode.value = TonemappingMode.ACES;

    this.setupOverlay();
    this.models = await loadModels(engine);
    this.bindInput();
    this.bindResize();
    // selection changes (viewport or outliner) restyle the 3D outline without a
    // full scene rebuild — cheap, since only the selected meshes get a shell.
    state.onSelect(() => this.refreshHighlight());
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
    this.outlineEntities = [];   // torn down with the old map root; drop stale refs
    this.map.onBuildEntity = (i, e) => { (this.objEntities[i] ??= []).push(e); };
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.applyEnv(def);
    this.refreshHighlight();     // re-attach the selection outline to fresh entities
  }

  /** immediate re-render during a drag (textures already cached from render()) */
  private renderLive(): void {
    if (!this.ready || !this.texCache || !state.map) return;
    this.rebuild(state.map, this.texCache);
  }

  setTool(t: Tool): void { this.tool = t; }

  /** editor-only viewport-quality preset. Not persisted and independent of the
   *  map: it's a *ceiling* on the map's authored shadow tier (+ toggles the pricey
   *  camera features), so you can preview a heavy map cheaply. The map's env still
   *  owns the actual look. */
  setGraphics(preset: "low" | "medium" | "high"): void {
    if (!this.sun) return;
    this.cap = preset === "low" ? "off" : preset === "medium" ? "medium" : "ultra";
    this.camera.enableHDR = preset !== "low";
    this.camera.enablePostProcess = preset !== "low";
    if (state.map) applyShadows(this.engine.sceneManager.activeScene, this.sun, state.map.env, this.cap);
  }

  /** ground point (y=0) under a client pixel — for drag-drop placement */
  dropGround(clientX: number, clientY: number): Tuple3 | null {
    const rc = this.rect();
    return this.groundPoint(clientX - rc.left, clientY - rc.top, 0);
  }

  /** best drop point under a client pixel: the nearest surface the ray hits
   *  (so objects land on top of desks/crates/etc.), falling back to the ground
   *  plane when the ray misses all geometry. */
  dropSurface(clientX: number, clientY: number): Tuple3 | null {
    const rc = this.rect();
    const px = clientX - rc.left, py = clientY - rc.top;
    const map = state.map;
    if (map) {
      const { o, d } = this.pixelRay(px, py);
      let best = Infinity, hit: Tuple3 | null = null;
      for (let i = 0; i < map.objects.length; i++) {
        const b = this.objBox(i);
        if (!b) continue;
        const t = rayBox(o, d, b);
        if (t !== null && t < best) { best = t; hit = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]; }
      }
      if (hit) return [round(hit[0]), round(hit[1]), round(hit[2])];
    }
    return this.groundPoint(px, py, 0);
  }

  /** frame the camera on a world point; `dist` sizes the pull-back */
  focus(x: number, y: number, z: number, dist = 14): void {
    if (!this.ready) return;
    this.pos.set(x + dist, y + dist * 0.85, z + dist);
    const dx = x - this.pos.x, dy = y - this.pos.y, dz = z - this.pos.z;
    this.yaw = Math.atan2(dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.applyCamera();
  }

  /** centre the camera on the current selection (used when picking in the
   *  outliner) — frames the object's bounds so it fills a comfortable view. */
  focusSelected(): void {
    const map = state.map;
    if (!map || state.selIndex < 0) return;
    const o = map.objects[state.selIndex];
    const b = this.objBox(state.selIndex);
    if (b) {
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const radius = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      this.focus(cx, cy, cz, Math.max(6, radius * 2.4));
    } else {
      this.focus(o.at[0], o.at[1], o.at[2], 10);
    }
  }

  // ── programmatic camera + capture (used by the MCP bridge) ─────────────────
  /** current camera pose for tools to read back */
  cameraState(): { pos: Tuple3; yaw: number; pitch: number } {
    return { pos: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, pitch: this.pitch };
  }
  /** set the camera pose absolutely (any field optional) */
  setCamera(pos?: Tuple3, yaw?: number, pitch?: number): void {
    if (pos) this.pos.set(pos[0], pos[1], pos[2]);
    if (typeof yaw === "number") this.yaw = yaw;
    if (typeof pitch === "number") this.pitch = clamp(pitch, -1.5, 1.5);
    this.applyCamera();
  }
  /** rotate (orbit look) the camera by deltas in radians, and/or dolly forward */
  moveCamera(dYaw = 0, dPitch = 0, dolly = 0): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -1.5, 1.5);
    if (dolly) { const f = this.forward(); this.pos.x += f[0] * dolly; this.pos.y += f[1] * dolly; this.pos.z += f[2] * dolly; }
    this.applyCamera();
  }
  /** PNG data-URL of the current viewport (needs preserveDrawingBuffer) */
  screenshot(): string | null {
    try { return this.canvas.toDataURL("image/png"); } catch { return null; }
  }

  // ── env (mirrors the game's applyEnv so the preview is faithful) ───────────
  private envToken = 0;   // guards against a stale HDRI load applying out of order
  private applyEnv(def: MapDef): void {
    const scene = this.engine.sceneManager.activeScene;
    const e = def.env;
    const sc = envSunColor(e);
    this.sun.color = new Color(sc[0], sc[1], sc[2], 1);
    this.sun.entity.transform.setRotation(e.sun.rot[0], e.sun.rot[1], e.sun.rot[2]);
    this.amb.diffuseSolidColor = new Color(e.ambient.color[0], e.ambient.color[1], e.ambient.color[2], 1);
    this.amb.diffuseIntensity = Math.max(0.05, e.ambient.intensity);
    this.amb.specularIntensity = e.ambient.specular ?? 0.85;

    applyShadows(scene, this.sun, e, this.cap);   // quality clamped to the viewport preset
    applyPost(e, this.bloom, this.tone);          // tonemapping + bloom
    if (e.fog) applyFogFalloff(scene, e.fog);
    else scene.fogMode = FogMode.None;

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
      const selected = state.isSelected(o);
      ctx.beginPath();
      ctx.arc(p.x, p.y, selected ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#f5a623" : markerColor(o.type);
      ctx.globalAlpha = selected ? 1 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // (selection is highlighted in 3D by refreshHighlight — see below)
    // a single transform gizmo at the selection pivot
    const pivot = this.selPivot();
    if (pivot) this.drawGizmo(pivot);
  }

  /** gizmo pivot = centroid of the selected objects' positions (null if none) */
  private selPivot(): Tuple3 | null {
    const sel = state.selectedObjects();
    if (!sel.length) return null;
    let x = 0, y = 0, z = 0;
    for (const o of sel) { x += o.at[0]; y += o.at[1]; z += o.at[2]; }
    return [x / sel.length, y / sel.length, z / sel.length];
  }

  /** outermost ancestor group id of a group (for click-selects-whole-group) */
  private topGroup(id: string): string {
    let g = state.groupById(id); let top = id;
    while (g?.parent) { top = g.parent; g = state.groupById(g.parent); }
    return top;
  }

  // ── selection highlight: 3D inverted-hull outline ──────────────────────────
  // A selected mesh gets a cloned "shell": the same geometry, slightly enlarged,
  // rendered back-faces-only in an unlit amber. The crisp core shell is depth-
  // tested, so where it pokes past the real object's silhouette it reads as an
  // outline hugging the mesh. The larger translucent glow shell instead ignores
  // depth entirely (compareFunction Always) and draws last, so the selection stays
  // visible as a soft amber halo even when the object is behind walls or other
  // objects — you never lose track of what's selected.
  private static SHELL = "__sel_outline";

  /** the two shared outline materials (created lazily on first selection) */
  private outlineMaterials(): [UnlitMaterial, UnlitMaterial] {
    if (!this.outlineCore) {
      const core = new UnlitMaterial(this.engine);
      core.baseColor = new Color(1.0, 0.6, 0.12, 1);
      core.renderFace = RenderFace.Back;
      this.outlineCore = core;
      const glow = new UnlitMaterial(this.engine);
      glow.baseColor = new Color(1.0, 0.66, 0.2, 0.32);
      glow.renderFace = RenderFace.Back;
      glow.isTransparent = true;
      // see-through: always pass depth (draw through occluders) and don't write
      // depth; forced into the transparent queue so it draws after opaque scene.
      glow.renderState.depthState.compareFunction = CompareFunction.Always;
      glow.renderState.depthState.writeEnabled = false;
      glow.renderState.renderQueueType = RenderQueueType.Transparent;
      this.outlineGlow = glow;
    }
    return [this.outlineCore, this.outlineGlow!];
  }

  /** rebuild the outline shells for the current selection */
  private refreshHighlight(): void {
    if (!this.ready) return;
    for (const e of this.outlineEntities) if (!e.destroyed) e.destroy();
    this.outlineEntities = [];
    const map = state.map; if (!map) return;
    const sel = state.selectedObjects();
    if (!sel.length) return;

    const [core, glow] = this.outlineMaterials();
    for (const o of sel) {
      const ents = this.objEntities[map.objects.indexOf(o)];
      if (!ents) continue;
      for (const e of ents) {
        if (e.destroyed) continue;
        for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) {
          if (!r.mesh || r.entity.name === Viewport.SHELL) continue;
          this.addShell(r, 1.03, core, 0);
          this.addShell(r, 1.09, glow, 1000);   // high priority → drawn on top / through
        }
      }
    }
  }

  /** clone a mesh renderer into an enlarged, unlit "shell" child for the outline.
   *  `priority` orders draws — the see-through glow uses a high value so it renders
   *  last, on top of the rest of the scene. */
  private addShell(src: MeshRenderer, factor: number, mat: UnlitMaterial, priority: number): void {
    const s = src.entity.createChild(Viewport.SHELL);
    s.transform.setScale(factor, factor, factor);
    const r = s.addComponent(MeshRenderer);
    r.mesh = src.mesh;
    r.setMaterial(mat);
    r.castShadows = false;
    r.receiveShadows = false;
    r.priority = priority;
    this.outlineEntities.push(s);
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

  private drawGizmo(pivot: Tuple3): void {
    const ctx = this.octx;
    const c = this.project(pivot);
    if (!c.visible) return;
    const L = this.gizmoLen(pivot);

    if (this.tool === "rotate") {
      for (const { h, dir } of Viewport.AXES) {
        const pts = this.ring(pivot, dir, L);
        ctx.beginPath();
        let started = false;
        for (const p of pts) { if (!p.visible) { started = false; continue; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
        const on = this.hover === h || this.drag?.handle === h;
        ctx.strokeStyle = on ? "#ffd257" : AXIS_COL[h]; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
      }
    } else {
      for (const { h, dir } of Viewport.AXES) {
        const tip = this.project([pivot[0] + dir[0] * L, pivot[1] + dir[1] * L, pivot[2] + dir[2] * L]);
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
      } else if (this.tool === "move") {   // centre = screen-plane move (all axes)
        const on = this.hover === "xyz" || this.drag?.handle === "xyz";
        ctx.beginPath(); ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = on ? "#ffd257" : AXIS_COL.xyz; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
      }
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#f5a623"; ctx.fill();
  }

  /** which gizmo handle (if any) is under a screen pixel, for the active tool */
  private pickHandle(px: number, py: number, pivot: Tuple3): Handle | null {
    const c = this.project(pivot);
    if (!c.visible) return null;
    const L = this.gizmoLen(pivot);
    let best = 10, hit: Handle | null = null;   // 10px grab radius
    if (this.tool === "rotate") {
      for (const { h, dir } of Viewport.AXES) {
        for (const p of this.ring(pivot, dir, L)) {
          if (!p.visible) continue;
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < best) { best = d; hit = h; }
        }
      }
      return hit;
    }
    for (const { h, dir } of Viewport.AXES) {
      const tip = this.project([pivot[0] + dir[0] * L, pivot[1] + dir[1] * L, pivot[2] + dir[2] * L]);
      if (!tip.visible) continue;
      const d = distToSeg(px, py, c.x, c.y, tip.x, tip.y);
      if (d < best) { best = d; hit = h; }
    }
    // centre handle → all-axes (screen-plane move / uniform scale)
    if ((this.tool === "scale" || this.tool === "move") && Math.hypot(c.x - px, c.y - py) < 9) hit = "xyz";
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
    const pivot = this.selPivot();
    if (pivot) { const h = this.pickHandle(this.px, this.py, pivot); if (h) { this.beginTransform(h); return; } }
    // otherwise click selects: prefer the 3D model, fall back to the marker dot
    let hit = this.pick3D(this.px, this.py);
    if (hit < 0) hit = this.pick(this.px, this.py);
    if (hit < 0) { state.select(-1, "viewport"); return; }
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;   // toggle in a multi-select
    if (additive) { state.select(hit, "viewport", true); return; }
    // a plain click on a grouped object selects the whole (top-level) group so it
    // moves together; Alt-click drills in to the single object.
    const o = map.objects[hit];
    if (o.group && !e.altKey) state.selectGroup(this.topGroup(o.group), "viewport");
    else state.select(hit, "viewport");
  }

  /** RMB fly: capture + hide the cursor so it can't leave the viewport */
  private beginCamera(): void {
    this.dragging = true; this.dragKind = "camera";
    this.canvas.style.cursor = "none";
    try { this.canvas.requestPointerLock?.(); } catch { /* not fatal */ }
  }

  /** grab a gizmo handle → snapshot the pivot, every selected object's transform,
   *  and the screen-space axis basis (so a group edits together) */
  private beginTransform(h: Handle): void {
    const pivot = this.selPivot();
    if (!pivot) return;
    const c = this.project(pivot);
    const L = this.gizmoLen(pivot);
    let unit: [number, number] = [1, 0], wpp = 0;
    if (h !== "xyz") {
      const dir = Viewport.AXES.find((a) => a.h === h)!.dir;
      const tip = this.project([pivot[0] + dir[0] * L, pivot[1] + dir[1] * L, pivot[2] + dir[2] * L]);
      const dxp = tip.x - c.x, dyp = tip.y - c.y, len = Math.hypot(dxp, dyp) || 1;
      unit = [dxp / len, dyp / len]; wpp = L / len;
    }
    // screen-plane basis for the centre (xyz) move handle: camera right/up in
    // world + world-units-per-screen-pixel at the pivot's depth
    const { r, u, f } = this.basis();
    const fz = Math.max(0.5, dot([pivot[0] - this.pos.x, pivot[1] - this.pos.y, pivot[2] - this.pos.z], f));
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const pwpp = (2 * tanF * fz) / this.rect().height;
    const members = state.selectedObjects().map((o) => ({
      o, at: o.at.slice() as Tuple3, rot: placeRot(o).slice() as Tuple3, scale: placeScale(o).slice() as Tuple3,
    }));
    this.drag = { handle: h, pivot, members, unit, wpp, cx: c.x, cy: c.y, startAngle: Math.atan2(this.py - c.y, this.px - c.x), startPx: this.px, startPy: this.py, rvec: r, uvec: u, pwpp };
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
    const pivot = inside ? this.selPivot() : null;
    if (!pivot) { if (this.hover) { this.hover = null; this.canvas.style.cursor = ""; } return; }
    this.px = e.clientX - rc.left; this.py = e.clientY - rc.top;
    const h = this.pickHandle(this.px, this.py, pivot);
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

  /** axis-constrained edit driven by the snapshot captured in beginTransform.
   *  Every selected object transforms about the shared pivot, so a group moves/
   *  scales/rotates as one; for a single object it reduces to the classic behaviour
   *  (pivot = the object, so scale/rotate don't shift its position). */
  private applyTransformDrag(): void {
    const d = this.drag;
    if (!d || !d.members.length) return;
    const ddx = this.px - d.startPx, ddy = this.py - d.startPy;

    if (this.tool === "move") {
      let disp: Tuple3;
      if (d.handle === "xyz") {
        disp = [d.rvec[0] * ddx * d.pwpp - d.uvec[0] * ddy * d.pwpp, d.rvec[1] * ddx * d.pwpp - d.uvec[1] * ddy * d.pwpp, d.rvec[2] * ddx * d.pwpp - d.uvec[2] * ddy * d.pwpp];
      } else {
        const along = (ddx * d.unit[0] + ddy * d.unit[1]) * d.wpp;
        const dir = AXIS_DIR[d.handle];
        disp = [dir[0] * along, dir[1] * along, dir[2] * along];
      }
      for (const m of d.members) m.o.at = [round(m.at[0] + disp[0]), round(m.at[1] + disp[1]), round(m.at[2] + disp[2])];
    } else if (this.tool === "scale") {
      if (d.handle === "xyz") {
        const f = Math.max(0.02, 1 - ddy / 140);
        for (const m of d.members) {
          m.o.scale = [round2(Math.max(0.02, m.scale[0] * f)), round2(Math.max(0.02, m.scale[1] * f)), round2(Math.max(0.02, m.scale[2] * f))];
          m.o.at = [round(d.pivot[0] + (m.at[0] - d.pivot[0]) * f), round(d.pivot[1] + (m.at[1] - d.pivot[1]) * f), round(d.pivot[2] + (m.at[2] - d.pivot[2]) * f)];
        }
      } else {
        const idx = AXIS_IDX[d.handle];
        const f = 1 + (ddx * d.unit[0] + ddy * d.unit[1]) / 70;
        for (const m of d.members) {
          const sc = m.scale.slice() as Tuple3; sc[idx] = round2(Math.max(0.02, m.scale[idx] * f)); m.o.scale = sc;
          const at = m.at.slice() as Tuple3; at[idx] = round(d.pivot[idx] + (m.at[idx] - d.pivot[idx]) * f); m.o.at = at;
        }
      }
    } else {   // rotate
      const ang = Math.atan2(this.py - d.cy, this.px - d.cx);
      const deg = ((ang - d.startAngle) * 180) / Math.PI;
      const idx = AXIS_IDX[d.handle];
      const sign = d.handle === "y" ? -1 : 1;
      const sdeg = deg * sign, rad = sdeg * DEG;
      for (const m of d.members) {
        const rel: Tuple3 = [m.at[0] - d.pivot[0], m.at[1] - d.pivot[1], m.at[2] - d.pivot[2]];
        const rr = rotateAxis(rel, idx, rad);
        m.o.at = [round(d.pivot[0] + rr[0]), round(d.pivot[1] + rr[1]), round(d.pivot[2] + rr[2])];
        const rot = m.rot.slice() as Tuple3; rot[idx] = round(m.rot[idx] + sdeg); m.o.rot = rot;
      }
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
        if (!r.mesh || r.entity.name === Viewport.SHELL) continue;   // ignore outline shells
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
/** rotate a vector about world axis `idx` (0=x,1=y,2=z) by `rad` (right-handed) */
function rotateAxis(v: Tuple3, idx: number, rad: number): Tuple3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  if (idx === 0) return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  if (idx === 1) return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}
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
  // lights (point/dir/spot/lantern) glow yellow so they read at a glance even
  // though the light itself has no mesh to click in 3D — only this marker dot.
  if (objectCategory(type) === "light") return "#ffd54f";
  return "#cfc3a8";
}
