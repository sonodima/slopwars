// ─── Interactive preview scene (material + model tabs) ───────────────────────
// A self-contained orbit-camera WebGL scene that backs the non-map viewport tabs:
//
//   • material tab — a lit sphere shaded by the material, sitting inside a chosen
//     HDRI environment (the skybox is selectable + drives reflections). Drag to
//     orbit, wheel to zoom.
//   • model tab    — the model itself, orbitable, with two sub-views: "model"
//     (just the geometry) and "collision" (the mesh goes semi-transparent and the
//     model's authored collision solids are drawn as translucent boxes you can
//     click to select and edit; the selected box is highlighted).
//
// It renders into its own canvas (shown only for preview tabs) with its own engine,
// exactly like the thumbnail renderer — no coupling to the map Viewport.
import {
  AmbientLight, BackgroundMode, BlendMode, BoundingBox, Camera, Color, DirectLight, Entity,
  MeshRenderer, PBRMaterial, PrimitiveMesh, RefractionMode, RenderFace, SkyBoxMaterial,
  TextureCube, UnlitMaterial, Vector3, Vector4, WebGLEngine,
} from "@galacean/engine";
import type { AssetCatalog, CollisionBox, MaterialDef, ModelMeta, Tuple3 } from "@slopwars/shared";
import { loadGLTF, loadHDRCube, loadTexture2D } from "@game/assets";
import type { ModelView } from "./tabs";

const DEG = Math.PI / 180;

/** what the scene is currently showing */
type Content =
  | { kind: "none" }
  | { kind: "material"; name: string }
  | { kind: "model"; name: string; view: ModelView };

export class PreviewScene {
  private engine!: WebGLEngine;
  private canvas!: HTMLCanvasElement;
  private root!: Entity;
  private holder!: Entity;        // the previewed content (sphere / model)
  private collisionRoot!: Entity; // collision box entities (model tab)
  private camE!: Entity;
  private camera!: Camera;
  private amb!: AmbientLight;
  private skyMat!: SkyBoxMaterial;
  ready = false;

  // orbit camera
  private yaw = 0.7;
  private pitch = 0.35;
  private dist = 4;
  private target = new Vector3(0, 0, 0);

  private content: Content = { kind: "none" };
  private hdriCache = new Map<string, Promise<TextureCube>>();
  private catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
  private curHdri: string | null = null;

  // collision authoring
  private boxes: CollisionBox[] = [];
  private boxEntities: Entity[] = [];
  private selBox = -1;
  /** notified when a collision box is clicked in the scene (index, or -1) */
  onCollisionSelect: ((index: number) => void) | null = null;

  // input bookkeeping
  private dragging = false;
  private moved = false;
  private lastX = 0;
  private lastY = 0;

  setCatalog(c: AssetCatalog): void { this.catalog = c; }

  async init(canvasId: string): Promise<void> {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const engine = await WebGLEngine.create({ canvas: this.canvas, graphicDeviceOptions: { preserveDrawingBuffer: true } });
    this.engine = engine;
    engine.canvas.resizeByClientSize();

    const scene = engine.sceneManager.activeScene;
    scene.background.mode = BackgroundMode.SolidColor;
    scene.background.solidColor = new Color(0.05, 0.055, 0.062, 1);
    this.root = scene.createRootEntity("root");

    const key = this.root.createChild("key");
    key.transform.setRotation(-42, -34, 0);
    key.addComponent(DirectLight).color = new Color(1.25, 1.2, 1.12, 1);
    const fill = this.root.createChild("fill");
    fill.transform.setRotation(-6, 150, 0);
    fill.addComponent(DirectLight).color = new Color(0.32, 0.38, 0.5, 1);
    this.amb = scene.ambientLight;
    this.amb.diffuseSolidColor = new Color(0.5, 0.53, 0.6, 1);
    this.amb.diffuseIntensity = 1.0;

    this.skyMat = new SkyBoxMaterial(engine);
    this.skyMat.textureDecodeRGBM = true;
    scene.background.sky.material = this.skyMat;
    scene.background.sky.mesh = PrimitiveMesh.createCuboid(engine, 2, 2, 2);

    this.camE = this.root.createChild("cam");
    this.camera = this.camE.addComponent(Camera);
    this.camera.fieldOfView = 40;
    this.camera.nearClipPlane = 0.02;
    this.camera.farClipPlane = 400;
    this.camera.enableHDR = true;
    this.camera.opaqueTextureEnabled = true;   // glass/water preview refracts

    this.holder = this.root.createChild("holder");
    this.collisionRoot = this.root.createChild("collision");

    this.bindInput();
    this.bindResize();
    engine.run();
    this.applyCamera();
    this.ready = true;
    requestAnimationFrame(this.frame);
  }

