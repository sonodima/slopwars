// ─── Glass: transmissive/refractive cuboid (windows, panels, bottles-as-cover) ─
// Reuses the engine's physically-based transmission — the same mechanism the
// water surface uses — so it refracts the scene behind it (needs the camera's
// `opaqueTextureEnabled`), reflects the sky/IBL through a low roughness, and can
// carry a subtle tint. Unlike water it's a static box the Scale tool resizes, and
// every look control is a param so a map can make clear windows, frosted panels,
// or coloured glass. Falls back to a tinted transparent surface when the opaque
// texture isn't available.
import {
  Color, Engine, Entity, MeshRenderer, PBRMaterial, PrimitiveMesh, RefractionMode,
} from "@galacean/engine";

/** per-pane look controls (all fields required in the object defaults) */
export interface GlassLook {
  color: [number, number, number];  // glass tint (base color rgb)
  opacity: number;                   // base alpha (edge/grazing opacity)
  roughness: number;                 // 0 = perfectly clear, higher = frosted
  ior: number;                       // index of refraction (1.5 ≈ window glass)
  thickness: number;                 // refraction thickness (bends light more when thicker)
  tint: [number, number, number];    // absorption tint accumulated through the glass
}

export const GLASS_LOOK: GlassLook = {
  color: [0.85, 0.92, 0.95], opacity: 0.16, roughness: 0.02, ior: 1.5,
  thickness: 0.4, tint: [0.9, 0.96, 0.98],
};

/** one shared unit cube per engine (scaled per-pane by the entity transform) */
const cubeCache = new WeakMap<Engine, ReturnType<typeof PrimitiveMesh.createCuboid>>();
function unitCube(engine: Engine): ReturnType<typeof PrimitiveMesh.createCuboid> {
  let c = cubeCache.get(engine);
  if (!c) { c = PrimitiveMesh.createCuboid(engine, 1, 1, 1); cubeCache.set(engine, c); }
  return c;
}

/** build a refractive glass box of size (w,h,d) centred at (x,y,z), styled by
 *  a partial `look` (falls back to GLASS_LOOK per field). */
export function buildGlass(
  engine: Engine, root: Entity, x: number, y: number, z: number,
  w: number, h: number, d: number, look: Partial<GlassLook> = {},
): Entity {
  const L = { ...GLASS_LOOK, ...look };
  const e = root.createChild("glass");
  e.transform.setPosition(x, y, z);
  e.transform.setScale(w, h, d);
  const r = e.addComponent(MeshRenderer);
  r.mesh = unitCube(engine);

  const m = new PBRMaterial(engine);
  m.baseColor = new Color(L.color[0], L.color[1], L.color[2], L.opacity);
  m.roughness = L.roughness;
  m.metallic = 0.0;
  m.ior = L.ior;
  m.isTransparent = true;
  m.refractionMode = RefractionMode.Planar;
  m.transmission = 1.0;        // refract the scene behind (uses camera opaque texture)
  m.attenuationColor = new Color(L.tint[0], L.tint[1], L.tint[2], 1);
  m.attenuationDistance = 1.5; // gentle absorption so a thick pane picks up its tint
  m.thickness = L.thickness;
  r.setMaterial(m);
  r.receiveShadows = true;
  return e;
}
