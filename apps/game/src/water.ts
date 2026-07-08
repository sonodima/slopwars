// ─── Realistic water: PBR transmission/refraction + animated waves ────────────
// Water is a *material*, not a bespoke object: any box carrying a `water`-type
// material becomes an animated liquid surface. This module owns the shading — it
// reuses the engine's physically-based transmission so the surface refracts the
// scene behind it (needs `camera.opaqueTextureEnabled`), reflects the sky/IBL
// through a low roughness, and tints depth via attenuation. Movement comes from a
// cheap procedural wave normal whose UVs scroll every frame — no custom GLSL, one
// small texture cached per engine, one Vector4 update per frame, so it's cheap
// while looking convincingly liquid. The material factory (materials.ts) calls
// applyWaterLook() to build the PBRMaterial; the map builder attaches a WaterAnim
// to the box entity so the ripples scroll.
import {
  Color, Engine, Entity, PBRMaterial, RefractionMode,
  Script, Texture2D, TextureFormat, TextureWrapMode, Vector4,
} from "@galacean/engine";

const NORMAL_SIZE = 256;
const normalCache = new WeakMap<Engine, Texture2D>();

// ── tileable fractal noise (the seamlessness fix) ────────────────────────────
// The old surface summed three low-frequency sines: seamless, but a small,
// instantly-recognisable motif that repeats ~s/4 times across the plane — the
// "moving squares" you saw were that grid scrolling as one. Fractal (fBm) value
// noise instead layers octaves at 3/6/12/24 cells, so detail exists at every
// scale and there is no single dominant tile the eye can lock onto. Each octave
// wraps on its own integer lattice, so the whole field is still perfectly
// tileable — the repeat is there but no longer visible.

/** hash a wrapped lattice point → pseudo-random value in [0,1) */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
/** quintic smoothstep — C² continuous so the noise has no diagonal creases */
function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

/** value noise at (u,v)∈[0,1) with `f` cells across the tile; wraps mod `f` so
 *  it is seamless when the texture repeats. */
function tileNoise(u: number, v: number, f: number): number {
  const x = u * f, y = v * f;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const x0 = ((xi % f) + f) % f, y0 = ((yi % f) + f) % f;
  const x1 = (x0 + 1) % f, y1 = (y0 + 1) % f;
  const a = hash2(x0, y0), b = hash2(x1, y0), c = hash2(x0, y1), d = hash2(x1, y1);
  const top = a + (b - a) * fx, bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}
// octave frequencies (integers → tileable) and amplitudes; `AMP_SUM` normalises
const OCTAVES: [number, number][] = [[3, 1], [6, 0.5], [12, 0.26], [24, 0.14]];
const AMP_SUM = OCTAVES.reduce((s, [, a]) => s + a, 0);
/** fractal height field ∈ ~[-0.5, 0.5] */
function waterHeight(u: number, v: number): number {
  let h = 0;
  for (const [f, a] of OCTAVES) h += (tileNoise(u, v, f) - 0.5) * a;
  return h / AMP_SUM;
}

/** procedural tangent-space wave normal (fractal ripples) — built once per
 *  engine and reused by every water surface. */
function waveNormal(engine: Engine): Texture2D {
  const cached = normalCache.get(engine);
  if (cached) return cached;
  const tex = new Texture2D(engine, NORMAL_SIZE, NORMAL_SIZE, TextureFormat.R8G8B8A8, false);
  tex.wrapModeU = TextureWrapMode.Repeat;
  tex.wrapModeV = TextureWrapMode.Repeat;

  const eps = 1 / NORMAL_SIZE;
  const slope = NORMAL_SIZE * 0.16;   // gradient → normal tilt (tuned for gentle ripples)
  const buf = new Uint8Array(NORMAL_SIZE * NORMAL_SIZE * 4);
  for (let y = 0; y < NORMAL_SIZE; y++) {
    for (let x = 0; x < NORMAL_SIZE; x++) {
      const u = x / NORMAL_SIZE, v = y / NORMAL_SIZE;
      const nx = (waterHeight(u - eps, v) - waterHeight(u + eps, v)) * slope;
      const nz = (waterHeight(u, v - eps) - waterHeight(u, v + eps)) * slope;
      const inv = 1 / Math.hypot(nx, 1, nz);
      const i = (y * NORMAL_SIZE + x) * 4;
      buf[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);   // tangent (X)
      buf[i + 1] = Math.round((nz * inv * 0.5 + 0.5) * 255); // bitangent (Z)
      buf[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);      // up (Y)
      buf[i + 3] = 255;
    }
  }
  tex.setPixelBuffer(buf);
  normalCache.set(engine, tex);
  return tex;
}

