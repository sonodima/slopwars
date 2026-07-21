// ─── Atmosphere pass: volumetric height fog, ground mist and sun rays ─────────
// One near-plane quad glued to the main camera does all three screen-space
// effects in a single fragment pass over the depth prepass — one depth read
// funds the fog AND seeds the god-ray march, and the premultiplied blend lets
// absorbing fog (alpha) and additive light shafts (rgb) coexist in one draw.
//
//  · HEIGHT FOG — analytic integral of an exponential density profile along the
//    view ray (no marching): fog thickens toward the ground and with distance.
//  · GROUND MIST — a second, denser and much thinner exponential band, broken
//    up by two counter-drifting fbm noise samples along the ray so it reads as
//    slowly-rolling volumetric wisps rather than a flat gradient.
//  · SUN RAYS — classic screen-space light shafts: a short radial march toward
//    the sun's screen position gathers "sky visibility" from the depth buffer,
//    so geometry between camera and sun carves shafts out of the glow. Only
//    works with the sun on/near screen — the CPU side fades `visibility` to 0
//    as the sun leaves the view, which is exactly how these shafts behave.
//
// The quad lives on NO_REFLECT_LAYER: the water-reflection and portal cameras
// already exclude that layer, which is precisely right — this pass must only
// ever run for the main eye (it reads the MAIN camera's depth + projection).
import {
  BlendFactor, Camera, CullMode, Engine, Entity, Material, MeshRenderer, PrimitiveMesh,
  RenderQueueType, Script, Shader, Texture2D, TextureFormat, TextureWrapMode, Vector3, Vector4,
} from "@galacean/engine";
import type { DirectLight } from "@galacean/engine";
import { NO_REFLECT_LAYER } from "./water";
import type { EnvMist, EnvRays } from "./maps/schema";

// ── tileable 2D fbm noise (mist wisps) — generated once per engine ────────────
const NOISE_SIZE = 128;
const noiseCache = new WeakMap<Engine, Texture2D>();

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
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

function fogNoiseTexture(engine: Engine): Texture2D {
  const cached = noiseCache.get(engine);
  if (cached) return cached;
  const tex = new Texture2D(engine, NOISE_SIZE, NOISE_SIZE, TextureFormat.R8, false);
  tex.wrapModeU = TextureWrapMode.Repeat;
  tex.wrapModeV = TextureWrapMode.Repeat;
  const buf = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  for (let y = 0; y < NOISE_SIZE; y++) {
    for (let x = 0; x < NOISE_SIZE; x++) {
      const u = x / NOISE_SIZE, v = y / NOISE_SIZE;
      const n = tileNoise(u, v, 4) * 0.55 + tileNoise(u, v, 8) * 0.3 + tileNoise(u, v, 16) * 0.15;
      buf[y * NOISE_SIZE + x] = (n * 255) | 0;
    }
  }
  tex.setPixelBuffer(buf);
  noiseCache.set(engine, tex);
  return tex;
}

// ── the atmosphere shader ─────────────────────────────────────────────────────
// The quad ignores its transform entirely: POSITION.xz IS the NDC coordinate,
// so the pass is fullscreen no matter how the camera moves. View rays are
// reconstructed from the camera basis (right/up premultiplied by tan half-fov),
// giving dot(ray, forward) == 1 — so `cam + ray * eyeDepth` lands exactly on
// the world point the depth buffer describes.

const ATMO_VS = /* glsl */ `
attribute vec3 POSITION;
varying vec2 v_ndc;
void main() {
  v_ndc = vec2(POSITION.x, POSITION.z);
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}
`;

