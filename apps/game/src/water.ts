// ─── Realistic water: custom shader with true refraction + planar reflection ──
// Water is a *material*, not a bespoke object: any box carrying a `water`-type
// material becomes an animated liquid surface. This module owns the whole effect:
//
//  · REFRACTION — the camera's opaque texture is sampled with wave-distorted UVs,
//    and the camera's depth texture turns that into *physically plausible* water:
//    the view-ray distance through the water tints what's below (Beer–Lambert
//    absorption toward `depthColor`), shallow banks stay clear, and a guard
//    re-samples undistorted when the wobble would smear foreground geometry
//    (the classic "objects above water bleed into the refraction" artifact).
//  · REFLECTION — a second camera mirrored about the water plane renders the real
//    scene into a render target each frame (WaterFX below), with an oblique
//    near plane so underwater geometry never leaks into the mirror image. The
//    surface samples it with wave distortion and blends it against the refraction
//    by Schlick fresnel — grazing looks become a mirror, straight-down looks
//    stay transparent, exactly like real water.
//  · SURFACE — two scrolling samples of a tileable fractal wave texture (slopes
//    in RG, height in B) give layered ripples; the height field drives shoreline
//    foam and sun-glint sparkle. A sharp sun specular from the map's directional
//    light completes the look. Everything animates off the engine's global clock
//    (`scene_ElapsedTime`), so there is zero per-frame JS per surface.
//
// The material factory (materials.ts) calls createWaterMaterial(); the map builder
// registers each water box with the GameMap so WaterFX knows the reflection plane.
import {
  Camera, Color, CullMode, DepthTextureMode, Engine, Entity, Layer, Material, Matrix,
  MSAASamples, RenderQueueType, RenderTarget, Scene, Script, Shader, Texture2D,
  TextureFormat, TextureWrapMode, Vector3, Vector4,
} from "@galacean/engine";
import type { DirectLight } from "@galacean/engine";

/** water surfaces live on their own layer so the reflection camera can skip them
 *  (a mirror must not render the mirror itself). */
export const WATER_LAYER = Layer.Layer30;
/** first-person-only geometry (the weapon viewmodel) — excluded from reflections,
 *  where it would otherwise float in the sky above the mirrored camera. */
export const NO_REFLECT_LAYER = Layer.Layer29;

const NORMAL_SIZE = 256;
const normalCache = new WeakMap<Engine, Texture2D>();

// ── tileable fractal wave field ───────────────────────────────────────────────
// fBm value noise with domain warping: detail at every scale, no visible repeat,
// perfectly tileable (each octave wraps on its own integer lattice). See git
// history for the derivation; the output feeds both slopes (ripple normals) and
// height (foam / sparkle masks).

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
const OCTAVES: [number, number][] = [[3, 1], [6, 0.5], [12, 0.26], [24, 0.14]];
const AMP_SUM = OCTAVES.reduce((s, [, a]) => s + a, 0);
const WARP = 0.16;
/** fractal height field ∈ ~[-0.5, 0.5], domain-warped for organic ripples */
function waterHeight(u: number, v: number): number {
  const wu = u + (tileNoise(u, v, 2) - 0.5) * WARP;
  const wv = v + (tileNoise(u + 0.37, v + 0.11, 2) - 0.5) * WARP;
  let h = 0;
  for (const [f, a] of OCTAVES) h += (tileNoise(wu, wv, f) - 0.5) * a;
  return h / AMP_SUM;
}

/** procedural wave texture — slopes in RG (signed, 0.5-biased), height in B —
 *  built once per engine and shared by every water surface. */
