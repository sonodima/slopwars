// ─── Thumbnail renderer: off-screen PBR previews for the asset browser ───────
// A single hidden WebGL engine renders each asset once and hands back a data-URL
// the browser drops straight into the asset card:
//   • models      → a framed turntable snapshot of the glTF
//   • textures    → a lit PBR sphere showing the color/normal/arm set
//   • objects     → the REAL geometry the object type builds (reusing the game's
//                   MapBuilder + models + textures), so a crate looks like a
//                   crate and a column like a column — not a placeholder box.
// Requests are queued so only one render is in flight at a time, results are
// cached by key, and every path is guarded: if WebGL or a load fails the card
// simply keeps its icon fallback. All work waits on a `ready` promise so requests
// issued before the engine finishes initialising still render (previously they
// silently resolved null, which is why thumbnails only appeared after a search
// re-triggered the draw).
import {
  AmbientLight, BackgroundMode, BoundingBox, Camera, Color, DirectLight, Entity,
  MeshRenderer, PBRMaterial, PrimitiveMesh, Vector3, Vector4, WebGLEngine,
} from "@galacean/engine";
import type { MapDef, TextureMaps } from "@slopwars/shared";
import catalog from "virtual:asset-catalog";
import { loadGLTF, loadTexture2D } from "@game/assets";
import { GameMap } from "@game/map";
import { loadModels, type GameModels } from "@game/models";
import { mapTextureFolders } from "@game/objects";
import { DEFAULT_FOLDER, type MapTextures, type PbrSet } from "@game/textures";

const SIZE = 160;
const FOV = 32;
const FOV_TAN = Math.tan((FOV * Math.PI) / 180 / 2);

