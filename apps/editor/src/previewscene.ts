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
  MeshRenderer, PBRMaterial, PrimitiveMesh, RenderFace, SkyBoxMaterial,
  TextureCube, UnlitMaterial, Vector3, Vector4, WebGLEngine,
} from "@galacean/engine";
import type { AssetCatalog, CollisionBox, MaterialDef, ModelMeta, TextureMaps, Tuple3 } from "@slopwars/shared";
import { rotateEulerInv } from "@slopwars/shared";
import { loadGLTF, loadHDRCube, loadTexture2D } from "@game/assets";
import { applyWaterLook, attachWaterAnim, WATER_LOOK, type WaterAnim, type WaterLook } from "@game/water";
import { buildGlassMaterial } from "@game/materials";
import type { ModelView } from "./tabs";
import type { Tool } from "./viewport";
import {
  AXIS_IDX, GIZMO_AXES, GIZMO_COL, ROT_SNAP_DEG,
  clamp, cross, distToSeg, dot, norm, type GizmoHandle as GHandle,
} from "./vecmath";

/** UV repeat used for the water preview sphere — a couple of tiles keep the fractal
 *  ripples a believable size on a unit sphere (matches how the game tiles by area). */
const WATER_PREVIEW_TILING = 2;

const DEG = Math.PI / 180;