function waveTexture(engine: Engine): Texture2D {
  const cached = normalCache.get(engine);
  if (cached) return cached;
  const tex = new Texture2D(engine, NORMAL_SIZE, NORMAL_SIZE, TextureFormat.R8G8B8A8, false);
  tex.wrapModeU = TextureWrapMode.Repeat;
  tex.wrapModeV = TextureWrapMode.Repeat;

  const eps = 1 / NORMAL_SIZE;
  const slope = NORMAL_SIZE * 0.16;   // gradient → slope scale (tuned for gentle ripples)
  const buf = new Uint8Array(NORMAL_SIZE * NORMAL_SIZE * 4);
  for (let y = 0; y < NORMAL_SIZE; y++) {
    for (let x = 0; x < NORMAL_SIZE; x++) {
      const u = x / NORMAL_SIZE, v = y / NORMAL_SIZE;
      const h = waterHeight(u, v);
      const gx = (waterHeight(u - eps, v) - waterHeight(u + eps, v)) * slope;
      const gz = (waterHeight(u, v - eps) - waterHeight(u, v + eps)) * slope;
      const i = (y * NORMAL_SIZE + x) * 4;
      buf[i] = Math.round((Math.max(-1, Math.min(1, gx)) * 0.5 + 0.5) * 255);
      buf[i + 1] = Math.round((Math.max(-1, Math.min(1, gz)) * 0.5 + 0.5) * 255);
      buf[i + 2] = Math.round((h + 0.5) * 255);
      buf[i + 3] = 255;
    }
  }
  tex.setPixelBuffer(buf);
  normalCache.set(engine, tex);
  return tex;
}

// ── the water shader ──────────────────────────────────────────────────────────
// Renders in the transparent queue (after the opaque grab) but *without* alpha
// blending: the "transparency" is the refracted opaque texture, which gives full
// control over absorption and avoids sort artifacts. Scene-level macros gate the
// expensive inputs so the same shader degrades gracefully:
//   SLOP_WATER_DEPTH — camera depth prepass available (real water thickness)
//   SLOP_WATER_REFL  — planar reflection RT available (else procedural sky)

const WATER_VS = /* glsl */ `
attribute vec3 POSITION;
attribute vec3 NORMAL;
attribute vec2 TEXCOORD_0;

uniform mat4 renderer_MVPMat;
uniform mat4 renderer_ModelMat;
uniform mat4 renderer_NormalMat;

varying vec3 v_pos;
varying vec3 v_normal;
varying vec2 v_uv;
varying vec4 v_clip;
#if SCENE_FOG_MODE != 0
uniform mat4 camera_ViewMat;
varying vec3 v_positionVS;
#endif

void main() {
  vec4 wp = renderer_ModelMat * vec4(POSITION, 1.0);
  v_pos = wp.xyz;
  v_normal = normalize((renderer_NormalMat * vec4(NORMAL, 0.0)).xyz);
  v_uv = TEXCOORD_0;
  gl_Position = renderer_MVPMat * vec4(POSITION, 1.0);
  v_clip = gl_Position;
#if SCENE_FOG_MODE != 0
  v_positionVS = (camera_ViewMat * wp).xyz;
#endif
}
`;