  /** show/hide the preview canvas (the shell toggles it per active tab kind).
   *  Safe to call before init resolves — the canvas is only styled once it exists. */
  show(visible: boolean): void {
    if (!this.canvas) return;
    this.canvas.style.display = visible ? "block" : "none";
    if (visible && this.ready) this.engine.canvas.resizeByClientSize();
  }

  private bindResize(): void {
    const resize = (): void => { if (this.ready && this.canvas.style.display !== "none") this.engine.canvas.resizeByClientSize(); };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(this.canvas.parentElement ?? this.canvas);
    window.addEventListener("resize", resize);
  }

  // ── camera ────────────────────────────────────────────────────────────────────
  private applyCamera(): void {
    const cp = Math.cos(this.pitch);
    const x = this.target.x + this.dist * cp * Math.sin(this.yaw);
    const y = this.target.y + this.dist * Math.sin(this.pitch);
    const z = this.target.z + this.dist * cp * Math.cos(this.yaw);
    this.camE.transform.setPosition(x, y, z);
    this.camE.transform.lookAt(this.target, new Vector3(0, 1, 0));
  }

  private frame = (): void => {
    requestAnimationFrame(this.frame);
  };

  // ── content: material ─────────────────────────────────────────────────────────
  /** render a lit sphere for a material def; keeps the current HDRI environment.
   *  `keepCamera` preserves the orbit (used for live material edits). */
  async showMaterial(name: string, def: MaterialDef, keepCamera = false): Promise<void> {
    if (!this.ready) return;
    this.content = { kind: "material", name };
    this.clearHolder();
    this.clearCollision();
    if (!keepCamera) { this.target.set(0, 0, 0); this.dist = 3.2; this.applyCamera(); }
    const e = this.holder.createChild("sphere");
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createSphere(this.engine, 1, 64);
    r.setMaterial(await this.buildMaterial(def));
  }

  /** render a lit sphere textured with a raw texture set (texture preview tab). */
  async showTexture(name: string): Promise<void> {
    await this.showMaterial(`tex:${name}`, { type: "standard", texture: name });
  }

  /** build an engine material from a def (mirrors the thumbnail renderer) */
  private async buildMaterial(def: MaterialDef): Promise<PBRMaterial> {
    const m = new PBRMaterial(this.engine);
    if (def.type === "standard") {
      if (def.texture) {
        const maps = this.catalog.textures.find((t) => t.name === def.texture)?.maps ?? {};
        const [color, normal, arm] = await Promise.all([
          maps.color ? loadTexture2D(this.engine, maps.color) : null,
          maps.normal ? loadTexture2D(this.engine, maps.normal) : null,
          maps.arm ? loadTexture2D(this.engine, maps.arm) : null,
        ]);
        if (color) m.baseTexture = color;
        if (normal) m.normalTexture = normal;
        if (arm) { m.roughnessMetallicTexture = arm; m.occlusionTexture = arm; } else { m.roughness = 0.85; m.metallic = 0; }
        if (def.color) m.baseColor = new Color(def.color[0], def.color[1], def.color[2], 1);
        if (def.roughness != null) m.roughness = def.roughness;
        if (def.metallic != null) m.metallic = def.metallic;
      } else {
        const c = def.color ?? [0.6, 0.6, 0.62];
        m.baseColor = new Color(c[0], c[1], c[2], 1);
        m.roughness = def.roughness ?? 0.9; m.metallic = def.metallic ?? 0.02;
      }
      m.tilingOffset = new Vector4(1, 1, 0, 0);
      if (def.emissive) m.emissiveColor = new Color(def.emissive[0], def.emissive[1], def.emissive[2], 1);
    } else if (def.type === "glass") {
      const c = def.color ?? [0.85, 0.92, 0.95];
      m.baseColor = new Color(c[0], c[1], c[2], def.opacity ?? 0.16);
      m.roughness = def.roughness ?? 0.02; m.metallic = 0; m.ior = def.ior ?? 1.5;
      m.isTransparent = true; m.refractionMode = RefractionMode.Planar; m.transmission = 1;
    } else {
      const c = def.color ?? [0.05, 0.16, 0.2];
      m.baseColor = new Color(c[0], c[1], c[2], def.opacity ?? 0.92);
      m.roughness = def.roughness ?? 0.08; m.metallic = 0; m.isTransparent = true;
    }
    return m;
  }