/** per-category base colour for the point-marker fallback previews */
const CAT_RGB: Record<string, [number, number, number]> = {
  geometry: [0.55, 0.58, 0.63], structure: [0.6, 0.5, 0.36], prop: [0.66, 0.6, 0.45],
  entity: [0.7, 0.35, 0.3], marker: [0.3, 0.72, 0.4], sound: [0.6, 0.35, 0.72], light: [0.95, 0.8, 0.4],
};
/** point-like markers with no build geometry keep a small primitive stand-in */
const POINT_CATEGORIES = new Set(["marker", "sound"]);
/** minimal env for object builds (no fog / sky work — geometry only) */
const THUMB_ENV: MapDef["env"] = {
  sky: { solid: [0.078, 0.086, 0.098] }, fog: null,
  ambient: { color: [0.6, 0.62, 0.68], intensity: 0.9, specular: 0.85 },
  sun: { rot: [-40, -30, 0], color: [1.2, 1.15, 1.0], strength: 0.9 },
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
  private ready: Promise<void>;
  private markReady!: () => void;
  // lazy, engine-local model + texture caches (kept off the game's shared caches,
  // which are bound to the viewport engine and must not cross into this one)
  private modelsP: Promise<GameModels> | null = null;
  private texByName = new Map(catalog.textures.map((t) => [t.name, t]));
  private setCache = new Map<string, Promise<PbrSet>>();
  ok = false;

  constructor() {
    this.ready = new Promise((res) => { this.markReady = res; });
  }

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
      this.camera.fieldOfView = FOV;
      this.holder = this.root.createChild("holder");
      engine.run();
      this.ok = true;
    } catch (e) { console.warn("thumb renderer init failed", e); this.ok = false; }
    this.markReady();   // unblock queued requests (they null-guard on `engine`)
  }

  /** framed turntable snapshot of a glTF model */
  modelThumb(gltfPath: string): Promise<string | null> {
    return this.enqueue(`model:${gltfPath}`, async () => {
      const res = await loadGLTF(this.engine!, gltfPath);
      const e = res.instantiateSceneRoot();
      this.holder.addChild(e);
      this.frame(this.holder, 0.55, 0.42);
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
      // sphere radius 1 → fit its full diameter with margin so it never clips
      this.camPose(this.fitDist(1, 1.35), 0.5, 0.32);
      return this.snapshot();
    });
  }

  /** the object type's REAL built geometry (crate/desk/column/box/…), rendered
   *  by running it through the game's MapBuilder in this engine. Point markers
   *  (spawns/pickups/sounds) have no geometry and keep a small primitive. */
  objectThumb(name: string, category: string): Promise<string | null> {
    return this.enqueue(`obj:${name}`, async () => {
      if (!POINT_CATEGORIES.has(category)) {
        const built = await this.buildObjectThumb(name);
        if (built) return built;   // fell through to primitive if it produced no mesh
      }
      return this.primitiveThumb(name, category);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────
  /** run an object type's build() into `holder`; null if it made no geometry */
  private async buildObjectThumb(name: string): Promise<string | null> {
    const models = await this.thumbModels();
    const def: MapDef = { meta: { id: "thumb", name: "", theme: "" }, env: THUMB_ENV, objects: [{ type: name, at: [0, 0, 0] }] };
    const tex = await this.resolveTex(mapTextureFolders(def));
    const gm = new GameMap();
    gm.load(this.engine!, this.holder, tex, models, def);
    for (const s of gm.sounds) { try { s.el.pause(); } catch { /* ignore */ } }   // never audition in a thumb
    if (this.holder.getComponentsIncludeChildren(MeshRenderer, []).length === 0) return null;
    this.frame(this.holder, 0.6, 0.5);
    return this.snapshot();
  }

  /** cheap lit primitive standing in for a point-like object type */
  private async primitiveThumb(name: string, category: string): Promise<string | null> {
    const e = this.holder.createChild("obj");
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createSphere(this.engine!, 0.85, 32);
    const m = new PBRMaterial(this.engine!);
    const [cr, cg, cb] = CAT_RGB[category] ?? [0.72, 0.7, 0.62];
    m.baseColor = new Color(cr, cg, cb, 1);
    m.roughness = 0.7; m.metallic = 0.05;
    r.setMaterial(m);
    void name;
    this.camPose(this.fitDist(0.85, 1.4), 0.62, 0.42);
    return this.snapshot();
  }

  private thumbModels(): Promise<GameModels> {
    return (this.modelsP ??= loadModels(this.engine!));
  }

  // engine-local texture loading (mirrors game/textures but bound to THIS engine)
  private pathFor(folder: string, slot: "color" | "normal" | "arm"): string {
    return this.texByName.get(folder)?.maps[slot] ?? this.texByName.get(DEFAULT_FOLDER)?.maps[slot] ?? `textures/${folder}/${slot}.jpg`;
  }
  private loadSet(folder: string): Promise<PbrSet> {
    const key = this.texByName.has(folder) ? folder : DEFAULT_FOLDER;
    let p = this.setCache.get(key);
    if (!p) {
      p = (async (): Promise<PbrSet> => {
        const [color, normal, arm] = await Promise.all([
          loadTexture2D(this.engine!, this.pathFor(key, "color")),
          loadTexture2D(this.engine!, this.pathFor(key, "normal")),
          loadTexture2D(this.engine!, this.pathFor(key, "arm")),
        ]);
        return { color, normal, arm };
      })();
      this.setCache.set(key, p);
    }
    return p;
  }
  private async resolveTex(folders: string[]): Promise<MapTextures> {
    const list = [...new Set<string>([DEFAULT_FOLDER, ...folders])];
    const sets = await Promise.all(list.map((f) => this.loadSet(f)));
    const out: MapTextures = new Map();
    list.forEach((f, i) => out.set(f, sets[i]));
    return out;
  }

  /** serialize renders (one engine, one framebuffer), memoize by key, and wait
   *  for init before touching the engine so early requests still resolve. */
  private enqueue(key: string, run: () => Promise<string | null>): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const task = this.queue.then(async () => {
      await this.ready;
      if (!this.engine) return null;
      const cached = this.cache.get(key);
      if (cached) return cached;
      this.holder.clearChildren();
      this.holder.transform.setPosition(0, 0, 0);   // reset any prior framing offset
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
    await this.waitFrames(2);
    return this.canvas.toDataURL("image/png");
  }

  private waitFrames(n: number): Promise<void> {
    return new Promise((resolve) => {
      const tick = (): void => { if (--n <= 0) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  /** centre `e`'s combined bounds at the origin and frame the camera to its
   *  bounding sphere with margin (so nothing clips regardless of aspect). */
  private frame(e: Entity, yaw: number, pitch: number): void {
    const rs = e.getComponentsIncludeChildren(MeshRenderer, []);
    const box = new BoundingBox();
    let has = false;
    for (const r of rs) { if (!r.mesh) continue; if (!has) { box.copyFrom(r.bounds); has = true; } else BoundingBox.merge(box, r.bounds, box); }
    let radius = 1;
    if (has) {
      const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
      e.transform.setPosition(-cx, -cy, -cz);   // holder was reset to origin in enqueue
      const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;
      radius = Math.max(0.001, 0.5 * Math.hypot(dx, dy, dz));
    }
    this.camPose(this.fitDist(radius, 1.15), yaw, pitch);
  }

  /** camera distance that frames a sphere of `radius` with `margin` headroom */
  private fitDist(radius: number, margin: number): number {
    return (radius * margin) / FOV_TAN;
  }

  /** orbit the camera around the origin at `dist`, yaw/pitch in radians */
  private camPose(dist: number, yaw: number, pitch: number): void {
    const cp = Math.cos(pitch);
    this.camE.transform.setPosition(dist * cp * Math.sin(yaw), dist * Math.sin(pitch), dist * cp * Math.cos(yaw));
    this.camE.transform.lookAt(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
  }
}