const WATER_FS = /* glsl */ `
#include <common>
#include <FogFragmentDeclaration>

uniform vec3 camera_Position;
uniform vec4 scene_ElapsedTime;      // (t, sin t, cos t, 0) — engine global clock
uniform sampler2D camera_OpaqueTexture;
#ifdef SLOP_WATER_DEPTH
uniform sampler2D camera_DepthTexture;
#endif
#ifdef SLOP_WATER_REFL
uniform sampler2D u_waterReflTex;
uniform mat4 u_waterReflVP;
#endif
uniform vec3 u_waterSunDir;          // direction the sun shines (normalized)
uniform vec3 u_waterSunColor;
uniform sampler2D u_waveTex;         // RG: slopes (0.5-biased), B: height
uniform vec4 u_waterColor;           // rgb shallow tint, a: opacity (turbidity)
uniform vec4 u_waterDeep;            // rgb deep-water color, a: attenuation distance
uniform vec4 u_waterParams;          // x: flow, y: waves, z: fresnel F0, w: roughness
uniform vec4 u_waterMisc;            // x: clarity, y: uv tiling, z: refr strength, w: refl distort

varying vec3 v_pos;
varying vec3 v_normal;
varying vec2 v_uv;
varying vec4 v_clip;

#ifdef SLOP_WATER_DEPTH
float slopSceneEyeDepth(vec2 uv) {
  return remapDepthBufferEyeDepth(texture2D(camera_DepthTexture, uv).r);
}
#endif

// procedural sky for surfaces without a planar reflection (editor preview)
vec3 slopSkyFallback(vec3 r, float sunUp) {
  float h = saturate(r.y);
  vec3 hor = vec3(0.72, 0.78, 0.84);
  vec3 zen = vec3(0.30, 0.46, 0.66);
  return mix(hor, zen, pow(h, 0.55)) * (0.55 + 0.6 * sunUp);
}

void main() {
  float t = scene_ElapsedTime.x;
  float flow = u_waterParams.x;
  float waves = u_waterParams.y;
  float rough = saturate(u_waterParams.w);
  float tiling = u_waterMisc.y;

  // ── layered scrolling waves: a slow curved drift + a counter-scrolling detail
  // layer at ~2.1× scale — no single direction the eye can lock onto. The base
  // scale "breathes" so wavelets swell like spreading rings.
  vec2 baseUV = v_uv * tiling;
  vec2 uv1 = baseUV * (1.0 + sin(t * 0.4) * 0.04)
           + vec2(t * flow * 0.60 + sin(t * 0.35) * 0.03,
                  t * flow * 0.42 + cos(t * 0.27) * 0.03);
  vec2 uv2 = baseUV * 2.13
           - vec2(t * flow * 0.47 - cos(t * 0.23) * 0.02,
                  t * flow * 0.31 - sin(t * 0.31) * 0.02);
  vec4 w1 = texture2D(u_waveTex, uv1);
  vec4 w2 = texture2D(u_waveTex, uv2);
  vec2 grad = (w1.rg * 2.0 - 1.0) + (w2.rg * 2.0 - 1.0) * 0.65;
  float crest = saturate(w1.b * 0.62 + w2.b * 0.62);  // wave height ∈ ~[0,1]
  // crests pulse a touch so the surface feels alive rather than a looping texture
  float amp = waves * (0.85 + sin(t * 0.9) * 0.15);
  vec3 nTS = normalize(vec3(grad.x * amp, 1.0, grad.y * amp));

  // tangent frame from the geometry normal (water boxes are axis-aligned; the top
  // face gets the natural XZ frame, side faces a stable fallback)
  vec3 gN = normalize(v_normal);
  vec3 upRef = abs(gN.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 T = normalize(cross(upRef, gN));
  vec3 B = cross(gN, T);
  vec3 N = normalize(T * nTS.x + B * nTS.z + gN * nTS.y);

  vec3 V = normalize(camera_Position - v_pos);
  float sunUp = saturate(dot(-u_waterSunDir, vec3(0.0, 1.0, 0.0)));

  // ── refraction: sample the opaque scene with wave-distorted screen UVs ──
  vec2 suv = v_clip.xy / v_clip.w * 0.5 + 0.5;
  float eyeD = v_clip.w;                       // perspective: w = eye depth
  float refrStrength = u_waterMisc.z;

#ifdef SLOP_WATER_DEPTH
  float floorD = slopSceneEyeDepth(suv);
  float thick0 = max(floorD - eyeD, 0.0);      // water column along the view ray
  // distortion scales with wave slope, fades at the shoreline (thin water can't
  // bend much) and with distance (far water shouldn't shimmer wildly)
  vec2 distort = nTS.xz * refrStrength * saturate(thick0 * 1.4) / max(eyeD * 0.30, 1.0);
  vec2 ruv = suv + distort;
  float floorD2 = slopSceneEyeDepth(ruv);
  // guard: if the distorted UV lands on something in FRONT of the water surface
  // (a wall, a player above the waterline) fall back to the straight sample —
  // otherwise foreground pixels smear into the refraction.
  if (floorD2 < eyeD + 0.02) { ruv = suv; floorD2 = floorD; }
  float thick = max(floorD2 - eyeD, 0.0);
#else
  vec2 ruv = suv + nTS.xz * refrStrength * 0.35;
  float thick0 = 1.4;                          // no depth available: assume ~1.4m
  float thick = thick0;
#endif

  // slight chromatic dispersion — red and blue bend marginally differently
  vec2 dr = (ruv - suv) * 0.94 + suv;
  vec2 db = (ruv - suv) * 1.06 + suv;
  vec3 refr = vec3(
    texture2DSRGB(camera_OpaqueTexture, dr).r,
    texture2DSRGB(camera_OpaqueTexture, ruv).g,
    texture2DSRGB(camera_OpaqueTexture, db).b);

  // ── absorption + scatter (Beer–Lambert through 'thick' metres) ──
  vec3 deepC = u_waterDeep.rgb;
  float dd = max(u_waterDeep.a, 0.05);
  float density = mix(0.5, 2.2, saturate(u_waterColor.a));   // opacity = turbidity
  float atten = exp(-thick * density / dd);
  // transmitted light shifts toward the water hue with depth …
  vec3 seen = refr * pow(clamp(deepC * 1.25 + 0.15, 0.0, 1.0), vec3(thick / dd));
  // … and a mild shallow tint keeps even clear water from reading as plain glass
  vec3 tintN = u_waterColor.rgb / max(max(u_waterColor.r, max(u_waterColor.g, u_waterColor.b)), 0.02);
  seen *= mix(vec3(1.0), tintN, 0.22);
  // deep water converges on the sunlit body color instead of black
  vec3 body = deepC * (0.30 + 0.85 * sunUp);
  float visFloor = atten * mix(0.3, 1.0, saturate(u_waterMisc.x));  // clarity
  vec3 transmitted = mix(body, seen, visFloor);

  // ── reflection: real mirrored scene when available, procedural sky otherwise ──
#ifdef SLOP_WATER_REFL
  vec3 wobbled = v_pos + vec3(nTS.x, 0.0, nTS.z) * u_waterMisc.w;
  vec4 rp = u_waterReflVP * vec4(wobbled, 1.0);
  vec2 rUV = clamp(rp.xy / rp.w * 0.5 + 0.5, vec2(0.002), vec2(0.998));
  // tiny cross blur widens with roughness so hazier water gets softer mirrors
  vec2 rb = vec2(0.0015 + rough * 0.012);
  vec3 refl = texture2D(u_waterReflTex, rUV).rgb * 0.4
            + texture2D(u_waterReflTex, rUV + vec2(rb.x, 0.0)).rgb * 0.15
            + texture2D(u_waterReflTex, rUV - vec2(rb.x, 0.0)).rgb * 0.15
            + texture2D(u_waterReflTex, rUV + vec2(0.0, rb.y)).rgb * 0.15
            + texture2D(u_waterReflTex, rUV - vec2(0.0, rb.y)).rgb * 0.15;
#else
  vec3 refl = slopSkyFallback(reflect(-V, N), sunUp);
#endif

  // ── fresnel blend (Schlick) — grazing angles mirror, steep angles transmit.
  // The blend normal leans toward the geometry normal so the horizon line stays
  // stable while the waves still modulate it.
  vec3 fN = normalize(mix(gN, N, 0.6));
  float NoV = saturate(dot(fN, V));
  float f0 = u_waterParams.z;
  float fres = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);
  fres = saturate(fres * (1.0 - rough * 0.45));
  vec3 col = mix(transmitted, refl, fres);

  // ── sun glint: sharp specular sparkling on wave crests ──
  vec3 L = -u_waterSunDir;
  vec3 H = normalize(L + V);
  float spec = pow(saturate(dot(N, H)), mix(720.0, 56.0, rough));
  col += u_waterSunColor * spec * (0.35 + 0.9 * crest) * (0.4 + 0.6 * fres) * 1.6;

#ifdef SLOP_WATER_DEPTH
  // ── shoreline: soft foam collar where the water thins out, plus a whisper of
  // crest foam in open water; then feather the last centimetres so banks never
  // show a hard polygon edge.
  float shore = 1.0 - saturate(thick0 / 0.45);
  float foam = shore * smoothstep(0.42, 0.78, crest + shore * 0.38)
             + smoothstep(0.86, 0.99, crest) * 0.10;
  col = mix(col, vec3(0.92, 0.95, 0.96) * (0.35 + 0.75 * sunUp), saturate(foam) * 0.55);
  float edge = saturate(thick0 / 0.10);
  vec3 bg = texture2DSRGB(camera_OpaqueTexture, suv).rgb;
  col = mix(bg, col, edge);
#endif

#if SCENE_FOG_MODE != 0
  float fogI = ComputeFogIntensity(length(v_positionVS));
  col = mix(scene_FogColor.rgb, col, fogI);
#endif

  gl_FragColor = outputSRGBCorrection(vec4(col, 1.0));
}
`;

