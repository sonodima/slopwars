// ─── Volumetric clouds: amortized panorama raymarch + compositing sky ─────────
// Real raymarched volumetrics (Perlin-Worley noise field, Beer-Lambert + powder
// lighting, dual-lobe HG phase) made affordable for a browser FPS by NOT paying
// them per screen pixel: the camera sits on the ground and clouds live at
// 1400m+, so player movement produces no visible parallax. The whole cloudscape
// is therefore rendered into a hemispherical panorama (1024×384, HDR) that a
// custom sky material composites over the HDRI/solid background — and the
// panorama is refreshed a horizontal STRIPE per frame (camera.viewport), so the
// per-frame raymarch cost is ~32k pixels (~20× cheaper than a quarter-res
// full-screen march) while a full sweep still completes ~5×/second.
//
// Learned the hard way / by design:
//  · Cloud time is FROZEN per sweep (advances only when the stripe counter
//    wraps) — otherwise each stripe samples a different instant and the
//    panorama tears. At real wind speeds the between-sweep jump is well under
//    a panorama pixel, so motion still reads as continuous.
//  · Galacean 1.6 has no Texture3D; the 3D noise lives in a Texture2DArray and
//    the shader lerps between two layers by hand (2 taps = trilinear).
//    sampler2DArray needs WebGL2 — CloudFX.supported() gates on it, and on
//    WebGL1 clouds silently stay off (same policy as NPC banter on web).
//  · The raymarch quad lives on its own layer (CLOUD_RT_LAYER) so the main,
//    water-reflection and portal cameras must all exclude it from their masks.
//  · The panorama camera uses clearFlags None: never clears (stripes overwrite)
//    and — because the engine only draws the background when clear includes
//    Color — never wastes time rendering the skybox into the RT.
import {
  Camera, CameraClearFlags, CompareFunction, CullMode, Engine, Entity, Layer, Material,
  MeshRenderer, MSAASamples, PrimitiveMesh, RenderTarget, Script, Shader,
  Texture2D, Texture2DArray, TextureCube, TextureFormat, TextureWrapMode, Vector2, Vector3, Vector4,
} from "@galacean/engine";
import type { DirectLight } from "@galacean/engine";
import type { EnvClouds, Tuple3 } from "./maps/schema";

/** the panorama raymarch quad lives alone on this layer — every scene camera
 *  (main, water reflection, portal see-through) must exclude it. */
export const CLOUD_RT_LAYER = Layer.Layer27;

const PANO_W = 1024;
const PANO_H = 384;
const STRIPES = 12;          // stripes per full panorama sweep (1 stripe/frame)
const HORIZON_BELOW = 0.08;  // how far below the horizon the panorama reaches (y units)

// ── tileable 3D noise (Perlin-Worley base + Worley detail) ────────────────────
// Generated once per engine on the CPU (~250ms for 64³ + 32³) and cached — no
// committed noise assets, matching the procedural wave/puff textures elsewhere.

/** wrap-friendly integer-lattice hash → [0,1) */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1440662683 + seed * 951274213) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** quintic fade — C² continuous, no lattice creases */
function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

/** tileable 3D gradient (perlin) noise, `f` cells per tile axis → ~[-1, 1] */
function perlin3(x: number, y: number, z: number, f: number, seed: number): number {
  const xi = Math.floor(x * f), yi = Math.floor(y * f), zi = Math.floor(z * f);
  const fx = x * f - xi, fy = y * f - yi, fz = z * f - zi;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const cx = c & 1, cy = (c >> 1) & 1, cz = (c >> 2) & 1;
    const h = hash3(((xi + cx) % f + f) % f, ((yi + cy) % f + f) % f, ((zi + cz) % f + f) % f, seed);
    // gradient from hash: pick one of 12 edge directions
    const g = (h * 12) | 0;
    const dx = fx - cx, dy = fy - cy, dz = fz - cz;
    const gd =
      g < 4 ? (g & 1 ? -dx : dx) + (g & 2 ? -dy : dy) :
      g < 8 ? (g & 1 ? -dy : dy) + (g & 2 ? -dz : dz) :
              (g & 1 ? -dx : dx) + (g & 2 ? -dz : dz);
    const wx = cx ? u : 1 - u, wy = cy ? v : 1 - v, wz = cz ? w : 1 - w;
    sum += gd * wx * wy * wz;
  }
  return sum;
}