const ATMO_FS = /* glsl */ `
#include <common>
uniform sampler2D camera_DepthTexture;
uniform sampler2D u_atmoNoise;
uniform vec3 u_atmoCamPos;
uniform vec3 u_atmoFwd;
uniform vec3 u_atmoRight;   // right * tan(fovX/2)
uniform vec3 u_atmoUp;      // up * tan(fovY/2)
uniform vec3 u_atmoSunDir;  // direction the sun shines (normalized)
uniform vec4 u_mistA;       // x: fog density, y: fog height scale, z: mist density, w: mist height
uniform vec4 u_mistB;       // rgb: fog colour, w: ground base Y
uniform vec4 u_mistC;       // x: time (drift), y: far plane, z: sky haze cap, w: unused
uniform vec4 u_raysA;       // rgb: shaft colour, w: intensity
uniform vec4 u_raysB;       // xy: sun screen uv, z: visibility, w: aspect
varying vec2 v_ndc;

const int RAY_TAPS = 24;

void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec3 rd = u_atmoFwd + u_atmoRight * v_ndc.x + u_atmoUp * v_ndc.y;
  float eyeD = remapDepthBufferEyeDepth(texture2D(camera_DepthTexture, uv).r);
  float far = u_mistC.y;
  float isSky = step(far * 0.93, eyeD);
  float L = min(eyeD, far);
  vec3 rdn = normalize(rd);

  vec3 rgb = vec3(0.0);
  float alpha = 0.0;

#ifdef SLOP_ATMO_MIST
  float relY = max(u_atmoCamPos.y - u_mistB.w, 0.0);
  float dy = rd.y * L;
  // analytic ∫ exp(-h/H) dh along the ray; the |dy|→0 limit is 1
  float H = u_mistA.y;
  float kH = abs(dy) < 0.01 ? 1.0 : (1.0 - exp(-dy / H)) / (dy / H);
  float fogAmt = u_mistA.x * 0.014 * L * exp(-relY / H) * max(kH, 0.0);

  float Hg = u_mistA.w;
  float kG = abs(dy) < 0.01 ? 1.0 : (1.0 - exp(-dy / Hg)) / (dy / Hg);
  // two drifting noise reads along the ray break the band into rolling wisps
  vec3 p1 = u_atmoCamPos + rd * min(L, 18.0) * 0.6;
  vec3 p2 = u_atmoCamPos + rd * min(L, 42.0);
  float t = u_mistC.x;
  float n = texture2D(u_atmoNoise, p1.xz * 0.041 + vec2(t * 0.013, t * 0.007)).r * 0.62
          + texture2D(u_atmoNoise, p2.xz * 0.017 - vec2(t * 0.008, t * 0.011)).r * 0.38;
  float mistAmt = u_mistA.z * 0.11 * min(L, 60.0) * exp(-relY / Hg) * max(kG, 0.0) * mix(0.2, 1.8, n);

  alpha = 1.0 - exp(-(fogAmt + mistAmt));
  // sky pixels only haze near the horizon — the zenith stays clear
  alpha *= mix(1.0, clamp(1.0 - rdn.y * 2.8, 0.0, 1.0) * u_mistC.z, isSky);
  float sunAmt = pow(clamp(dot(rdn, -u_atmoSunDir), 0.0, 1.0), 6.0);
  rgb = u_mistB.rgb * (0.78 + 0.5 * sunAmt) * alpha;
#endif

#ifdef SLOP_ATMO_RAYS
  float vis = u_raysB.z * u_raysA.w;
  if (vis > 0.002) {
    vec2 suv = u_raysB.xy;
    vec2 duv = (suv - uv) / float(RAY_TAPS);
    vec2 p = uv;
    float w = 1.0;
    float occ = 0.0;
    float tw = 0.0;
    for (int i = 0; i < RAY_TAPS; i++) {
      p += duv;
      float dpt = remapDepthBufferEyeDepth(texture2D(camera_DepthTexture, clamp(p, vec2(0.001), vec2(0.999))).r);
      occ += step(far * 0.93, dpt) * w;
      tw += w;
      w *= 0.93;
    }
    float shaft = occ / tw;
    vec2 dd = (suv - uv) * vec2(u_raysB.w, 1.0);
    float fall = exp(-dot(dd, dd) * 3.2);
    rgb += u_raysA.rgb * (shaft * shaft * fall * vis);
  }
#endif

  gl_FragColor = outputSRGBCorrection(vec4(rgb, alpha));
}
`;

function atmoShader(): Shader {
  return Shader.find("slop-atmo") ?? Shader.create("slop-atmo", ATMO_VS, ATMO_FS);
}

export class AtmoFX extends Script {
  private cam!: Camera;
  private quad!: Entity;
  private mat!: Material;
  private sun: DirectLight | null = null;
  private mistOn = false;
  private raysOn = false;
  private speed = 1;
  private time = 0;
  private sunDir = new Vector3();
  private sunPoint = new Vector3();
  private vp = new Vector3();