function waterShader(): Shader {
  return Shader.find("slop-water") ?? Shader.create("slop-water", WATER_VS, WATER_FS);
}

// ── material factory ──────────────────────────────────────────────────────────

/** per-surface look controls (all optional in the def; omitted fields keep the
 *  default look). These are the tunable fields of a `water`-type material. */
export interface WaterLook {
  color: [number, number, number];    // shallow-water tint
  opacity: number;                     // turbidity (how milky the volume is)
  roughness: number;                   // 0 = mirror reflection, higher = hazier
  ior: number;                         // index of refraction (1.33 = water)
  flow: number;                        // ripple scroll speed
  waves: number;                       // wave strength (ripple height)
  depthColor: [number, number, number]; // color the water absorbs toward with depth
  depth: number;                       // attenuation distance (smaller = tints faster)
  clarity: number;                     // how much of the refracted floor survives
}

export const WATER_LOOK: WaterLook = {
  color: [0.05, 0.16, 0.2], opacity: 0.92, roughness: 0.08, ior: 1.33,
  flow: 0.04, waves: 0.7, depthColor: [0.16, 0.46, 0.5], depth: 6, clarity: 1.0,
};

/** build a water Material from a WaterLook. `tiling` is the UV repeat across the
 *  surface (larger surfaces tile more so ripples keep a consistent world size).
 *  The surface animates itself off the engine clock — nothing to attach. */
