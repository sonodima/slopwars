// ─── Realistic water: PBR transmission/refraction + animated waves ────────────
// The water surface reuses the engine's physically-based transmission so it
// refracts the scene behind it (needs `camera.opaqueTextureEnabled`), reflects
// the sky/IBL through a low roughness, and tints depth via attenuation. Movement
// comes from a cheap procedural wave normal whose UVs scroll every frame — no
// custom GLSL, one small texture cached per engine, one Vector4 update per frame,
// so it's cheap while looking convincingly liquid. Falls back gracefully to a
// tinted transparent surface when the opaque texture isn't available.
import {
  Color, Engine, Entity, MeshRenderer, PBRMaterial, PrimitiveMesh, RefractionMode,
  Script, Texture2D, TextureFormat, TextureWrapMode, Vector4,
} from "@galacean/engine";

const NORMAL_SIZE = 128;
const normalCache = new WeakMap<Engine, Texture2D>();

/** procedural tangent-space wave normal (summed sine ripples) — built once per
 *  engine and reused by every water surface. */
function waveNormal(engine: Engine): Texture2D {
  const cached = normalCache.get(engine);
  if (cached) return cached;
  const tex = new Texture2D(engine, NORMAL_SIZE, NORMAL_SIZE, TextureFormat.R8G8B8A8, false);
  tex.wrapModeU = TextureWrapMode.Repeat;
  tex.wrapModeV = TextureWrapMode.Repeat;

  const TAU = Math.PI * 2;
  // directional ripples (dirU, dirV, frequency) summed into a seamless height field
  const waves: [number, number, number][] = [[1, 0.6, 3], [-0.7, 1.1, 5], [1.3, -0.4, 8]];
  const height = (u: number, v: number): number => {
    let h = 0;
    for (const [du, dv, f] of waves) h += Math.sin((u * du + v * dv) * TAU * f) / f;
    return h;
  };
  const eps = 1 / NORMAL_SIZE;
  const buf = new Uint8Array(NORMAL_SIZE * NORMAL_SIZE * 4);
  for (let y = 0; y < NORMAL_SIZE; y++) {
    for (let x = 0; x < NORMAL_SIZE; x++) {
      const u = x / NORMAL_SIZE, v = y / NORMAL_SIZE;
      const nx = (height(u - eps, v) - height(u + eps, v)) * 2.2;
      const nz = (height(u, v - eps) - height(u, v + eps)) * 2.2;
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
class WaterAnim extends Script {
  mat!: PBRMaterial;
  tiling = 1;
  speed = 0.04;
  private t = 0;
  private v = new Vector4();
  onUpdate(dt: number): void {
    this.t += dt;
    const off = this.t * this.speed;
    this.v.set(this.tiling, this.tiling, off, off * 0.73);
    this.mat.tilingOffset = this.v;
  }
}

/** build a realistic animated water surface of side `s` centred at (x,y,z) */
export function buildWater(engine: Engine, root: Entity, x: number, y: number, z: number, s: number): Entity {
  const e = root.createChild("water");
  e.transform.setPosition(x, y, z);
  const r = e.addComponent(MeshRenderer);
  r.mesh = PrimitiveMesh.createCuboid(engine, s, 0.08, s);

  const m = new PBRMaterial(engine);
  m.baseColor = new Color(0.05, 0.16, 0.2, 0.92);
  m.roughness = 0.08;          // glossy → crisp sky/IBL reflection
  m.metallic = 0.0;
  m.ior = 1.33;                // water
  m.normalTexture = waveNormal(engine);
  m.normalTextureIntensity = 0.55;
  m.isTransparent = true;
  m.refractionMode = RefractionMode.Planar;
  m.transmission = 1.0;        // refract the scene behind (uses camera opaque texture)
  m.attenuationColor = new Color(0.16, 0.46, 0.5, 1);
  m.attenuationDistance = 6;   // deeper → more teal
  m.thickness = 1.2;
  const tiling = Math.max(1, s / 4);
  m.tilingOffset = new Vector4(tiling, tiling, 0, 0);
  r.setMaterial(m);
  r.receiveShadows = true;

  const anim = e.addComponent(WaterAnim);
  anim.mat = m;
  anim.tiling = tiling;
  return e;
}