/** what the scene is currently showing */
type Content =
  | { kind: "none" }
  | { kind: "material"; name: string }
  | { kind: "model"; name: string; view: ModelView }
  | { kind: "texture"; name: string };

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
  // model-view root indicator: the base offset applied to the previewed model and a
  // radius that sizes the y=0 ground grid drawn on the overlay.
  private modelBase = 0;
  private indicatorRadius = 1;
  private hdriCache = new Map<string, Promise<TextureCube>>();
  private catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
  private curHdri: string | null = null;
  /** live water flow animation of the current material preview (kept so its phase
   *  survives a rebuild on a param edit — see showMaterial) */
  private waterAnim: WaterAnim | null = null;

  // collision authoring
  private boxes: CollisionBox[] = [];
  private boxEntities: Entity[] = [];
  private selBox = -1;
  /** notified when a collision box is clicked in the scene (index, or -1) */
  onCollisionSelect: ((index: number) => void) | null = null;

  // collision gizmo: move/rotate/scale the selected solid directly in the view
  // (mirrors the map viewport's transform gizmo for a single solid).
  private overlay!: HTMLCanvasElement;
  private octx!: CanvasRenderingContext2D;
  private gizmoTool: "move" | "rotate" | "scale" = "move";
  private gizmoHover: GHandle | null = null;
  private gizmoDrag: {
    handle: GHandle;
    at: Tuple3; size: Tuple3; rot: Tuple3;   // box transform at grab
    startPx: number; startPy: number;
    unit: [number, number]; wpp: number; // screen-space axis dir + world/pixel (axis handles)
    rvec: number[]; uvec: number[]; pwpp: number; // camera basis + world/pixel (centre handle)
    cx: number; cy: number; startAngle: number;   // ring centre + grab angle (rotate)
  } | null = null;
  /** notified after a gizmo drag mutates the selected solid (persist + reshade) */
  onCollisionChange: (() => void) | null = null;

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

    this.setupOverlay();
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
    this.drawGizmo();
    requestAnimationFrame(this.frame);
  };

  // ── content: material ─────────────────────────────────────────────────────────
  /** render a lit sphere for a material def; keeps the current HDRI environment.
   *  `keepCamera` preserves the orbit (used for live material edits). */
  async showMaterial(name: string, def: MaterialDef, keepCamera = false): Promise<void> {
    if (!this.ready) return;
    // preserve the water flow phase when re-showing the SAME material (a live edit),
    // so tweaking a param doesn't snap the ripples back to the start.
    const samePrev = keepCamera && this.content.kind === "material" && this.content.name === name;
    const prevPhase = samePrev && this.waterAnim ? this.waterAnim.phase : 0;
    this.waterAnim = null;
    this.content = { kind: "material", name };
    this.clearHolder();
    this.clearCollision();
    if (!keepCamera) { this.target.set(0, 0, 0); this.dist = 3.2; this.applyCamera(); }
    const e = this.holder.createChild("sphere");
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createSphere(this.engine, 1, 64);
    const mat = await this.buildMaterial(def);
    // guard: a slower texture load may have been superseded by another tab
    if (this.content.kind !== "material" || this.content.name !== name || e.destroyed) return;
    r.setMaterial(mat);
    // water flows: scroll the wave-normal UVs so ripples move like they do in-game
    if (def.type === "water") this.waterAnim = attachWaterAnim(e, mat, WATER_PREVIEW_TILING, waterLookOf(def).flow, prevPhase);
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
      // reuse the game's exact glass shading so the preview refracts + tints what's
      // behind the sphere identically to a window in a map.
      return buildGlassMaterial(this.engine, def);
    } else {
      // water — use the game's exact shading (fractal wave normal + transmission +
      // depth attenuation) so the preview shows real ripples, not a flat tint. The
      // scroll animation is attached to the sphere by showMaterial().
      applyWaterLook(this.engine, m, waterLookOf(def), WATER_PREVIEW_TILING);
    }
    return m;
  }

  // ── content: texture set ──────────────────────────────────────────────────────
  /** render a lit PBR sphere for a raw texture set (color/normal/arm), so you can see
   *  the maps shading a surface in the chosen HDRI environment while editing them in
   *  the inspector. No material tint/params — it's the maps as-is. `keepCamera` keeps
   *  the orbit across a live map edit (add/replace/clear). */
  async showTexture(name: string, maps: TextureMaps, keepCamera = false): Promise<void> {
    if (!this.ready) return;
    this.content = { kind: "texture", name };
    this.clearHolder();
    this.clearCollision();
    if (!keepCamera) { this.target.set(0, 0, 0); this.dist = 3.2; this.applyCamera(); }
    const e = this.holder.createChild("sphere");
    const r = e.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createSphere(this.engine, 1, 64);
    const m = new PBRMaterial(this.engine);
    m.tilingOffset = new Vector4(1, 1, 0, 0);
    const [color, normal, arm] = await Promise.all([
      maps.color ? loadTexture2D(this.engine, maps.color) : null,
      maps.normal ? loadTexture2D(this.engine, maps.normal) : null,
      maps.arm ? loadTexture2D(this.engine, maps.arm) : null,
    ]);
    // guard: a slower load may have been superseded by another tab
    if (this.content.kind !== "texture" || this.content.name !== name || e.destroyed) return;
    if (color) m.baseTexture = color;
    if (normal) m.normalTexture = normal;
    if (arm) { m.roughnessMetallicTexture = arm; m.occlusionTexture = arm; } else { m.roughness = 0.85; m.metallic = 0; }
    if (!color) m.baseColor = new Color(0.6, 0.6, 0.62, 1);   // no color map → neutral gray
    r.setMaterial(m);
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
    // keep the orbit whenever the same model is already on screen — only reframe
    // when a *different* model loads. So switching Model⇄Collision or changing the
    // collision mode never yanks the camera back to its default distance/angle.
    const sameModel = this.content.kind === "model" && this.content.name === name;
    const keep = keepCamera || sameModel;
    this.content = { kind: "model", name, view };
    this.clearHolder();
    this.clearCollision();
    const asset = this.catalog.models.find((m) => m.name === name);
    if (!asset) return;
    const res = await loadGLTF(this.engine, asset.gltf).catch(() => null);
    if (!res || this.content.kind !== "model" || this.content.name !== name) return;
    const e = res.instantiateSceneRoot();
    this.holder.addChild(e);
    // Model view lifts the model by its `base` so you can see it sit relative to the
    // y=0 root grid (tune base until it rests on the grid). Collision authoring stays
    // in the raw local frame the boxes are stored in, so it applies no base offset.
    this.modelBase = view === "model" && typeof meta.base === "number" ? meta.base : 0;
    if (this.modelBase) e.transform.setPosition(0, this.modelBase, 0);
    const radius = keep ? this.holderRadius() : this.frameHolder();
    this.indicatorRadius = radius;
    if (meta.material) this.applyModelMaterial(e, meta.material);
    if (view === "collision") {
      this.dimModel(e);
      this.renderCollision(meta, radius);
    }
  }

  /** model-local centre of the previewed geometry (for spawning a new collision
   *  solid somewhere visible instead of at the origin). */
  modelCenter(): Tuple3 { const c = this.holderBox().center; return [round3(c.x), round3(c.y), round3(c.z)]; }

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

  /** which transform gizmo the collision solids use — mirrors the map viewport's
   *  Move / Rotate / Scale tool, applied to the selected solid. */
  setGizmoTool(t: Tool): void { this.gizmoTool = t === "scale" ? "scale" : t === "rotate" ? "rotate" : "move"; }

  private renderCollision(meta: ModelMeta, radius: number): void {
    // preserve the current selection across a refresh (a gizmo drag / add rebuilds
    // the box entities but must keep the same solid selected + its gizmo showing)
    const keepSel = this.selBox;
    this.collisionRoot.clearChildren();
    this.boxEntities = [];
    this.boxes = (meta.collision === "manual" ? meta.collisionBoxes : undefined) ?? [];
    this.boxes.forEach((b, i) => this.boxEntities[i] = this.makeBoxEntity(b, i));
    this.selBox = keepSel >= 0 && keepSel < this.boxes.length ? keepSel : -1;
    this.restyleBoxes();
    void radius;
  }

  private makeBoxEntity(b: CollisionBox, i: number): Entity {
    const e = this.collisionRoot.createChild(`box${i}`);
    e.transform.setPosition(b.at[0], b.at[1], b.at[2]);
    if (b.rot && (b.rot[0] || b.rot[1] || b.rot[2])) e.transform.setRotation(b.rot[0], b.rot[1], b.rot[2]);
    e.transform.setScale(Math.max(0.001, b.size[0]), Math.max(0.001, b.size[1]), Math.max(0.001, b.size[2]));
    const r = e.addComponent(MeshRenderer);
    // a unit primitive (fits a 1³ box) so the shared per-solid scale sizes it: a
    // cylinder is upright along Y (radius ½ in x/z), a sphere is inscribed likewise.
    r.mesh = b.shape === "cylinder" ? PrimitiveMesh.createCylinder(this.engine, 0.5, 0.5, 1, 24)
      : b.shape === "sphere" ? PrimitiveMesh.createSphere(this.engine, 0.5, 24)
      : PrimitiveMesh.createCuboid(this.engine, 1, 1, 1);
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

  // ── input: orbit + zoom + collision pick + gizmo ────────────────────────────────
  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      // grabbing a gizmo handle of the selected solid starts a move/scale edit
      const { x, y } = this.local(e);
      const h = this.gizmoActive() ? this.pickHandle(x, y) : null;
      if (h) { this.beginGizmo(h, x, y); c.setPointerCapture(e.pointerId); return; }
      this.dragging = true; this.moved = false;
      this.lastX = e.clientX; this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (this.gizmoDrag) { const { x, y } = this.local(e); this.applyGizmo(x, y, e.shiftKey); return; }
      if (!this.dragging) { this.updateGizmoHover(e); return; }
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.yaw += dx * 0.01;
      this.pitch = clamp(this.pitch - dy * 0.01, -1.4, 1.4);
      this.applyCamera();
    });
    c.addEventListener("pointerup", (e) => {
      c.releasePointerCapture(e.pointerId);
      if (this.gizmoDrag) { this.gizmoDrag = null; this.onCollisionChange?.(); return; }
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

  // ── collision gizmo (project / draw / pick / drag) ──────────────────────────────
  private setupOverlay(): void {
    const o = document.createElement("canvas");
    o.className = "preview-overlay";
    this.canvas.parentElement!.appendChild(o);
    this.overlay = o;
    this.octx = o.getContext("2d")!;
  }

  /** true when a collision solid is selected and editable in the view */
  private gizmoActive(): boolean {
    return this.content.kind === "model" && this.content.view === "collision"
      && this.selBox >= 0 && this.selBox < this.boxes.length;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const rc = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rc.left, y: e.clientY - rc.top };
  }

  /** camera basis in world (forward / right / up) */
  private basis(): { f: number[]; r: number[]; u: number[] } {
    const pos = this.camE.transform.position;
    const f = norm([this.target.x - pos.x, this.target.y - pos.y, this.target.z - pos.z]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    return { f, r, u };
  }

  /** world → overlay pixel; visible=false if behind the camera */
  private project(w: Tuple3): { x: number; y: number; visible: boolean } {
    const { f, r, u } = this.basis();
    const pos = this.camE.transform.position;
    const rel = [w[0] - pos.x, w[1] - pos.y, w[2] - pos.z];
    const fz = dot(rel, f);
    if (fz <= 0.01) return { x: 0, y: 0, visible: false };
    const rc = this.canvas.getBoundingClientRect();
    const aspect = rc.width / rc.height;
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const ndcx = (dot(rel, r) / fz) / (tanF * aspect);
    const ndcy = (dot(rel, u) / fz) / tanF;
    return { x: (ndcx * 0.5 + 0.5) * rc.width, y: (1 - (ndcy * 0.5 + 0.5)) * rc.height, visible: true };
  }

  /** world axis length that keeps the gizmo ~constant on-screen size at `at` */
  private gizmoLen(at: Tuple3): number {
    const { f } = this.basis();
    const pos = this.camE.transform.position;
    const fz = Math.max(0.3, dot([at[0] - pos.x, at[1] - pos.y, at[2] - pos.z], f));
    const rc = this.canvas.getBoundingClientRect();
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const pixPerWorld = (rc.height / 2) / (tanF * fz);
    return clamp(80 / pixPerWorld, 0.05, 1e4);
  }

  private updateGizmoHover(e: PointerEvent): void {
    if (!this.gizmoActive()) { if (this.gizmoHover) { this.gizmoHover = null; this.canvas.style.cursor = "grab"; } return; }
    const { x, y } = this.local(e);
    const h = this.pickHandle(x, y);
    if (h !== this.gizmoHover) { this.gizmoHover = h; this.canvas.style.cursor = h ? "grab" : "grab"; }
  }

  /** N sampled screen points of the rotation ring in the plane ⟂ to a world axis */
  private ring(at: Tuple3, dir: Tuple3, L: number): { x: number; y: number; visible: boolean }[] {
    const u = norm(Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
    const a = norm(cross(dir, u)), b = norm(cross(dir, a));
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      pts.push(this.project([
        at[0] + (a[0] * Math.cos(t) + b[0] * Math.sin(t)) * L,
        at[1] + (a[1] * Math.cos(t) + b[1] * Math.sin(t)) * L,
        at[2] + (a[2] * Math.cos(t) + b[2] * Math.sin(t)) * L,
      ] as Tuple3));
    }
    return pts;
  }

  /** which gizmo handle (if any) is under a pixel for the selected solid */
  private pickHandle(px: number, py: number): GHandle | null {
    if (!this.gizmoActive()) return null;
    const at = this.boxes[this.selBox].at;
    const c = this.project(at);
    if (!c.visible) return null;
    const L = this.gizmoLen(at);
    let best = 10, hit: GHandle | null = null;
    if (this.gizmoTool === "rotate") {
      for (const { h, dir } of GIZMO_AXES) {
        for (const p of this.ring(at, dir, L)) {
          if (!p.visible) continue;
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < best) { best = d; hit = h; }
        }
      }
      return hit;
    }
    for (const { h, dir } of GIZMO_AXES) {
      const tip = this.project([at[0] + dir[0] * L, at[1] + dir[1] * L, at[2] + dir[2] * L]);
      if (!tip.visible) continue;
      const d = distToSeg(px, py, c.x, c.y, tip.x, tip.y);
      if (d < best) { best = d; hit = h; }
    }
    if (Math.hypot(c.x - px, c.y - py) < 9) hit = "xyz";   // centre → all-axes
    return hit;
  }

  private beginGizmo(h: GHandle, px: number, py: number): void {
    const b = this.boxes[this.selBox];
    const c = this.project(b.at);
    const L = this.gizmoLen(b.at);
    let unit: [number, number] = [1, 0], wpp = 0;
    if (h !== "xyz") {
      const dir = GIZMO_AXES.find((a) => a.h === h)!.dir;
      const tip = this.project([b.at[0] + dir[0] * L, b.at[1] + dir[1] * L, b.at[2] + dir[2] * L]);
      const dxp = tip.x - c.x, dyp = tip.y - c.y, len = Math.hypot(dxp, dyp) || 1;
      unit = [dxp / len, dyp / len]; wpp = L / len;
    }
    const { r, u, f } = this.basis();
    const pos = this.camE.transform.position;
    const fz = Math.max(0.3, dot([b.at[0] - pos.x, b.at[1] - pos.y, b.at[2] - pos.z], f));
    const tanF = Math.tan((this.camera.fieldOfView * DEG) / 2);
    const pwpp = (2 * tanF * fz) / this.canvas.getBoundingClientRect().height;
    this.gizmoDrag = {
      handle: h, at: b.at.slice() as Tuple3, size: b.size.slice() as Tuple3,
      rot: (b.rot ?? [0, 0, 0]).slice() as Tuple3,
      startPx: px, startPy: py, unit, wpp, rvec: r, uvec: u, pwpp,
      cx: c.x, cy: c.y, startAngle: Math.atan2(py - c.y, px - c.x),
    };
    this.canvas.style.cursor = "grabbing";
  }

  private applyGizmo(px: number, py: number, snap = false): void {
    const d = this.gizmoDrag; if (!d) return;
    const b = this.boxes[this.selBox]; if (!b) return;
    const ddx = px - d.startPx, ddy = py - d.startPy;
    if (this.gizmoTool === "move") {
      if (d.handle === "xyz") {
        b.at = [
          round3(d.at[0] + (d.rvec[0] * ddx - d.uvec[0] * ddy) * d.pwpp),
          round3(d.at[1] + (d.rvec[1] * ddx - d.uvec[1] * ddy) * d.pwpp),
          round3(d.at[2] + (d.rvec[2] * ddx - d.uvec[2] * ddy) * d.pwpp),
        ];
      } else {
        const along = (ddx * d.unit[0] + ddy * d.unit[1]) * d.wpp;
        const i = AXIS_IDX[d.handle];
        const nat = d.at.slice() as Tuple3; nat[i] = round3(d.at[i] + along);
        b.at = nat;
      }
    } else if (this.gizmoTool === "rotate") {
      const ang = Math.atan2(py - d.cy, px - d.cx);
      const idx = AXIS_IDX[d.handle];
      const sign = d.handle === "y" ? -1 : 1;
      let sdeg = ((ang - d.startAngle) * 180) / Math.PI * sign;
      // hold Shift → snap to 30° increments, matching the map viewport's rotate gizmo
      if (snap) sdeg = Math.round(sdeg / ROT_SNAP_DEG) * ROT_SNAP_DEG;
      const nrot = d.rot.slice() as Tuple3; nrot[idx] = round3(d.rot[idx] + sdeg);
      b.rot = (nrot[0] || nrot[1] || nrot[2]) ? nrot : undefined;
    } else {   // scale about the box centre (size changes, position stays)
      if (d.handle === "xyz") {
        const f = Math.max(0.02, 1 - ddy / 140);
        b.size = [round3(d.size[0] * f), round3(d.size[1] * f), round3(d.size[2] * f)];
      } else {
        const i = AXIS_IDX[d.handle];
        const f = 1 + (ddx * d.unit[0] + ddy * d.unit[1]) / 70;
        const ns = d.size.slice() as Tuple3; ns[i] = round3(Math.max(0.02, d.size[i] * f));
        b.size = ns;
      }
    }
    // reflect the edit live on the box entity without a full rebuild
    const e = this.boxEntities[this.selBox];
    if (e && !e.destroyed) {
      e.transform.setPosition(b.at[0], b.at[1], b.at[2]);
      const br = b.rot ?? [0, 0, 0];
      e.transform.setRotation(br[0], br[1], br[2]);
      e.transform.setScale(Math.max(0.001, b.size[0]), Math.max(0.001, b.size[1]), Math.max(0.001, b.size[2]));
    }
  }

  /** draw the transform gizmo for the selected solid (cleared when not authoring) */
  private drawGizmo(): void {
    if (!this.ready) return;
    const rc = this.canvas.getBoundingClientRect();
    if (this.overlay.width !== Math.round(rc.width) || this.overlay.height !== Math.round(rc.height)) {
      this.overlay.width = Math.round(rc.width); this.overlay.height = Math.round(rc.height);
    }
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    // model view: draw the root (0,0,0) indicator — a ground grid + axis cross — so
    // the base offset can be judged/adjusted against it.
    if (this.content.kind === "model" && this.content.view === "model") { this.drawOriginIndicator(); return; }
    if (!this.gizmoActive()) return;
    const at = this.boxes[this.selBox].at;
    const c = this.project(at);
    if (!c.visible) return;
    const L = this.gizmoLen(at);
    if (this.gizmoTool === "rotate") {
      for (const { h, dir } of GIZMO_AXES) {
        const pts = this.ring(at, dir, L);
        ctx.beginPath();
        let started = false;
        for (const p of pts) { if (!p.visible) { started = false; continue; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
        const on = this.gizmoHover === h || this.gizmoDrag?.handle === h;
        ctx.strokeStyle = on ? "#ffd257" : GIZMO_COL[h]; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#f5a623"; ctx.fill();
      return;
    }
    for (const { h, dir } of GIZMO_AXES) {
      const tip = this.project([at[0] + dir[0] * L, at[1] + dir[1] * L, at[2] + dir[2] * L]);
      if (!tip.visible) continue;
      const on = this.gizmoHover === h || this.gizmoDrag?.handle === h;
      ctx.strokeStyle = on ? "#ffd257" : GIZMO_COL[h];
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = on ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      if (this.gizmoTool === "move") {   // arrowhead
        const a = Math.atan2(tip.y - c.y, tip.x - c.x);
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - 9 * Math.cos(a - 0.4), tip.y - 9 * Math.sin(a - 0.4));
        ctx.lineTo(tip.x - 9 * Math.cos(a + 0.4), tip.y - 9 * Math.sin(a + 0.4));
        ctx.closePath(); ctx.fill();
      } else {                           // scale → box handle
        ctx.fillRect(tip.x - 4, tip.y - 4, 8, 8);
      }
    }
    const onC = this.gizmoHover === "xyz" || this.gizmoDrag?.handle === "xyz";
    ctx.fillStyle = onC ? "#ffd257" : GIZMO_COL.xyz;
    if (this.gizmoTool === "scale") ctx.fillRect(c.x - 5, c.y - 5, 10, 10);
    else { ctx.beginPath(); ctx.arc(c.x, c.y, 6, 0, Math.PI * 2); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = onC ? 3 : 2; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#f5a623"; ctx.fill();
  }

  /** draw the model's root (0,0,0) indicator: a faint ground grid on the y=0 plane
   *  plus a short X/Y/Z axis cross at the origin. The previewed model is lifted by
   *  its `base`, so this grid is the surface it should rest on — tuning base until
   *  the model sits on the grid calibrates its footing. */
  private drawOriginIndicator(): void {
    const ctx = this.octx;
    const R = Math.max(0.6, Math.min(6, this.indicatorRadius * 1.4));
    const step = R / 4;
    const line = (a: Tuple3, b: Tuple3, style: string, w: number): void => {
      const pa = this.project(a), pb = this.project(b);
      if (!pa.visible || !pb.visible) return;
      ctx.strokeStyle = style; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    };
    // ground grid (y=0)
    for (let i = -4; i <= 4; i++) {
      const t = i * step;
      const main = i === 0;
      line([t, 0, -R], [t, 0, R], main ? "rgba(120,160,200,0.5)" : "rgba(120,140,160,0.18)", main ? 1.4 : 1);
      line([-R, 0, t], [R, 0, t], main ? "rgba(120,160,200,0.5)" : "rgba(120,140,160,0.18)", main ? 1.4 : 1);
    }
    // axis cross at the root
    const A = step * 1.6;
    line([0, 0, 0], [A, 0, 0], "#e5484d", 2);   // X
    line([0, 0, 0], [0, A, 0], "#5bd15b", 2);   // Y (up)
    line([0, 0, 0], [0, 0, A], "#3b82f6", 2);   // Z
    const o = this.project([0, 0, 0]);
    if (o.visible) { ctx.beginPath(); ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#eef1f4"; ctx.fill(); }
  }
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

/** a full WaterLook from a (possibly partial) water material def — defaults fill any
 *  omitted field, mirroring the game's MaterialLibrary.lookOf so the preview matches. */
function waterLookOf(def: MaterialDef): WaterLook {
  const d: Partial<WaterLook> = def.type === "water" ? def : {};
  return {
    color: d.color ?? WATER_LOOK.color, opacity: d.opacity ?? WATER_LOOK.opacity,
    roughness: d.roughness ?? WATER_LOOK.roughness, ior: d.ior ?? WATER_LOOK.ior,
    flow: d.flow ?? WATER_LOOK.flow, waves: d.waves ?? WATER_LOOK.waves,
    depthColor: d.depthColor ?? WATER_LOOK.depthColor, depth: d.depth ?? WATER_LOOK.depth,
    clarity: d.clarity ?? WATER_LOOK.clarity,
  };
}

/** ray vs a collision box (centre `at`, full `size`, optional euler `rot`); entry
 *  dist or null. A rotated box is tested in its local frame (inverse-rotate the ray). */
function rayBox(o: number[], d: number[], box: { at: Tuple3; size: Tuple3; rot?: Tuple3 }): number | null {
  const rot = box.rot;
  let ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  if (rot && (rot[0] || rot[1] || rot[2])) {
    const ro = rotateEulerInv([o[0] - box.at[0], o[1] - box.at[1], o[2] - box.at[2]], rot);
    const rd = rotateEulerInv([d[0], d[1], d[2]], rot);
    ox = box.at[0] + ro[0]; oy = box.at[1] + ro[1]; oz = box.at[2] + ro[2];
    dx = rd[0]; dy = rd[1]; dz = rd[2];
  }
  o = [ox, oy, oz]; d = [dx, dy, dz];
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