export function createWaterMaterial(engine: Engine, L: WaterLook, tiling = 1): Material {
  const m = new Material(engine, waterShader());
  // transparent queue (renders after the opaque grab) but no blending — the
  // shader composes its own refraction, so it writes opaque, sorted color.
  m.renderState.renderQueueType = RenderQueueType.Transparent;
  m.renderState.depthState.writeEnabled = false;
  m.renderState.rasterState.cullMode = CullMode.Back;
  const sd = m.shaderData;
  sd.setTexture("u_waveTex", waveTexture(engine));
  sd.setVector4("u_waterColor", new Vector4(L.color[0], L.color[1], L.color[2], L.opacity));
  sd.setVector4("u_waterDeep", new Vector4(L.depthColor[0], L.depthColor[1], L.depthColor[2], L.depth));
  const f0 = ((L.ior - 1) / (L.ior + 1)) ** 2;
  sd.setVector4("u_waterParams", new Vector4(L.flow, L.waves, f0, L.roughness));
  // refraction strength scales with how far the IOR is from air's 1.0
  const refr = 0.10 * Math.min(2, Math.max(0.25, (L.ior - 1) / 0.33));
  sd.setVector4("u_waterMisc", new Vector4(L.clarity, tiling, refr, 0.55 * L.waves));
  return m;
}