/** tileable 3D worley (cellular) noise, inverted so cell centres are 1 → [0,1] */
function worley3(x: number, y: number, z: number, f: number, seed: number): number {
  const xi = Math.floor(x * f), yi = Math.floor(y * f), zi = Math.floor(z * f);
  const fx = x * f - xi, fy = y * f - yi, fz = z * f - zi;
  let min = 8;
  for (let c = 0; c < 27; c++) {
    const cx = (c % 3) - 1, cy = (((c / 3) | 0) % 3) - 1, cz = ((c / 9) | 0) - 1;
    const wx = ((xi + cx) % f + f) % f, wy = ((yi + cy) % f + f) % f, wz = ((zi + cz) % f + f) % f;
    const px = cx + hash3(wx, wy, wz, seed), py = cy + hash3(wx, wy, wz, seed + 1), pz = cz + hash3(wx, wy, wz, seed + 2);
    const dx = px - fx, dy = py - fy, dz = pz - fz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < min) min = d;
  }
  return Math.max(0, 1 - Math.sqrt(min));
}

function remap(v: number, l0: number, h0: number, l1: number, h1: number): number {
  return l1 + ((v - l0) / (h0 - l0)) * (h1 - l1);
}

interface CloudNoise { base: Texture2DArray; detail: Texture2DArray }
const noiseCache = new WeakMap<Engine, CloudNoise>();

/** 64³ RGBA base (R: perlin-worley shape, GBA: worley fbm octaves) +
 *  32³ RGB detail (worley octaves for edge erosion) */
function cloudNoise(engine: Engine): CloudNoise {
  const cached = noiseCache.get(engine);
  if (cached) return cached;

  const B = 64;
  const base = new Texture2DArray(engine, B, B, B, TextureFormat.R8G8B8A8, false);
  base.wrapModeU = TextureWrapMode.Repeat;
  base.wrapModeV = TextureWrapMode.Repeat;
  const bbuf = new Uint8Array(B * B * B * 4);
  let i = 0;
  for (let z = 0; z < B; z++) {
    for (let y = 0; y < B; y++) {
      for (let x = 0; x < B; x++) {
        const u = x / B, v = y / B, w = z / B;
        // 3-octave perlin fbm → [0,1]
        const pn = 0.5 + 0.5 * (perlin3(u, v, w, 4, 7) + perlin3(u, v, w, 8, 13) * 0.5 + perlin3(u, v, w, 16, 29) * 0.25) / 1.75;
        const w4 = worley3(u, v, w, 4, 101);
        const w8 = worley3(u, v, w, 8, 211);
        const w16 = worley3(u, v, w, 16, 331);
        // perlin-worley: worley carves billowy structure out of the perlin base
        const pw = Math.min(1, Math.max(0, remap(pn, w4 - 1, 1, 0, 1)));
        bbuf[i++] = (pw * 255) | 0;
        bbuf[i++] = (w4 * 255) | 0;
        bbuf[i++] = (w8 * 255) | 0;
        bbuf[i++] = (w16 * 255) | 0;
      }
    }
  }
  base.setPixelBuffer(0, bbuf, 0, 0, 0, B, B, B);

  const D = 32;
  const detail = new Texture2DArray(engine, D, D, D, TextureFormat.R8G8B8A8, false);
  detail.wrapModeU = TextureWrapMode.Repeat;
  detail.wrapModeV = TextureWrapMode.Repeat;
  const dbuf = new Uint8Array(D * D * D * 4);
  i = 0;
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const u = x / D, v = y / D, w = z / D;
        dbuf[i++] = (worley3(u, v, w, 2, 401) * 255) | 0;
        dbuf[i++] = (worley3(u, v, w, 4, 503) * 255) | 0;
        dbuf[i++] = (worley3(u, v, w, 8, 601) * 255) | 0;
        dbuf[i++] = 255;
      }
    }
  }
  detail.setPixelBuffer(0, dbuf, 0, 0, 0, D, D, D);

  const out = { base, detail };
  noiseCache.set(engine, out);
  return out;
}

// ── panorama raymarch shader ──────────────────────────────────────────────────
// Renders into the panorama RT: rgb = premultiplied cloud radiance (linear HDR),
// a = transmittance (1 = clear sky). gl_FragCoord drives the pano UV directly,
// so the same shader works for any viewport stripe without extra uniforms.

