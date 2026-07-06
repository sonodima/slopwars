// ─── Thumbnail renderer: off-screen PBR previews for the asset browser ───────
// A single hidden WebGL engine renders each asset once — a framed glTF model or
// a lit PBR sphere for a texture set — and hands back a data-URL the browser
// drops straight into the asset card. Requests are queued so only one render is
// in flight at a time, and every result is cached by key. Fully guarded: if
// WebGL or a load fails the card simply keeps its icon fallback.
import {
  AmbientLight, BackgroundMode, BoundingBox, Camera, Color, DirectLight, Entity,
  MeshRenderer, PBRMaterial, PrimitiveMesh, Vector3, Vector4, WebGLEngine,
} from "@galacean/engine";
import type { TextureMaps } from "@slopwars/shared";
import { loadGLTF, loadTexture2D } from "@game/assets";

const SIZE = 160;

/** per-category base colour for object primitive thumbnails */
const CAT_RGB: Record<string, [number, number, number]> = {
  geometry: [0.55, 0.58, 0.63], structure: [0.6, 0.5, 0.36], prop: [0.66, 0.6, 0.45],
  entity: [0.7, 0.35, 0.3], marker: [0.3, 0.72, 0.4], sound: [0.6, 0.35, 0.72], light: [0.95, 0.8, 0.4],
};

export class ThumbRenderer {
  private engine: WebGLEngine | null = null;
  private root!: Entity;
  private holder!: Entity;
  private camE!: Entity;
  private camera!: Camera;
  private canvas!: HTMLCanvasElement;
  private cache = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  ok = false;

  async init(): Promise<void> {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      this.canvas = canvas;
      const engine = await WebGLEngine.create({ canvas, graphicDeviceOptions: { preserveDrawingBuffer: true } });
      this.engine = engine;
      engine.canvas.width = SIZE; engine.canvas.height = SIZE;

      const scene = engine.sceneManager.activeScene;
      scene.background.mode = BackgroundMode.SolidColor;
      scene.background.solidColor = new Color(0.078, 0.086, 0.098, 1);
      this.root = scene.createRootEntity("root");

      const key = this.root.createChild("key");
      key.transform.setRotation(-40, -30, 0);
      key.addComponent(DirectLight).color = new Color(1.25, 1.22, 1.15, 1);
      const fill = this.root.createChild("fill");
      fill.transform.setRotation(-8, 150, 0);
      fill.addComponent(DirectLight).color = new Color(0.35, 0.4, 0.5, 1);
      const amb: AmbientLight = scene.ambientLight;
      amb.diffuseSolidColor = new Color(0.5, 0.53, 0.6, 1);
      amb.diffuseIntensity = 1.0;

      this.camE = this.root.createChild("cam");
      this.camera = this.camE.addComponent(Camera);
      this.camera.fieldOfView = 35;
      this.holder = this.root.createChild("holder");
      engine.run();
      this.ok = true;
    } catch (e) { console.warn("thumb renderer init failed", e); this.ok = false; }
  }

  /** framed turntable snapshot of a glTF model */
  modelThumb(gltfPath: string): Promise<string | null> {
    return this.enqueue(`model:${gltfPath}`, async () => {
      const res = await loadGLTF(this.engine!, gltfPath);
      const e = res.instantiateSceneRoot();
      this.holder.addChild(e);
      this.frameEntity(e);
      return this.snapshot();
    });
  }

  /** lit PBR sphere showing a texture set (color/normal/arm) */
  textureThumb(key: string, maps: TextureMaps): Promise<string | null> {
    return this.enqueue(`tex:${key}`, async () => {
      const e = this.holder.createChild("sphere");
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createSphere(this.engine!, 1, 48);
      const m = new PBRMaterial(this.engine!);
      m.tilingOffset = new Vector4(1, 1, 0, 0);
      const [color, normal, arm] = await Promise.all([
        maps.color ? loadTexture2D(this.engine!, maps.color) : null,
        maps.normal ? loadTexture2D(this.engine!, maps.normal) : null,
        maps.arm ? loadTexture2D(this.engine!, maps.arm) : null,
      ]);
      if (color) m.baseTexture = color;
      if (normal) m.normalTexture = normal;
      if (arm) { m.roughnessMetallicTexture = arm; m.occlusionTexture = arm; } else { m.roughness = 0.85; m.metallic = 0; }
      r.setMaterial(m);
      this.camPose(2.7, 0.5, 0.35);
      return this.snapshot();
    });
  }

  /** lit primitive standing in for a placeable object type (cheap, cached by
   *  name): a sphere for point-like markers/lights/sounds, a cube otherwise. */
  objectThumb(name: string, category: string): Promise<string | null> {
    return this.enqueue(`obj:${name}`, async () => {
      const e = this.holder.createChild("obj");
      const r = e.addComponent(MeshRenderer);
      const point = category === "marker" || category === "sound" || category === "light";
      r.mesh = point ? PrimitiveMesh.createSphere(this.engine!, 0.9, 32) : PrimitiveMesh.createCuboid(this.engine!, 1.4, 1.4, 1.4);
      const m = new PBRMaterial(this.engine!);
      const [cr, cg, cb] = CAT_RGB[category] ?? [0.72, 0.7, 0.62];
      m.baseColor = new Color(cr, cg, cb, 1);
      m.roughness = 0.7; m.metallic = category === "entity" ? 0.6 : 0.05;
      r.setMaterial(m);
      this.camPose(point ? 2.6 : 3.4, 0.62, 0.42);
      return this.snapshot();
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────
  /** serialize renders (one engine, one framebuffer) and memoize by key */
  private enqueue(key: string, run: () => Promise<string | null>): Promise<string | null> {
    if (!this.engine) return Promise.resolve(null);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const task = this.queue.then(async () => {
      const cached = this.cache.get(key);
      if (cached) return cached;
      this.holder.clearChildren();
      try {
        const url = await run();
        if (url) this.cache.set(key, url);
        return url;
      } catch (e) { console.warn("thumb render failed", key, e); return null; }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async snapshot(): Promise<string> {
    await this.frames(2);
    return this.canvas.toDataURL("image/png");
  }

  private frames(n: number): Promise<void> {
    return new Promise((resolve) => {
      const tick = (): void => { if (--n <= 0) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  private frameEntity(e: Entity): void {
    const rs = e.getComponentsIncludeChildren(MeshRenderer, []);
    const box = new BoundingBox();
    let has = false;
    for (const r of rs) { if (!r.mesh) continue; if (!has) { box.copyFrom(r.bounds); has = true; } else BoundingBox.merge(box, r.bounds, box); }
    let size = 2;
    if (has) {
      const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
      e.transform.setPosition(-cx, -cy, -cz);
      size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 1;
    }
    this.camPose(size * 2.0, 0.55, 0.4);
  }

  /** orbit the camera around the origin at `dist`, yaw/pitch in radians */
  private camPose(dist: number, yaw: number, pitch: number): void {
    const cp = Math.cos(pitch);
    this.camE.transform.setPosition(dist * cp * Math.sin(yaw), dist * Math.sin(pitch), dist * cp * Math.cos(yaw));
    this.camE.transform.lookAt(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
  }
}