/** seed the scene-level water uniforms with a static sun — for scenes that don't
 *  run a WaterFX (the editor's material preview). The main game/editor viewport
 *  overwrite these every frame from the real sun. */
export function setWaterSun(scene: Scene, dir: Vector3, color: Color): void {
  const d = dir.clone().normalize();
  scene.shaderData.setVector3("u_waterSunDir", d);
  scene.shaderData.setVector3("u_waterSunColor", new Vector3(color.r, color.g, color.b));
}

// ── WaterFX: the planar-reflection system ─────────────────────────────────────

const REFL_BIAS = 0.02;   // clip-plane bias below the surface (kills waterline z-slivers)

/** mirror-about-plane(y=h) matrix, column-major into `out` */
function mirrorY(h: number, out: Matrix): void {
  const e = out.elements;
  e[0] = 1; e[1] = 0; e[2] = 0; e[3] = 0;
  e[4] = 0; e[5] = -1; e[6] = 0; e[7] = 0;
  e[8] = 0; e[9] = 0; e[10] = 1; e[11] = 0;
  e[12] = 0; e[13] = 2 * h; e[14] = 0; e[15] = 1;
}

/** Lengyel oblique near-plane: warp `proj` (in place) so its near plane becomes
 *  `c` (a clip plane in VIEW space, camera on the negative side). Keeps the far
 *  plane roughly intact; standard planar-reflection clipping. */
function makeOblique(proj: Matrix, cx: number, cy: number, cz: number, cw: number): void {
  const m = proj.elements;
  const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const qx = (sgn(cx) + m[8]) / m[0];
  const qy = (sgn(cy) + m[9]) / m[5];
  const qz = -1;
  const qw = (1 + m[10]) / m[14];
  const s = 2 / (cx * qx + cy * qy + cz * qz + cw * qw);
  m[2] = cx * s;
  m[6] = cy * s;
  m[10] = cz * s + 1;
  m[14] = cw * s;
}

/**
 * Renders the scene mirrored about the map's water plane into a render target,
 * once per frame, and publishes it (plus the mirrored view-projection and the
 * live sun) as scene-level shader data for every water material to sample.
 *
 * One reflection plane per map: the largest water surface wins (maps virtually
 * always have a single water level; smaller pools at other heights still get
 * refraction + fresnel, their reflection is just projected from the main plane).
 *
 * Attach once via WaterFX.attach(); call setWater() after every map (re)build.
 */
export class WaterFX extends Script {
  private mainCam!: Camera;
  private sun: DirectLight | null = null;
  private reflCam!: Camera;
  private reflTex!: Texture2D;
  private planeY: number | null = null;

  private tmpMirror = new Matrix();
  private tmpView = new Matrix();
  private tmpProj = new Matrix();
  private tmpInv = new Matrix();
  private tmpVP = new Matrix();
  private sunDir = new Vector3();
  private sunCol = new Vector3();

  /** create the reflection camera + RT under `root`, driven by `mainCam`. */
  static attach(root: Entity, mainCam: Camera, sun: DirectLight | null = null): WaterFX {
    const engine = root.engine;
    const fx = root.createChild("water-fx").addComponent(WaterFX);
    fx.mainCam = mainCam;
    fx.sun = sun;

    const e = root.createChild("water-reflection");
    const cam = e.addComponent(Camera);
    cam.enabled = false;                     // rendered manually, before the main camera
    cam.cullingMask = (Layer.Everything & ~(WATER_LAYER | NO_REFLECT_LAYER)) as Layer;
    cam.farClipPlane = mainCam.farClipPlane;
    cam.enablePostProcess = false;           // linear scene colors; tonemapped via the surface
    cam.enableHDR = false;
    cam.opaqueTextureEnabled = false;
    cam.msaaSamples = MSAASamples.None;
    // half-ish resolution is plenty — the sample is wave-distorted anyway
    const size = Math.max(engine.canvas.width, engine.canvas.height) >= 1600 ? 1024 : 512;
    const tex = new Texture2D(engine, size, size, TextureFormat.R8G8B8A8, false);
    tex.wrapModeU = TextureWrapMode.Clamp;
    tex.wrapModeV = TextureWrapMode.Clamp;
    cam.renderTarget = new RenderTarget(engine, size, size, tex);
    fx.reflCam = cam;
    fx.reflTex = tex;
    return fx;
  }