  static attach(root: Entity, cam: Camera, sun: DirectLight | null): AtmoFX {
    const engine = root.engine;
    const fx = root.createChild("atmo-fx").addComponent(AtmoFX);
    fx.cam = cam;
    fx.sun = sun;

    const quad = cam.entity.createChild("atmo-quad");
    quad.layer = NO_REFLECT_LAYER;              // main eye only (see header)
    quad.transform.setPosition(0, 0, -0.5);     // keeps renderer bounds in-frustum
    const mr = quad.addComponent(MeshRenderer);
    mr.mesh = PrimitiveMesh.createPlane(engine, 2, 2);
    mr.castShadows = false;
    mr.receiveShadows = false;
    const m = new Material(engine, atmoShader());
    m.renderState.renderQueueType = RenderQueueType.Transparent;
    m.renderState.rasterState.cullMode = CullMode.Off;
    m.renderState.depthState.enabled = false;   // fullscreen — nothing to test against
    m.renderState.depthState.writeEnabled = false;
    // premultiplied blend: rgb carries fog·alpha + additive shafts, a absorbs
    const bs = m.renderState.blendState.targetBlendState;
    bs.enabled = true;
    bs.sourceColorBlendFactor = BlendFactor.One;
    bs.destinationColorBlendFactor = BlendFactor.OneMinusSourceAlpha;
    bs.sourceAlphaBlendFactor = BlendFactor.One;
    bs.destinationAlphaBlendFactor = BlendFactor.OneMinusSourceAlpha;
    mr.setMaterial(m);
    m.shaderData.setTexture("u_atmoNoise", fogNoiseTexture(engine));
    fx.quad = quad;
    fx.mat = m;
    quad.isActive = false;
    return fx;
  }

  /** (re)configure from resolved env blocks; null = that layer off. The quad is
   *  only active (and the depth prepass only required) when a layer is on. */
  configure(mist: EnvMist | null, rays: EnvRays | null): void {
    this.mistOn = !!mist;
    this.raysOn = !!rays;
    const sd = this.mat.shaderData;
    if (mist) {
      sd.enableMacro("SLOP_ATMO_MIST");
      sd.setVector4("u_mistA", new Vector4(mist.density, mist.height, mist.ground, mist.groundHeight));
      sd.setVector4("u_mistB", new Vector4(mist.color[0], mist.color[1], mist.color[2], mist.base));
      this.speed = mist.speed;
    } else {
      sd.disableMacro("SLOP_ATMO_MIST");
    }
    if (rays) {
      sd.enableMacro("SLOP_ATMO_RAYS");
      sd.setVector4("u_raysA", new Vector4(rays.color[0], rays.color[1], rays.color[2], rays.intensity));
    } else {
      sd.disableMacro("SLOP_ATMO_RAYS");
    }
    this.quad.isActive = this.mistOn || this.raysOn;
  }

  /** whether this pass needs the camera depth prepass right now */
  needsDepth(): boolean { return this.mistOn || this.raysOn; }

  override onLateUpdate(): void {
    if (!this.quad.isActive) return;
    this.time += this.engine.time.deltaTime * this.speed;
    const sd = this.mat.shaderData;
    const tf = this.cam.entity.transform;

    const pos = tf.worldPosition;
    sd.setVector3("u_atmoCamPos", new Vector3(pos.x, pos.y, pos.z));
    const fovY = Math.tan((this.cam.fieldOfView * Math.PI) / 360);
    const fovX = fovY * this.cam.aspectRatio;
    const f = tf.worldForward, r = tf.worldRight, u = tf.worldUp;
    sd.setVector3("u_atmoFwd", new Vector3(f.x, f.y, f.z));
    sd.setVector3("u_atmoRight", new Vector3(r.x * fovX, r.y * fovX, r.z * fovX));
    sd.setVector3("u_atmoUp", new Vector3(u.x * fovY, u.y * fovY, u.z * fovY));
    sd.setVector4("u_mistC", new Vector4(this.time, this.cam.farClipPlane, 0.85, 0));

    if (this.sun) {
      const sf = this.sun.entity.transform.worldForward;
      this.sunDir.set(sf.x, sf.y, sf.z).normalize();
    } else {
      this.sunDir.set(-0.45, -0.7, -0.55).normalize();
    }
    sd.setVector3("u_atmoSunDir", this.sunDir);

    if (this.raysOn) {
      // sun's screen position + a smooth visibility that dies as it leaves view
      this.sunPoint.set(pos.x - this.sunDir.x * 500, pos.y - this.sunDir.y * 500, pos.z - this.sunDir.z * 500);
      this.cam.worldToViewportPoint(this.sunPoint, this.vp);
      const behind = this.vp.z <= 0 ? 0 : 1;
      const edge = (v: number): number => Math.max(0, Math.min(1, 1 - (Math.max(0, Math.max(-v, v - 1)) / 0.35)));
      const vis = behind * edge(this.vp.x) * edge(this.vp.y);
      sd.setVector4("u_raysB", new Vector4(this.vp.x, 1 - this.vp.y, vis, this.cam.aspectRatio));
    }
  }
}
