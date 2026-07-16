// ─── Diegetic weapon-mounted ammo counter (Halo-style) ───────────────────────
// A small holographic panel physically parented to the first-person viewmodel, so it
// tracks the weapon's every motion — bob, recoil kick, reload dip, draw. It's a canvas
// texture (redrawn only when the readout changes) on a double-sided unlit quad, styled to
// match the 2D holographic HUD (cyan glass, Orbitron numerals, Rajdhani label).
import {
  Color, Engine, Entity, MeshRenderer, PrimitiveMesh, RenderFace,
  Texture2D, TextureFilterMode, TextureFormat, TextureWrapMode, UnlitMaterial, Vector4,
} from "@galacean/engine";

// ── mount transform in viewmodel space (TUNABLE) ──
// The viewmodel sits to the lower-right of the camera and extends forward (−Z), so the eye
// is toward +Z (and up). createPlane's quad has a +Y normal, so a ~+75° X-rotation stands
// it up facing back at the eye; the small Y/Z tilts angle it toward screen-centre and level
// it. These seat the panel just above the receiver — nudge them per weapon if needed.
const TAG_POS: [number, number, number] = [-0.016, 0.05, -0.008];
const TAG_ROT: [number, number, number] = [76, 7, -3];
const TAG_W = 0.104;   // panel width  (viewmodel units)
const TAG_H = 0.056;   // panel height

const CW = 384, CH = 208; // canvas (texture) resolution — 2:1-ish, crisp at the tiny quad

export class AmmoTag {
  private holder: Entity;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: Texture2D;
  private last = ""; // last drawn signature — skip redraw when unchanged

  constructor(engine: Engine, parent: Entity) {
    this.holder = parent.createChild("ammotag");
    this.holder.transform.setPosition(TAG_POS[0], TAG_POS[1], TAG_POS[2]);
    this.holder.transform.setRotation(TAG_ROT[0], TAG_ROT[1], TAG_ROT[2]);

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

    // createPlane lies in the X-Z plane (normal +Y); the holder's rotation stands it up to
    // face the eye. Double-sided + a flipped upload keep the text upright + readable.
    const r = this.holder.addComponent(MeshRenderer);
    r.mesh = PrimitiveMesh.createPlane(engine, TAG_W, TAG_H);
    r.setMaterial(mat);
    r.castShadows = false;
    r.receiveShadows = false;

    // redraw once the bundled HUD fonts are ready (first draw may hit the fallback face)
    document.fonts?.ready.then(() => { this.last = ""; }).catch(() => { /* no-op */ });
  }

  /** update the readout; only redraws the canvas when the visible values change. */
  set(name: string, mag: number, reserve: number, reloading: boolean, melee: boolean, throwable: boolean, magMax: number): void {
    const sig = `${name}|${mag}|${reserve}|${reloading}|${melee}|${throwable}|${magMax}`;
    if (sig === this.last) return;
    this.last = sig;
    this.draw(name, mag, reserve, reloading, melee, throwable, magMax);
  }

  private draw(name: string, mag: number, reserve: number, reloading: boolean, melee: boolean, throwable: boolean, magMax: number): void {
    const c = this.ctx;
    c.clearRect(0, 0, CW, CH);

    // ── holographic glass panel (chamfered, cyan edge) ──
    const pad = 14, ch = 26;
    const x = pad, y = pad, w = CW - pad * 2, h = CH - pad * 2;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + w - ch, y);
    c.lineTo(x + w, y + ch);
    c.lineTo(x + w, y + h);
    c.lineTo(x + ch, y + h);
    c.lineTo(x, y + h - ch);
    c.closePath();
    const bg = c.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, "rgba(14,34,42,0.82)");
    bg.addColorStop(1, "rgba(6,14,18,0.64)");
    c.fillStyle = bg; c.fill();
    c.lineWidth = 3; c.strokeStyle = "rgba(155,236,255,0.65)";
    c.shadowColor = "rgba(120,214,255,0.7)"; c.shadowBlur = 12; c.stroke();
    c.shadowBlur = 0;

    // scanline film
    c.fillStyle = "rgba(155,236,255,0.06)";
    for (let sy = y + 3; sy < y + h; sy += 4) c.fillRect(x, sy, w, 1);

    // bright top tick
    const tg = c.createLinearGradient(x, 0, x + w, 0);
    tg.addColorStop(0, "rgba(155,236,255,0)");
    tg.addColorStop(0.5, "rgba(155,236,255,0.95)");
    tg.addColorStop(1, "rgba(155,236,255,0)");
    c.fillStyle = tg; c.fillRect(x + 8, y + 1, w - 34, 2);

    // ── weapon label (Rajdhani) ──
    c.textBaseline = "alphabetic";
    c.fillStyle = "#8fd8ea";
    c.font = "700 30px Rajdhani, 'Bahnschrift', sans-serif";
    c.fillText(name.toUpperCase(), x + 20, y + 44);

    const low = !melee && !throwable && (mag <= 0 || (magMax > 0 && mag / magMax <= 0.25));
    const cyan = "#eafaff", red = "#ff6a5a";

    if (reloading) {
      c.fillStyle = "#9becff";
      c.shadowColor = "rgba(120,214,255,0.75)"; c.shadowBlur = 16;
      c.font = "700 58px Rajdhani, 'Bahnschrift', sans-serif";
      c.fillText("RELOAD", x + 20, y + h - 34);
      c.shadowBlur = 0;
      this.upload(); return;
    }

    // ── big magazine number (Orbitron) ──
    let magStr: string;
    if (melee) magStr = "∞";
    else magStr = String(Math.max(0, mag));
    c.fillStyle = low ? red : cyan;
    c.shadowColor = low ? "rgba(255,106,90,0.8)" : "rgba(120,214,255,0.85)";
    c.shadowBlur = 20;
    c.font = "700 96px Orbitron, 'Bahnschrift', sans-serif";
    c.fillText(magStr, x + 18, y + h - 28);
    const magW = c.measureText(magStr).width;
    c.shadowBlur = 0;

    // ── reserve / spare (Orbitron, dim) ──
    if (!melee) {
      c.fillStyle = "#63c6e0";
      c.font = "700 38px Orbitron, 'Bahnschrift', sans-serif";
      const spare = throwable ? "" : reserve < 0 ? "∞" : String(reserve);
      if (spare) c.fillText("/ " + spare, x + 34 + magW, y + h - 34);
    }

    // ── magazine fill bar along the bottom edge ──
    if (!melee && magMax > 0) {
      const frac = Math.max(0, Math.min(1, mag / magMax));
      const bx = x + 18, by = y + h - 12, bw = w - 36, bh = 4;
      c.fillStyle = "rgba(155,236,255,0.16)";
      c.fillRect(bx, by, bw, bh);
      c.fillStyle = low ? red : "#9becff";
      c.shadowColor = low ? "rgba(255,106,90,0.7)" : "rgba(120,214,255,0.7)"; c.shadowBlur = 8;
      c.fillRect(bx, by, bw * frac, bh);
      c.shadowBlur = 0;
    }

    this.upload();
  }

  private upload(): void {
    // flipY so the canvas' top-left origin lands upright on the plane's UVs
    this.tex.setImageSource(this.canvas, 0, true);
  }
}