  /** point the system at the map's water plane (null = map has no water).
   *  Toggles the depth prepass + shader features so waterless maps pay nothing. */
  setWater(planeY: number | null): void {
    this.planeY = planeY;
    const scene = this.entity.scene;
    const on = planeY != null;
    this.mainCam.depthTextureMode = on ? DepthTextureMode.PrePass : DepthTextureMode.None;
    if (on) {
      scene.shaderData.enableMacro("SLOP_WATER_DEPTH");
      scene.shaderData.enableMacro("SLOP_WATER_REFL");
      scene.shaderData.setTexture("u_waterReflTex", this.reflTex);
    } else {
      scene.shaderData.disableMacro("SLOP_WATER_DEPTH");
      scene.shaderData.disableMacro("SLOP_WATER_REFL");
    }
  }

  override onLateUpdate(): void {
    const h = this.planeY;
    if (h == null) return;
    const scene = this.entity.scene;

    // live sun → glints + water body lighting track the map's env
    if (this.sun) {
      const f = this.sun.entity.transform.worldForward;
      this.sunDir.set(f.x, f.y, f.z);
      const c = this.sun.color;
      this.sunCol.set(c.r, c.g, c.b);
    } else {
      this.sunDir.set(-0.45, -0.7, -0.55).normalize();
      this.sunCol.set(1.2, 1.15, 1.0);
    }
    scene.shaderData.setVector3("u_waterSunDir", this.sunDir);
    scene.shaderData.setVector3("u_waterSunColor", this.sunCol);

    // under the surface the top face is backface-culled — nothing to reflect into
    const camPos = this.mainCam.entity.transform.worldPosition;
    if (camPos.y <= h + 0.03) return;

    // mirrored view: V_refl = V_main · mirror(y=h)
    mirrorY(h, this.tmpMirror);
    Matrix.multiply(this.mainCam.viewMatrix, this.tmpMirror, this.tmpView);

    // projection: copy the main projection, flip X to restore triangle winding
    // (the mirror flips handedness), then clip everything below the water plane
    // with an oblique near plane so submerged geometry can't haunt the mirror.
    this.tmpProj.copyFrom(this.mainCam.projectionMatrix);
    const p = this.tmpProj.elements;
    p[0] = -p[0]; p[4] = -p[4]; p[8] = -p[8]; p[12] = -p[12];
    Matrix.invert(this.tmpView, this.tmpInv);
    // world plane (0,1,0,-(h-bias)) → view space via (V⁻¹)ᵀ: dot each column with the plane
    const ie = this.tmpInv.elements;
    const wy = 1, ww = -(h - REFL_BIAS);
    makeOblique(
      this.tmpProj,
      ie[1] * wy + ie[3] * ww,
      ie[5] * wy + ie[7] * ww,
      ie[9] * wy + ie[11] * ww,
      ie[13] * wy + ie[15] * ww,
    );

    // seat the entity at the mirrored eye (render-queue distance sorting) and
    // hand the camera its custom matrices
    this.reflCam.entity.transform.setPosition(camPos.x, 2 * h - camPos.y, camPos.z);
    this.reflCam.viewMatrix = this.tmpView;
    this.reflCam.projectionMatrix = this.tmpProj;

    Matrix.multiply(this.tmpProj, this.tmpView, this.tmpVP);
    scene.shaderData.setMatrix("u_waterReflVP", this.tmpVP);

    this.reflCam.render();
  }
}