  /** set (or clear) the HDRI environment used for the material preview. Drives both
   *  the visible skybox and the sphere's specular reflections. */
  async setHdri(name: string | null): Promise<void> {
    if (!this.ready) return;
    this.curHdri = name;
    const scene = this.engine.sceneManager.activeScene;
    const h = name ? this.catalog.hdri.find((x) => x.name === name) : null;
    if (!h) {
      this.amb.specularTexture = null as unknown as TextureCube;
      scene.background.mode = BackgroundMode.SolidColor;
      return;
    }
    let p = this.hdriCache.get(h.file);
    if (!p) { p = loadHDRCube(this.engine, h.file); this.hdriCache.set(h.file, p); }
    const cube = await p.catch(() => null);
    if (!cube || this.curHdri !== name) return;
    this.skyMat.texture = cube;
    this.amb.specularTexture = cube;
    scene.background.mode = BackgroundMode.Sky;
  }

  currentHdri(): string | null { return this.curHdri; }

  // ── content: model ──────────────────────────────────────────────────────────
  /** render a model with the given sub-view + calibration meta. `keepCamera`
   *  preserves the orbit (used when a live edit re-renders the same model). */
  async showModel(name: string, view: ModelView, meta: ModelMeta, keepCamera = false): Promise<void> {
    if (!this.ready) return;
    this.content = { kind: "model", name, view };
    this.clearHolder();
    this.clearCollision();
    const asset = this.catalog.models.find((m) => m.name === name);
    if (!asset) return;
    const res = await loadGLTF(this.engine, asset.gltf).catch(() => null);
    if (!res || this.content.kind !== "model" || this.content.name !== name) return;
    const e = res.instantiateSceneRoot();
    this.holder.addChild(e);
    const radius = keepCamera ? this.holderRadius() : this.frameHolder();
    if (meta.material) this.applyModelMaterial(e, meta.material);
    if (view === "collision") {
      this.dimModel(e);
      this.renderCollision(meta, radius);
    }
  }

