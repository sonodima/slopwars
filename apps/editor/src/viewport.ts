// ─── 3D viewport: live preview of the edited map ─────────────────────────────
// Reuses the game's exact rendering stack — GameMap + MapBuilder + the object
// registry + the catalog-driven model/texture loaders — so what you see here is
// what the client renders. An orbit camera flies around; the map rebuilds
// whenever the edited MapDef changes.
import {
  AmbientLight, BackgroundMode, Camera, Color, DirectLight, Entity,
  MeshRenderer, PrimitiveMesh, UnlitMaterial, Vector3, WebGLEngine,
} from "@galacean/engine";
import type { MapDef } from "@slopwars/shared";
import { GameMap } from "@game/map";
import { GameModels, loadModels } from "@game/models";
import { resolveTextures } from "@game/textures";
import "@game/objects"; // side effect: register built-in object types

export class Viewport {
  private engine!: WebGLEngine;
  private root!: Entity;
  private camE!: Entity;
  private camera!: Camera;
  private sun!: DirectLight;
  private amb!: AmbientLight;
  private models!: GameModels;
  private map = new GameMap();
  private markerRoot!: Entity;

  // orbit state (spherical around a target)
  private target = new Vector3(0, 2, 0);
  private yaw = 0.7;
  private pitch = 0.5;
  private dist = 55;
  ready = false;

  async init(canvasId: string): Promise<void> {
    const engine = await WebGLEngine.create({ canvas: canvasId });
    this.engine = engine;
    engine.canvas.resizeByClientSize();
    window.addEventListener("resize", () => engine.canvas.resizeByClientSize());

    const scene = engine.sceneManager.activeScene;
    this.root = scene.createRootEntity("root");

    const sunE = this.root.createChild("sun");
    sunE.transform.setRotation(-50, -35, 0);
    this.sun = sunE.addComponent(DirectLight);
    this.sun.color = new Color(1.3, 1.22, 1.05, 1);

    this.amb = scene.ambientLight;
    this.amb.diffuseSolidColor = new Color(0.55, 0.6, 0.72, 1);
    this.amb.diffuseIntensity = 0.7;

    this.camE = this.root.createChild("camera");
    this.camera = this.camE.addComponent(Camera);
    this.camera.fieldOfView = 60;
    this.camera.nearClipPlane = 0.05;
    this.camera.farClipPlane = 400;

    this.markerRoot = this.root.createChild("markers");

    this.models = await loadModels(engine);
    this.bindControls(document.getElementById(canvasId) as HTMLCanvasElement);
    this.applyCamera();
    engine.run();
    this.ready = true;
  }

  /** rebuild the whole world from a MapDef (safe to call on every edit) */
  async render(def: MapDef): Promise<void> {
    if (!this.ready) return;
    const tex = await resolveTextures(this.engine, def.textures);
    this.map.load(this.engine, this.root, tex, this.models, def);
    this.applyEnv(def);
    this.buildMarkers(def);
  }

  private applyEnv(def: MapDef): void {
    const scene = this.engine.sceneManager.activeScene;
    const e = def.env;
    this.sun.color = new Color(e.sun.color[0], e.sun.color[1], e.sun.color[2], 1);
    const [rx, ry, rz] = e.sun.rot;
    this.sun.entity.transform.setRotation(rx, ry, rz);
    this.amb.diffuseSolidColor = new Color(e.ambient.color[0], e.ambient.color[1], e.ambient.color[2], 1);
    this.amb.diffuseIntensity = e.ambient.intensity;
    const s = e.sky.solid ?? [0.06, 0.07, 0.09];
    scene.background.mode = BackgroundMode.SolidColor;
    scene.background.solidColor = new Color(s[0], s[1], s[2], 1);
  }

  /** small colored gizmos for spawns (green) / pickups (cyan) / powerups (gold) */
  private buildMarkers(def: MapDef): void {
    this.markerRoot.destroy();
    this.markerRoot = this.root.createChild("markers");
    const dot = (x: number, y: number, z: number, rgb: [number, number, number], r: number): void => {
      const en = this.markerRoot.createChild("m");
      en.transform.setPosition(x, y, z);
      const mr = en.addComponent(MeshRenderer);
      mr.mesh = PrimitiveMesh.createSphere(this.engine, r, 8);
      const m = new UnlitMaterial(this.engine);
      m.baseColor = new Color(rgb[0], rgb[1], rgb[2], 1);
      mr.setMaterial(m);
    };
    for (const s of def.spawns) dot(s.at[0], this.map.floorY(s.at[0], s.at[1]) + 1, s.at[1], [0.3, 0.9, 0.4], 0.35);
    for (const p of def.pickups) dot(p[0], p[1], p[2], [0.3, 0.8, 0.95], 0.3);
    for (const p of def.powerups) dot(p[0], p[1], p[2], [0.95, 0.8, 0.25], 0.3);
  }

  /** frame the camera on a world point (used when selecting an item) */
  focus(x: number, y: number, z: number): void {
    if (!this.ready) return;
    this.target.set(x, y, z);
    this.applyCamera();
  }

  private applyCamera(): void {
    const cp = Math.max(-1.4, Math.min(1.4, this.pitch));
    const x = this.target.x + this.dist * Math.cos(cp) * Math.sin(this.yaw);
    const y = this.target.y + this.dist * Math.sin(cp);
    const z = this.target.z + this.dist * Math.cos(cp) * Math.cos(this.yaw);
    this.camE.transform.setPosition(x, y, z);
    this.camE.transform.lookAt(this.target, new Vector3(0, 1, 0));
  }

  private bindControls(canvas: HTMLCanvasElement): void {
    let dragging = false, px = 0, py = 0;
    canvas.addEventListener("pointerdown", (e) => { dragging = true; px = e.clientX; py = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.yaw -= (e.clientX - px) * 0.006;
      this.pitch += (e.clientY - py) * 0.006;
      px = e.clientX; py = e.clientY;
      this.applyCamera();
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.max(4, Math.min(220, this.dist * (1 + Math.sign(e.deltaY) * 0.1)));
      this.applyCamera();
    }, { passive: false });
  }
}
