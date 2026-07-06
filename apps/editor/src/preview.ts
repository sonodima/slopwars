// ─── Model preview: a small self-contained turntable for the asset browser ───
// Its own tiny WebGL engine so it never disturbs the main viewport. Loads one
// glTF at a time and lets you drag to rotate it. Fully guarded — if WebGL or a
// load fails, the browser simply shows no preview.
import {
  AmbientLight, BoundingBox, Camera, Color, DirectLight, Entity, MeshRenderer, Vector3, WebGLEngine,
} from "@galacean/engine";
import { loadGLTF } from "@game/assets";

export class ModelPreview {
  private engine: WebGLEngine | null = null;
  private root!: Entity;
  private holder!: Entity;
  private camE!: Entity;
  private yaw = 0.6;
  private pitch = 0.3;
  private dist = 4;
  private current = "";
  ok = false;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    try {
      const engine = await WebGLEngine.create({ canvas });
      this.engine = engine;
      engine.canvas.resizeByClientSize();
      const scene = engine.sceneManager.activeScene;
      scene.background.solidColor = new Color(0.09, 0.1, 0.11, 1);
      this.root = scene.createRootEntity("root");
      const lightE = this.root.createChild("l");
      lightE.transform.setRotation(-40, -30, 0);
      lightE.addComponent(DirectLight).color = new Color(1.2, 1.2, 1.15, 1);
      const amb: AmbientLight = scene.ambientLight;
      amb.diffuseSolidColor = new Color(0.55, 0.58, 0.62, 1);
      amb.diffuseIntensity = 0.9;
      this.camE = this.root.createChild("cam");
      this.camE.addComponent(Camera).fieldOfView = 40;
      this.holder = this.root.createChild("holder");
      this.bindDrag(canvas);
      engine.run();
      this.place();
      this.ok = true;
    } catch (e) { console.warn("preview init failed", e); this.ok = false; }
  }

  async show(gltfPath: string): Promise<void> {
    if (!this.engine || this.current === gltfPath) return;
    this.current = gltfPath;
    this.holder.clearChildren();
    try {
      const res = await loadGLTF(this.engine, gltfPath);
      if (this.current !== gltfPath) return; // superseded
      const e = res.instantiateSceneRoot();
      this.holder.addChild(e);
      this.frame(e);
    } catch (err) { console.warn("preview load failed", gltfPath, err); }
  }

  private frame(e: Entity): void {
    const rs = e.getComponentsIncludeChildren(MeshRenderer, []);
    const box = new BoundingBox();
    let has = false;
    for (const r of rs) { if (!r.mesh) continue; if (!has) { box.copyFrom(r.bounds); has = true; } else BoundingBox.merge(box, r.bounds, box); }
    if (has) {
      const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
      e.transform.setPosition(-cx, -cy, -cz);
      const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 1;
      this.dist = size * 2.2;
    }
    this.place();
  }

  private place(): void {
    const cp = Math.cos(this.pitch);
    this.camE.transform.setPosition(this.dist * cp * Math.sin(this.yaw), this.dist * Math.sin(this.pitch), this.dist * cp * Math.cos(this.yaw));
    this.camE.transform.lookAt(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
  }

  private bindDrag(canvas: HTMLCanvasElement): void {
    let down = false, px = 0, py = 0;
    canvas.addEventListener("pointerdown", (e) => { down = true; px = e.clientX; py = e.clientY; });
    window.addEventListener("pointerup", () => { down = false; });
    window.addEventListener("pointermove", (e) => {
      if (!down) return;
      this.yaw -= (e.clientX - px) * 0.01; this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - py) * 0.01));
      px = e.clientX; py = e.clientY; this.place();
    });
  }
}
