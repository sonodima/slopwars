// ─── 3D viewport: fly camera + selection + transform gizmos ──────────────────
// Reuses the game's exact rendering stack (GameMap + MapBuilder + the object
// registry + catalog-driven loaders) so the preview is faithful. On top of the
// WebGL canvas sits a 2D overlay canvas that draws object markers and the active
// transform gizmo; all projection/picking math is done manually from the camera
// basis so it doesn't depend on engine screen-space conventions.
import {
  AmbientLight, BackgroundMode, Camera, Color, DirectLight, Entity, Vector3, WebGLEngine,
} from "@galacean/engine";
import type { MapDef, Placement, Tuple3 } from "@slopwars/shared";
import { placeRot, placeScale } from "@slopwars/shared";
import { GameMap } from "@game/map";
import { GameModels, loadModels } from "@game/models";
import { resolveTextures } from "@game/textures";
import "@game/objects"; // side effect: register built-in object types
import { state } from "./state";

export type Tool = "select" | "move" | "rotate" | "scale";

const DEG = Math.PI / 180;

export class Viewport {
  ready = false;
  tool: Tool = "select";
  /** called after a gizmo edit finishes (so the inspector can refresh) */
  onEditCommit: (() => void) | null = null;

  private engine!: WebGLEngine;
  private root!: Entity;
  private camE!: Entity;
  private camera!: Camera;
  private sun!: DirectLight;
  private amb!: AmbientLight;
  private models!: GameModels;
  private map = new GameMap();

  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private octx!: CanvasRenderingContext2D;

  // free-fly camera (position + yaw/pitch), Unreal-style RMB-to-fly
  private pos = new Vector3(0, 24, 52);
  private yaw = 0;      // radians; 0 → looking toward -Z
  private pitch = -0.4;
  private keys = new Set<string>();
  private flying = false;
  private speed = 26;

  // drag state
  private dragging = false;
  private dragKind: "camera" | "transform" | null = null;
  private lastX = 0;
  private lastY = 0;

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

    this.camE = this.root.createChild("camera");
    this.camera = this.camE.addComponent(Camera);
    this.camera.fieldOfView = 55;
    this.camera.nearClipPlane = 0.05;
    this.camera.farClipPlane = 600;