  /** apply a material override (by name) to every surface of the previewed model,
   *  so the isolated preview matches what the game will render. */
  private applyModelMaterial(e: Entity, name: string): void {
    const def = this.catalog.materials.find((m) => m.name === name)?.def;
    if (!def) return;
    void this.buildMaterial(def).then((m) => {
      if (e.destroyed) return;
      for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) r.setMaterial(m);
    });
  }

  /** re-render just the collision boxes (after an inspector edit / add / delete) */
  refreshCollision(meta: ModelMeta): void {
    if (this.content.kind !== "model" || this.content.view !== "collision") return;
    const radius = this.holderRadius();
    this.renderCollision(meta, radius);
  }

  selectBox(index: number): void {
    this.selBox = index;
    this.restyleBoxes();
  }

  private renderCollision(meta: ModelMeta, radius: number): void {
    this.clearCollision();
    this.boxes = (meta.collision === "manual" ? meta.collisionBoxes : undefined) ?? [];
    this.boxes.forEach((b, i) => this.boxEntities[i] = this.makeBoxEntity(b, i));
    this.restyleBoxes();
    void radius;
  }

  private makeBoxEntity(b: CollisionBox, i: number): Entity {
    const e = this.collisionRoot.createChild(`box${i}`);
    e.transform.setPosition(b.at[0], b.at[1], b.at[2]);
    e.transform.setScale(Math.max(0.001, b.size[0]), Math.max(0.001, b.size[1]), Math.max(0.001, b.size[2]));
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createCuboid(this.engine, 1, 1, 1);
    r.setMaterial(this.boxMaterial(false));
    return e;
  }

  private boxMaterial(selected: boolean): UnlitMaterial {
    const m = new UnlitMaterial(this.engine);
    m.baseColor = selected ? new Color(1.0, 0.62, 0.12, 0.45) : new Color(0.2, 0.7, 1.0, 0.28);
    m.isTransparent = true;
    m.blendMode = BlendMode.Normal;
    m.renderFace = RenderFace.Double;
    return m;
  }

  private restyleBoxes(): void {
    this.boxEntities.forEach((e, i) => {
      if (!e || e.destroyed) return;
      const r = e.getComponent(MeshRenderer);
      if (r) r.setMaterial(this.boxMaterial(i === this.selBox));
    });
  }

  /** make a model's surfaces semi-transparent for the collision authoring view */
  private dimModel(e: Entity): void {
    for (const r of e.getComponentsIncludeChildren(MeshRenderer, [])) {
      const src = r.getMaterial();
      const m = new PBRMaterial(this.engine);
      if (src instanceof PBRMaterial) { m.baseColor = src.baseColor.clone(); m.baseTexture = src.baseTexture; }
      m.baseColor.a = 0.22;
      m.isTransparent = true;
      r.setMaterial(m);
    }
  }

  // ── framing / clearing ─────────────────────────────────────────────────────────
  private holderBox(): { center: Vector3; radius: number } {
    const box = new BoundingBox();
    let has = false;
    for (const r of this.holder.getComponentsIncludeChildren(MeshRenderer, [])) {
      if (!r.mesh) continue;
      if (!has) { box.copyFrom(r.bounds); has = true; } else BoundingBox.merge(box, r.bounds, box);
    }
    if (!has) return { center: new Vector3(0, 0, 0), radius: 1 };
    const center = new Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
    const radius = Math.max(0.05, 0.5 * Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z));
    return { center, radius };
  }
  private frameHolder(): number {
    const { center, radius } = this.holderBox();
    this.target.copyFrom(center);
    this.dist = (radius * 1.6) / Math.tan((this.camera.fieldOfView * DEG) / 2);
    this.applyCamera();
    return radius;
  }
  private holderRadius(): number { return this.holderBox().radius; }

  private clearHolder(): void { this.holder.clearChildren(); }
  private clearCollision(): void {
    this.collisionRoot.clearChildren();
    this.boxEntities = [];
    this.selBox = -1;
  }

  // ── input: orbit + zoom + collision pick ───────────────────────────────────────
  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      this.dragging = true; this.moved = false;
      this.lastX = e.clientX; this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.yaw += dx * 0.01;
      this.pitch = clamp(this.pitch - dy * 0.01, -1.4, 1.4);
      this.applyCamera();
    });
    c.addEventListener("pointerup", (e) => {
      c.releasePointerCapture(e.pointerId);
      const wasDrag = this.moved;
      this.dragging = false;
      if (!wasDrag) this.onClick(e);
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.12), 0.4, 200);
      this.applyCamera();
    }, { passive: false });
  }

  /** a click (no drag) in collision view picks the nearest collision box */
  private onClick(e: PointerEvent): void {
    if (this.content.kind !== "model" || this.content.view !== "collision" || !this.boxes.length) return;
    const rc = this.canvas.getBoundingClientRect();
    const ray = this.pixelRay(e.clientX - rc.left, e.clientY - rc.top, rc.width, rc.height);
    let best = Infinity, hit = -1;
    this.boxes.forEach((b, i) => {
      const t = rayBox(ray.o, ray.d, b);
      if (t !== null && t < best) { best = t; hit = i; }
    });
    this.selBox = hit;
    this.restyleBoxes();
    this.onCollisionSelect?.(hit);
  }

  private pixelRay(px: number, py: number, w: number, h: number): { o: number[]; d: number[] } {
    const pos = this.camE.transform.position;
    const o = [pos.x, pos.y, pos.z];
    const f = norm([this.target.x - o[0], this.target.y - o[1], this.target.z - o[2]]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    const aspect = w / h;
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const ndcx = (px / w) * 2 - 1;
    const ndcy = 1 - (py / h) * 2;
    const d = norm([
      f[0] + r[0] * ndcx * tanF * aspect + u[0] * ndcy * tanF,
      f[1] + r[1] * ndcx * tanF * aspect + u[1] * ndcy * tanF,
      f[2] + r[2] * ndcx * tanF * aspect + u[2] * ndcy * tanF,
    ]);
    return { o, d };
  }
}

// ── small vector helpers ────────────────────────────────────────────────────────
function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function cross(a: number[], b: number[]): number[] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: number[]): number[] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** ray vs an axis-aligned collision box (centre `at`, full `size`); entry dist or null */
function rayBox(o: number[], d: number[], box: { at: Tuple3; size: Tuple3 }): number | null {
  const mn = [box.at[0] - box.size[0] / 2, box.at[1] - box.size[1] / 2, box.at[2] - box.size[2] / 2];
  const mx = [box.at[0] + box.size[0] / 2, box.at[1] + box.size[1] / 2, box.at[2] + box.size[2] / 2];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) return null; }
    else {
      const inv = 1 / d[i];
      let t1 = (mn[i] - o[i]) * inv, t2 = (mx[i] - o[i]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0 ? tmin : null;
}