const CLOUD_VS = /* glsl */ `
attribute vec3 POSITION;
void main() { gl_Position = vec4(POSITION.x, POSITION.z, 0.5, 1.0); }
`;

const CLOUD_FS = /* glsl */ `
uniform mediump sampler2DArray u_cloudBase;    // 64³ RGBA: PW shape + worley fbm
uniform mediump sampler2DArray u_cloudDetail;  // 32³ RGB: worley erosion octaves
uniform vec4 u_cloudA;   // x: coverage, y: density, z: slab base (m), w: slab thickness (m)
uniform vec4 u_cloudB;   // xy: wind (m/s), z: frozen cloud time (s), w: max march distance (m)
uniform vec4 u_cloudC;   // rgb: tint, w: horizon-below amount
uniform vec4 u_cloudSun; // xyz: sun direction (travel dir), w: pano height (px)
uniform vec3 u_cloudSunCol;
uniform vec3 u_cloudAmb;
uniform vec2 u_panoSize;

const float BASE_TILE = 5200.0;   // metres one 64³ noise tile spans
const float DETAIL_TILE = 980.0;  // metres one 32³ detail tile spans
const float COV_TILE = 21000.0;   // metres of the low-freq coverage field
const int STEPS = 48;
const int LSTEPS = 5;

// manual trilinear across array layers (xy filtered by hardware, z by hand)
vec4 tex3(mediump sampler2DArray s, vec3 p, float size) {
  float z = fract(p.z) * size - 0.5;
  float z0 = floor(z);
  float f = z - z0;
  float l0 = mod(z0 + size, size);
  float l1 = mod(z0 + 1.0 + size, size);
  return mix(texture(s, vec3(p.xy, l0)), texture(s, vec3(p.xy, l1)), f);
}

float remapc(float v, float l0, float h0) { return clamp((v - l0) / (h0 - l0), 0.0, 1.0); }

// cloud density at a world point; cheap=1 skips the detail erosion (light march / LOD)
float cloudDensity(vec3 p, float cheap) {
  float h = (p.y - u_cloudA.z) / u_cloudA.w;              // 0..1 through the slab
  if (h <= 0.0 || h >= 1.0) return 0.0;
  vec3 q = p - vec3(u_cloudB.x, 0.0, u_cloudB.y) * u_cloudB.z;   // wind advection
  // low-frequency coverage field: cloud "islands" instead of uniform soup
  float cov = tex3(u_cloudBase, vec3(q.xz / COV_TILE, 0.4), 64.0).g;
  float coverage = clamp(u_cloudA.x * 1.15 + (cov - 0.5) * 0.55, 0.0, 1.0);
  // vertical profile: flat-ish bottom, billowing top
  float prof = remapc(h, 0.0, 0.18) * remapc(h, 1.0, 0.72);
  vec4 n = tex3(u_cloudBase, q / BASE_TILE, 64.0);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float shape = remapc(n.r, fbm - 1.0, 1.0);
  float d = remapc(shape * prof, 1.0 - coverage, 1.0);
  if (d <= 0.0 || cheap > 0.5) return d * u_cloudA.y;
  // edge erosion: wispy at the bottom, billowy at the top
  vec3 dn = tex3(u_cloudDetail, q / DETAIL_TILE, 32.0).rgb;
  float det = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  float er = mix(1.0 - det, det, clamp(h * 3.0, 0.0, 1.0));
  d = remapc(d, er * 0.38, 1.0);
  return d * u_cloudA.y;
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5) * 0.0795775;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_panoSize;
  // pano uv → world direction (must mirror the sky material's dirToPano exactly)
  float HB = u_cloudC.w;
  float y = uv.y * uv.y * (1.0 + HB) - HB;
  if (y <= 0.012) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float phi = (uv.x - 0.5) * 6.2831853;
  float c = sqrt(max(1.0 - y * y, 0.0));
  vec3 rd = vec3(c * cos(phi), y, c * sin(phi));

  float base = u_cloudA.z, thick = u_cloudA.w, maxDist = u_cloudB.w;
  float t0 = base / rd.y;
  float t1 = min((base + thick) / rd.y, t0 + thick * 9.0);
  t1 = min(t1, maxDist);
  if (t0 >= t1) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float dt = (t1 - t0) / float(STEPS);
  float jitter = hash12(gl_FragCoord.xy);
  vec3 sunDir = normalize(u_cloudSun.xyz);
  float cosT = dot(rd, -sunDir);
  float phase = mix(hg(cosT, 0.55), hg(cosT, -0.28), 0.38);

  float T = 1.0;
  vec3 acc = vec3(0.0);
  const float SIGMA = 0.011;    // extinction per metre at density 1
  for (int i = 0; i < STEPS; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = rd * t;
    float d = cloudDensity(p, t > 12000.0 ? 1.0 : 0.0);
    if (d > 0.001) {
      // short exponential march toward the sun for self-shadowing
      float lt = 0.0;
      float ls = 55.0;
      vec3 lp = p;
      for (int j = 0; j < LSTEPS; j++) {
        lp -= sunDir * ls;
        lt += cloudDensity(lp, 1.0) * ls;
        ls *= 1.8;
      }
      // two-lobe Beer (keeps deep cloud from going pitch black) + powder edge
      float beer = max(exp(-lt * SIGMA), 0.62 * exp(-lt * SIGMA * 0.22));
      float powder = 1.0 - 0.55 * exp(-d * 9.0);
      float hFrac = clamp((p.y - base) / thick, 0.0, 1.0);
      vec3 li = u_cloudSunCol * beer * powder * phase * 14.0
              + u_cloudAmb * (0.35 + 0.65 * hFrac);
      float a = 1.0 - exp(-d * SIGMA * dt);
      acc += T * a * li * u_cloudC.rgb;
      T *= 1.0 - a;
      if (T < 0.015) break;
    }
  }
  // distant clouds dissolve into the horizon haze instead of aliasing away
  float hz = exp(-max(t0 - 2500.0, 0.0) * 0.00013);
  acc *= hz;
  T = mix(1.0, T, hz);
  gl_FragColor = vec4(acc, T);
}
`;