    this.setupOverlay();
    this.models = await loadModels(engine);
    this.bindInput();
    engine.run();
    this.applyCamera();
    this.ready = true;
    requestAnimationFrame(this.frame);
  }

  async render(def: MapDef): Promise<void> {
    if (!this.ready) return;
    const tex = await resolveTextures(this.engine, def.textures);
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.applyEnv(def);
  }

  setTool(t: Tool): void { this.tool = t; }

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

  // ── env ──────────────────────────────────────────────────────────────────
  private applyEnv(def: MapDef): void {
    const scene = this.engine.sceneManager.activeScene;
    const e = def.env;
    this.sun.color = new Color(e.sun.color[0], e.sun.color[1], e.sun.color[2], 1);
    this.sun.entity.transform.setRotation(e.sun.rot[0], e.sun.rot[1], e.sun.rot[2]);
    this.amb.diffuseSolidColor = new Color(e.ambient.color[0], e.ambient.color[1], e.ambient.color[2], 1);
    this.amb.diffuseIntensity = Math.max(0.3, e.ambient.intensity);
    const s = e.sky.solid ?? [0.04, 0.045, 0.05];
    scene.background.mode = BackgroundMode.SolidColor;
    scene.background.solidColor = new Color(s[0], s[1], s[2], 1);
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
    this.drawOverlay();
    requestAnimationFrame(this.frame);
  };

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
      const selected = state.sel.index === i;
      ctx.beginPath();
      ctx.arc(p.x, p.y, selected ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#f5a623" : markerColor(o.type);
      ctx.globalAlpha = selected ? 1 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // gizmo on the selected object
    const sel = state.sel.index >= 0 ? map.objects[state.sel.index] : null;
    if (sel) this.drawGizmo(sel);
  }

  private drawGizmo(o: Placement): void {
    const ctx = this.octx;
    const c = this.project(o.at);
    if (!c.visible) return;
    const axis = (world: Tuple3, color: string): void => {
      const p = this.project(world);
      if (!p.visible) return;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    };
    const L = 2.2;
    if (this.tool === "move" || this.tool === "select") {
      axis([o.at[0] + L, o.at[1], o.at[2]], "#e05a4d");
      axis([o.at[0], o.at[1] + L, o.at[2]], "#7bc043");
      axis([o.at[0], o.at[1], o.at[2] + L], "#4d90e0");
    } else if (this.tool === "rotate") {
      ctx.beginPath(); ctx.arc(c.x, c.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = "#7bc043"; ctx.lineWidth = 2; ctx.stroke();
    } else if (this.tool === "scale") {
      ctx.strokeStyle = "#f5a623"; ctx.lineWidth = 2; ctx.strokeRect(c.x - 9, c.y - 9, 18, 18);
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#f5a623"; ctx.fill();
  }

  // ── input ──────────────────────────────────────────────────────────────────
  private bindInput(): void {
    const ov = this.canvas;
    ov.addEventListener("contextmenu", (e) => e.preventDefault());
    ov.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
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
      if (!this.flying) {
        if (e.code === "KeyQ") this.emitTool("select");
        else if (e.code === "KeyW") this.emitTool("move");
        else if (e.code === "KeyE") this.emitTool("rotate");
        else if (e.code === "KeyR") this.emitTool("scale");
        else if (e.code === "KeyF" && state.sel.index >= 0) { const o = state.map!.objects[state.sel.index]; this.focus(o.at[0], o.at[1], o.at[2]); }
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  private toolListeners = new Set<(t: Tool) => void>();
  onToolChange(fn: (t: Tool) => void): void { this.toolListeners.add(fn); }
  private emitTool(t: Tool): void { this.tool = t; for (const fn of this.toolListeners) fn(t); }

  private onDown(e: PointerEvent): void {
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (e.button === 2) {                    // RMB → fly
      this.flying = true; this.dragging = true; this.dragKind = "camera";
      this.canvas.style.cursor = "none";
      return;
    }
    if (e.button !== 0) return;
    const rc = this.rect();
    const px = e.clientX - rc.left, py = e.clientY - rc.top;
    const hit = this.pick(px, py);
    if (hit >= 0) {
      state.select(hit);
      if (this.tool !== "select") { this.dragging = true; this.dragKind = "transform"; }
    }
  }

  private onMove(e: PointerEvent): void {
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (!this.dragging) return;
    if (this.dragKind === "camera") {
      this.yaw += dx * 0.0032;
      this.pitch = clamp(this.pitch - dy * 0.0032, -1.5, 1.5);
      this.applyCamera();
    } else if (this.dragKind === "transform") {
      this.applyTransformDrag(dx, dy, e);
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 2) { this.flying = false; this.canvas.style.cursor = ""; }
    if (this.dragging && this.dragKind === "transform") this.onEditCommit?.();
    this.dragging = false; this.dragKind = null;
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

  private applyTransformDrag(dx: number, dy: number, e: PointerEvent): void {
    const map = state.map; if (!map || state.sel.index < 0) return;
    const o = map.objects[state.sel.index];
    if (this.tool === "move") {
      if (e.shiftKey) {                       // vertical
        o.at[1] -= dy * 0.05;
      } else {                                // drag on the ground plane at the object's height
        const rc = this.rect();
        const gp = this.groundPoint(e.clientX - rc.left, e.clientY - rc.top, o.at[1]);
        if (gp) { o.at[0] = round(gp[0]); o.at[2] = round(gp[2]); }
      }
      o.at[0] = round(o.at[0]); o.at[1] = round(o.at[1]); o.at[2] = round(o.at[2]);
    } else if (this.tool === "rotate") {
      const rot = placeRot(o).slice() as Tuple3;
      rot[1] = round(rot[1] + dx * 0.9);
      o.rot = rot;
    } else if (this.tool === "scale") {
      const sc = placeScale(o).slice() as Tuple3;
      const k = 1 - dy * 0.01;
      if (e.shiftKey) { sc[1] = round2(Math.max(0.05, sc[1] * k)); }   // Y only
      else for (let i = 0; i < 3; i++) sc[i] = round2(Math.max(0.05, sc[i] * k));
      o.scale = sc;
    }
    state.touch();
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

function markerColor(type: string): string {
  if (type === "spawn") return "#4caf50";
  if (type === "pickup") return "#29b6f6";
  if (type === "powerup") return "#ffca28";
  if (type === "sound") return "#ab47bc";
  if (type === "box" || type === "water" || type === "stairs") return "#78909c";
  return "#cfc3a8";
}
