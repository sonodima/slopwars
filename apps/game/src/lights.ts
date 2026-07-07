// ─── Lights: standalone point / directional / spot light sources ──────────────
// Placeable lights, decoupled from any model — so a lantern is just a `prop` you
// group with a `pointlight` in the editor (Unity-style), instead of a bespoke
// model+light object. Galacean lights carry their brightness in the *magnitude*
// of their colour (there is no separate intensity field — same convention as the
// map sun, see envSunColor), so `intensity` here scales the RGB colour that gets
// pushed to the light. Direction, for directional & spot lights, is the object's
// own orientation: the light points down the entity's forward axis (−Z), so the
// editor's Rotate tool aims it exactly like it aims a particle cone.
import { Color, DirectLight, Entity, PointLight, SpotLight } from "@galacean/engine";

type Vec3T = readonly [number, number, number];

/** shared controls every light exposes: colour + a brightness multiplier */
export interface LightCommon {
  color: [number, number, number];   // light colour (0..1 rgb)
  intensity: number;                 // brightness multiplier applied to the colour
}
/** omnidirectional point light: adds a falloff `range` (metres) */
export interface PointLightLook extends LightCommon { range: number }
/** parallel directional light (a local "sun"): colour + intensity, aimed by rotation */
export type DirLightLook = LightCommon;
/** cone spot light: falloff `range`, cone `angle` (deg) and soft-edge `penumbra` (0..1) */
export interface SpotLightLook extends LightCommon { range: number; angle: number; penumbra: number }

// Unity-flavoured defaults: a warm point light, a soft cool directional fill, and
// a punchy neutral spot — sensible starting points an author then tunes.
export const POINT_LIGHT: PointLightLook = { color: [1.0, 0.85, 0.6], intensity: 1.4, range: 8 };
export const DIR_LIGHT: DirLightLook = { color: [1.0, 0.98, 0.9], intensity: 0.6 };
export const SPOT_LIGHT: SpotLightLook = { color: [1.0, 0.92, 0.75], intensity: 1.8, range: 14, angle: 32, penumbra: 0.35 };

/** the light's colour pre-multiplied by its intensity (brightness lives here) */
function litColor(c: readonly [number, number, number], k: number): Color {
  const i = Math.max(0, k);
  return new Color(c[0] * i, c[1] * i, c[2] * i, 1);
}

function clamp01(n: number): number { return n < 0 ? 0 : n > 1 ? 1 : n; }

/** point light at `at` — omnidirectional, so rotation is irrelevant */
export function buildPointLight(root: Entity, at: Vec3T, p: PointLightLook): Entity {
  const e = root.createChild("pointlight");
  e.transform.setPosition(at[0], at[1], at[2]);
  const l = e.addComponent(PointLight);
  l.color = litColor(p.color, p.intensity);
  l.distance = Math.max(0, p.range);
  return e;
}

/** directional light — a parallel "sun" aimed down the object's forward (−Z) axis */
export function buildDirLight(root: Entity, at: Vec3T, rot: Vec3T, p: DirLightLook): Entity {
  const e = root.createChild("dirlight");
  e.transform.setPosition(at[0], at[1], at[2]);
  e.transform.setRotation(rot[0], rot[1], rot[2]);
  const l = e.addComponent(DirectLight);
  l.color = litColor(p.color, p.intensity);
  return e;
}

/** spot light — a cone aimed down the object's forward (−Z) axis. `angle` is the
 *  full outer cone in degrees; `penumbra` (0..1) is the fraction of that cone
 *  taken up by the soft falloff edge (0 = hard cut, 1 = fades from the centre). */
export function buildSpotLight(root: Entity, at: Vec3T, rot: Vec3T, p: SpotLightLook): Entity {
  const e = root.createChild("spotlight");
  e.transform.setPosition(at[0], at[1], at[2]);
  e.transform.setRotation(rot[0], rot[1], rot[2]);
  const l = e.addComponent(SpotLight);
  l.color = litColor(p.color, p.intensity);
  l.distance = Math.max(0, p.range);
  // Galacean's `angle` is where falloff *begins* and `penumbra` the extra radians
  // out to the edge; map our author-facing (outer angle + soft fraction) onto that.
  const outer = (Math.max(0, p.angle) * Math.PI) / 180;
  const inner = outer * (1 - clamp01(p.penumbra));
  l.angle = inner;
  l.penumbra = outer - inner;
  return e;
}