// ── compositing sky shader ────────────────────────────────────────────────────
// Replaces the engine SkyBoxMaterial on maps with clouds: same cube sampling +
// RGBM decode + far-plane trick as the built-in skybox shader, then the cloud
// panorama is composited over it (premultiplied). Without an HDRI it renders a
// simple horizon→zenith gradient with a sun disc, so solid-sky maps get clouds
// too.

const SKY_VS = /* glsl */ `
attribute vec3 POSITION;
uniform mat4 camera_VPMat;
varying vec3 v_dir;
void main() {
  v_dir = POSITION.xyz;
  gl_Position = camera_VPMat * vec4(POSITION, 1.0);
  gl_Position.z = max(gl_Position.z, -1.0);   // engine skybox far-plane clamp
}
`;

const SKY_FS = /* glsl */ `
#include <common>
#ifdef SLOP_SKY_HDRI
uniform samplerCube u_skyCube;
#endif
uniform vec3 u_skyHorizon;
uniform vec3 u_skyZenith;
uniform sampler2D u_cloudPano;
uniform vec4 u_skySun;      // xyz: sun direction (travel dir), w: horizon-below amount
uniform vec3 u_skySunCol;
varying vec3 v_dir;

void main() {
  vec3 d = normalize(v_dir);
  #ifdef SLOP_SKY_HDRI
    vec4 tc = textureCube(u_skyCube, vec3(-d.x, d.yz));   // cube is left-handed
    vec3 sky = RGBMToLinear(tc, 5.0).rgb;
  #else
    float h = clamp(d.y, 0.0, 1.0);
    vec3 sky = mix(u_skyHorizon, u_skyZenith, pow(h, 0.6));
    float ct = dot(d, -normalize(u_skySun.xyz));
    sky += u_skySunCol * (smoothstep(0.9995, 0.99995, ct) * 9.0 + pow(clamp(ct, 0.0, 1.0), 48.0) * 0.12);
  #endif
  #ifdef SLOP_SKY_CLOUDS
    float HB = u_skySun.w;
    float yn = (d.y + HB) / (1.0 + HB);
    if (yn > 0.0) {
      float v = sqrt(yn);
      float u = atan(d.z, d.x) / 6.2831853 + 0.5;
      vec4 cl = texture2D(u_cloudPano, vec2(u, v));
      float fadeIn = smoothstep(0.005, 0.05, d.y);   // clouds vanish at the horizon line
      sky = mix(sky, cl.rgb + sky * cl.a, fadeIn);
    }
  #endif
  gl_FragColor = vec4(sky, 1.0);
}
`;

