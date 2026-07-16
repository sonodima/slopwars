// ─── Diegetic weapon-mounted ammo counter (Halo-style) ───────────────────────
// A small holographic readout physically parented to the first-person viewmodel, so it
// tracks the weapon's every motion — bob, recoil kick, reload dip, draw. It's a canvas
// texture (redrawn only when the readout changes) on a double-sided unlit quad: pure
// masked text — no panel/backing — so only the glowing glyphs float over the weapon.
// It is seated per weapon by the model's `ammo` anchor (authored in the editor); a
// weapon without that anchor shows no readout at all.
import {
  Color, Engine, Entity, MeshRenderer, PrimitiveMesh, RenderFace,
  Texture2D, TextureFilterMode, TextureFormat, TextureWrapMode, UnlitMaterial, Vector4,
} from "@galacean/engine";
import type { ModelAnchor } from "@slopwars/shared";

// default readout orientation (viewmodel space) when the anchor authors no rotation:
// the viewmodel sits to the lower-right of the camera and extends forward (−Z), so a
// ~+76° X-rotation stands the quad up facing back at the eye; the small Y/Z tilts angle
// it toward screen-centre and level it.
const TAG_ROT: [number, number, number] = [76, 7, -3];
const TAG_W = 0.104;   // readout width  (viewmodel units)
const TAG_H = 0.056;   // readout height

const CW = 384, CH = 208; // canvas (texture) resolution — crisp at the tiny quad

export class AmmoTag {
  private holder: Entity;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: Texture2D;
  private last = ""; // last drawn signature — skip redraw when unchanged
  private mounted = false;

  constructor(engine: Engine, parent: Entity) {
    this.holder = parent.createChild("ammotag");

    this.canvas = document.createElement("canvas");
    this.canvas.width = CW; this.canvas.height = CH;
    this.ctx = this.canvas.getContext("2d")!;

    this.tex = new Texture2D(engine, CW, CH, TextureFormat.R8G8B8A8, false);
    this.tex.filterMode = TextureFilterMode.Bilinear;
    this.tex.wrapModeU = TextureWrapMode.Clamp;
    this.tex.wrapModeV = TextureWrapMode.Clamp;

    const mat = new UnlitMaterial(engine);
    mat.baseColor = new Color(1, 1, 1, 1);
    mat.baseTexture = this.tex;
    mat.isTransparent = true;
    mat.renderFace = RenderFace.Double; // visible whichever way the tilt lands
    mat.tilingOffset = new Vector4(1, 1, 0, 0);

    // createPlane lies in the X-Z plane (normal +Y); the holder's rotation stands it up
    // to face the eye. The quad is viewed from its underside, so the canvas uploads
    // unflipped (see upload) for the text to read upright and unmirrored.
    const r = this.holder.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createPlane(engine, TAG_W, TAG_H);
    r.setMaterial(mat);
    r.castShadows = false;
    r.receiveShadows = false;

    this.holder.isActive = false; // shown only once a weapon with an `ammo` anchor mounts it

    // redraw once the bundled HUD fonts are ready (first draw may hit the fallback face)
    document.fonts?.ready.then(() => { this.last = ""; }).catch(() => { /* no-op */ });
  }

  /** seat the readout at a weapon's `ammo` anchor (already scaled into viewmodel space).
   *  Passing null hides it — a weapon without the anchor shows no readout. */
  mount(at: { x: number; y: number; z: number } | null, rot?: ModelAnchor["rot"]): void {
    this.mounted = at !== null;
    this.holder.isActive = this.mounted;
    if (!at) return;
    this.holder.transform.setPosition(at.x, at.y, at.z);
    const r = rot ?? TAG_ROT;
    this.holder.transform.setRotation(r[0], r[1], r[2]);
  }

  /** update the readout; only redraws the canvas when the visible values change. */
  set(name: string, mag: number, reserve: number, reloading: boolean, melee: boolean, throwable: boolean, magMax: number): void {
    if (!this.mounted) return;
    const sig = `${name}|${mag}|${reserve}|${reloading}|${melee}|${throwable}|${magMax}`;
    if (sig === this.last) return;
    this.last = sig;
    this.draw(name, mag, reserve, reloading, melee, throwable, magMax);
  }

  private draw(name: string, mag: number, reserve: number, reloading: boolean, melee: boolean, throwable: boolean, magMax: number): void {
    const c = this.ctx;
    c.clearRect(0, 0, CW, CH);

    // pure text mask — no panel. Every glyph carries its own holo glow.
    const x = 18, baseY = CH - 46;

    // ── weapon label (Rajdhani, dim) ──
    c.textBaseline = "alphabetic";
    c.fillStyle = "#8fd8ea";
    c.shadowColor = "rgba(120,214,255,0.55)"; c.shadowBlur = 10;
    c.font = "700 34px Rajdhani, 'Bahnschrift', sans-serif";
    c.fillText(name.toUpperCase(), x + 2, 44);
    c.shadowBlur = 0;

    const low = !melee && !throwable && (mag <= 0 || (magMax > 0 && mag / magMax <= 0.25));
    const cyan = "#eafaff", red = "#ff6a5a";

    if (reloading) {
      c.fillStyle = "#9becff";
      c.shadowColor = "rgba(120,214,255,0.75)"; c.shadowBlur = 16;
      c.font = "700 62px Rajdhani, 'Bahnschrift', sans-serif";
      c.fillText("RELOAD", x, baseY + 14);
      c.shadowBlur = 0;
      this.upload(); return;
    }

    // ── big magazine number (Orbitron) ──
    const magStr = melee ? "∞" : String(Math.max(0, mag));
    c.fillStyle = low ? red : cyan;
    c.shadowColor = low ? "rgba(255,106,90,0.8)" : "rgba(120,214,255,0.85)";
    c.shadowBlur = 20;
    c.font = "700 104px Orbitron, 'Bahnschrift', sans-serif";
    c.fillText(magStr, x, baseY + 24);
    const magW = c.measureText(magStr).width;

    // ── reserve / spare (Orbitron, dim) ──
    if (!melee) {
      const spare = throwable ? "" : reserve < 0 ? "∞" : String(reserve);
      if (spare) {
        c.fillStyle = "#63c6e0";
        c.shadowColor = "rgba(120,214,255,0.55)"; c.shadowBlur = 12;
        c.font = "700 42px Orbitron, 'Bahnschrift', sans-serif";
        c.fillText("/ " + spare, x + magW + 18, baseY + 16);
      }
    }
    c.shadowBlur = 0;

    this.upload();
  }

  private upload(): void {
    // NO flipY: the quad is viewed from its underside (the −Y face of createPlane after
    // the stand-up rotation), which already inverts V — flipping again mirrored the text
    // vertically (label at the bottom, "/" reading as "\").
    this.tex.setImageSource(this.canvas, 0, false);
  }
}