/** scrolls the wave normal's UVs each frame so the surface visibly flows */
export class WaterAnim extends Script {
  mat!: PBRMaterial;
  tiling = 1;
  speed = 0.04;
  private t = 0;
  private v = new Vector4();
  /** current animation phase (seconds) — read/seed it to keep the flow continuous
   *  when the surface is rebuilt (e.g. a live material edit in the editor preview). */
  get phase(): number { return this.t; }
  set phase(t: number) { this.t = t; }
  onUpdate(dt: number): void {
    this.t += dt;
    const off = this.t * this.speed;
    this.v.set(this.tiling, this.tiling, off, off * 0.73);
    this.mat.tilingOffset = this.v;
  }
}

/** per-surface look controls (all optional; omitted fields keep the default look).
 *  These are the tunable fields of a `water`-type material. */
export interface WaterLook {
  color: [number, number, number];    // surface tint (base color rgb)
  opacity: number;                     // base alpha (thin/edge transparency)
  roughness: number;                   // 0 = mirror sky reflection, higher = hazier
  ior: number;                         // index of refraction (1.33 = water)
  flow: number;                        // ripple scroll speed
  waves: number;                       // wave normal strength (ripple height)
  depthColor: [number, number, number]; // attenuation tint the deeper you look
  depth: number;                       // attenuation distance (smaller = tints faster)
  clarity: number;                     // transmission amount (1 = fully see-through)
}

export const WATER_LOOK: WaterLook = {
  color: [0.05, 0.16, 0.2], opacity: 0.92, roughness: 0.08, ior: 1.33,
  flow: 0.04, waves: 0.7, depthColor: [0.16, 0.46, 0.5], depth: 6, clarity: 1.0,
};

/** shade a PBRMaterial as a `water` surface from a WaterLook. `tiling` is the UV
 *  repeat across the surface (larger surfaces tile more so ripples keep a
 *  consistent size); the WaterAnim then scrolls it. Called by the material factory
 *  so a `water`-type material is a normal, cacheable PBRMaterial. */
export function applyWaterLook(engine: Engine, m: PBRMaterial, L: WaterLook, tiling = 1): void {
  m.baseColor = new Color(L.color[0], L.color[1], L.color[2], L.opacity);
  m.roughness = L.roughness;   // glossy → crisp sky/IBL reflection
  m.metallic = 0.0;
  m.ior = L.ior;
  m.normalTexture = waveNormal(engine);
  m.normalTextureIntensity = L.waves;
  m.isTransparent = true;
  m.refractionMode = RefractionMode.Planar;
  m.transmission = L.clarity;  // refract the scene behind (uses camera opaque texture)
  m.attenuationColor = new Color(L.depthColor[0], L.depthColor[1], L.depthColor[2], 1);
  m.attenuationDistance = L.depth;  // deeper → more teal
  m.thickness = 1.2;
  m.tilingOffset = new Vector4(tiling, tiling, 0, 0);
}

/** attach the flow animation to a box entity carrying a water material, so its
 *  ripples scroll. `tiling` must match the material's UV repeat; `flow` the speed.
 *  `startPhase` seeds the elapsed time so a rebuilt surface flows on continuously
 *  instead of snapping back to t=0. Returns the anim so callers can read its phase. */
export function attachWaterAnim(entity: Entity, m: PBRMaterial, tiling: number, flow: number, startPhase = 0): WaterAnim {
  const anim = entity.addComponent(WaterAnim);
  anim.mat = m;
  anim.tiling = tiling;
  anim.speed = flow;
  anim.phase = startPhase;
  return anim;
}