function cloudShader(): Shader {
  return Shader.find("slop-clouds") ?? Shader.create("slop-clouds", CLOUD_VS, CLOUD_FS);
}
function cloudSkyShader(): Shader {
  return Shader.find("slop-cloudsky") ?? Shader.create("slop-cloudsky", SKY_VS, SKY_FS);
}

// ── CloudFX: the amortized panorama system ────────────────────────────────────

export class CloudFX extends Script {
  /** the compositing sky material — applyEnv swaps this in for scene.background
   *  while clouds are on (and restores the stock SkyBoxMaterial when off). */
  skyMat!: Material;

  private cam!: Camera;
  private quadMat!: Material;
  private sun: DirectLight | null = null;
  private active = false;
  private stripe = 0;
  private fillAll = true;    // render every stripe on the next update (fresh config)
  private cfgKey = "";       // last applied config (editor rebuilds call configure per frame)
  private clock = 0;         // continuous seconds
  private frozen = 0;        // cloud time, advanced once per full sweep
  private viewport = new Vector4(0, 0, 1, 1 / STRIPES);
  private sunDir = new Vector3();

  /** volumetric clouds need sampler2DArray → WebGL2. On WebGL1 they stay off. */
  static supported(engine: Engine): boolean {
    const rhi = (engine as unknown as { _hardwareRenderer?: { isWebGL2?: boolean } })._hardwareRenderer;
    return rhi?.isWebGL2 !== false;
  }

  static attach(root: Entity, sun: DirectLight | null): CloudFX {
    const engine = root.engine;
    const fx = root.createChild("cloud-fx").addComponent(CloudFX);
    fx.sun = sun;

    // HDR panorama target. R11G11B10 float needs EXT_color_buffer_float — as
    // universal as WebGL2 itself; clouds are opt-in eye candy if it's missing.
    const pano = new Texture2D(engine, PANO_W, PANO_H, TextureFormat.R11G11B10_UFloat, false);
    pano.wrapModeU = TextureWrapMode.Repeat;   // azimuth wraps around
    pano.wrapModeV = TextureWrapMode.Clamp;
    const rt = new RenderTarget(engine, PANO_W, PANO_H, pano, null);

    const camE = root.createChild("cloud-pano-cam");
    const cam = camE.addComponent(Camera);
    cam.enabled = false;                        // rendered manually, stripe by stripe
    cam.renderTarget = rt;
    cam.clearFlags = CameraClearFlags.None;     // no clear, no background into the RT
    cam.cullingMask = CLOUD_RT_LAYER;
    cam.enableHDR = false;
    cam.enablePostProcess = false;
    cam.msaaSamples = MSAASamples.None;
    fx.cam = cam;

    const quadE = camE.createChild("cloud-quad");
    quadE.layer = CLOUD_RT_LAYER;
    quadE.transform.setPosition(0, 0, -1);      // inside the pano cam frustum
    const mr = quadE.addComponent(MeshRenderer);
    mr.mesh = PrimitiveMesh.createPlane(engine, 2, 2);
    mr.castShadows = false;
    mr.receiveShadows = false;
    const qm = new Material(engine, cloudShader());
    qm.renderState.rasterState.cullMode = CullMode.Off;
    qm.renderState.depthState.enabled = false;  // RT has no depth buffer
    qm.renderState.depthState.writeEnabled = false;
    mr.setMaterial(qm);
    fx.quadMat = qm;
    // the ~quarter-second noise bake is deferred to the first map that actually
    // uses clouds (configure below) — cloudless boots pay nothing
    qm.shaderData.setVector2("u_panoSize", new Vector2(PANO_W, PANO_H));

    const sm = new Material(engine, cloudSkyShader());
    sm.renderState.rasterState.cullMode = CullMode.Off;
    sm.renderState.depthState.compareFunction = CompareFunction.LessEqual;
    sm.shaderData.setTexture("u_cloudPano", pano);
    fx.skyMat = sm;
    return fx;
  }

  /** (re)configure from a resolved env. `clouds` null = off (panorama stops
   *  rendering, sky material reverts — the caller handles the background swap).
   *  Idempotent per config: the editor calls this on EVERY live-drag rebuild, and
   *  an unchanged config must not re-burst the whole panorama each frame. */
  configure(clouds: EnvClouds | null, ambient: Tuple3, ambientIntensity: number): void {
    const key = JSON.stringify([clouds, ambient, ambientIntensity]);
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.active = !!clouds && CloudFX.supported(this.engine);
    const sd = this.skyMat.shaderData;
    if (!this.active || !clouds) {
      sd.disableMacro("SLOP_SKY_CLOUDS");
      return;
    }
    const qd = this.quadMat.shaderData;
    if (!qd.getTexture("u_cloudBase")) {
      const noise = cloudNoise(this.engine);
      qd.setTexture("u_cloudBase", noise.base);
      qd.setTexture("u_cloudDetail", noise.detail);
    }
    qd.setVector4("u_cloudA", new Vector4(clouds.coverage, clouds.density, clouds.base, clouds.thickness));
    qd.setVector4("u_cloudB", new Vector4(clouds.wind[0], clouds.wind[1], this.frozen, 26000));
    qd.setVector4("u_cloudC", new Vector4(clouds.tint[0], clouds.tint[1], clouds.tint[2], HORIZON_BELOW));
    const k = ambientIntensity * 1.15;
    qd.setVector3("u_cloudAmb", new Vector3(ambient[0] * k + 0.06, ambient[1] * k + 0.07, ambient[2] * k + 0.1));
    this.fillAll = true;   // repaint the whole panorama with the new look
  }

  /** point the compositing sky at an HDRI cube (or a solid-colour gradient) */
  setSky(cube: TextureCube | null, solid: Tuple3, sunColor: Tuple3): void {
    const sd = this.skyMat.shaderData;
    if (cube) {
      sd.enableMacro("SLOP_SKY_HDRI");
      sd.setTexture("u_skyCube", cube);
    } else {
      sd.disableMacro("SLOP_SKY_HDRI");
      sd.setVector3("u_skyZenith", new Vector3(solid[0], solid[1], solid[2]));
      sd.setVector3("u_skyHorizon", new Vector3(solid[0] * 1.45 + 0.05, solid[1] * 1.4 + 0.05, solid[2] * 1.3 + 0.05));
      sd.setVector3("u_skySunCol", new Vector3(sunColor[0], sunColor[1], sunColor[2]));
    }
  }

  override onLateUpdate(): void {
    if (!this.active) return;
    this.clock += this.engine.time.deltaTime;

    // live sun (static per map, but reading it keeps clouds honest if it moves)
    if (this.sun) {
      const f = this.sun.entity.transform.worldForward;
      this.sunDir.set(f.x, f.y, f.z);
      const c = this.sun.color;
      this.quadMat.shaderData.setVector3("u_cloudSunCol", new Vector3(c.r, c.g, c.b));
      this.skyMat.shaderData.setVector3("u_skySunCol", new Vector3(c.r, c.g, c.b));
    } else {
      this.sunDir.set(-0.45, -0.7, -0.55).normalize();
    }
    this.quadMat.shaderData.setVector4("u_cloudSun", new Vector4(this.sunDir.x, this.sunDir.y, this.sunDir.z, PANO_H));
    this.skyMat.shaderData.setVector4("u_skySun", new Vector4(this.sunDir.x, this.sunDir.y, this.sunDir.z, HORIZON_BELOW));

    const renderStripe = (i: number): void => {
      this.viewport.set(0, i / STRIPES, 1, 1 / STRIPES);
      this.cam.viewport = this.viewport;
      this.cam.render();
    };

    if (this.fillAll) {
      // fresh config: paint the whole panorama this frame (one-time burst), and
      // only then let the sky composite it — an unfilled RT is opaque black.
      this.fillAll = false;
      this.stripe = 0;
      this.frozen = this.clock;
      this.setCloudTime(this.frozen);
      for (let i = 0; i < STRIPES; i++) renderStripe(i);
      this.skyMat.shaderData.enableMacro("SLOP_SKY_CLOUDS");
      return;
    }

    if (this.stripe === 0) {
      // a new sweep begins: advance the frozen cloud clock once, so every
      // stripe of this sweep samples the same instant (no tearing)
      this.frozen = this.clock;
      this.setCloudTime(this.frozen);
    }
    renderStripe(this.stripe);
    this.stripe = (this.stripe + 1) % STRIPES;
  }

  private setCloudTime(t: number): void {
    const qd = this.quadMat.shaderData;
    const b = qd.getVector4("u_cloudB");
    if (b) { b.z = t; qd.setVector4("u_cloudB", b); }
  }
}
