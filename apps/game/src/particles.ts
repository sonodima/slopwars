// ─── Particle emitter: fire / smoke / dust / sparks from one tunable object ────
// A thin, data-driven wrapper over the engine's ParticleRenderer. Every knob a
// map author needs — sprite texture, spawn rate, particle lifetime, speed, size,
// growth, cone spread, gravity, colour, opacity, blend mode — is a plain param,
// so the `particles` object (and its `fire`/`smoke` presets) are just different
// default param sets over this one builder. Emission direction is the object's
// own rotation: the cone points up its local +Y, so rotating the object aims it.
import {
  BlendMode, Color, ConeShape, Engine, Entity, ParticleCompositeCurve, ParticleCompositeGradient,
  ParticleCurve, ParticleGradient, ParticleMaterial, ParticleRenderer, ParticleSimulationSpace,
  Texture2D, TextureFormat,
} from "@galacean/engine";

/** every look/behaviour control for an emitter (all required in object defaults) */
export interface ParticleLook {
  rate: number;                      // particles spawned per second
  lifetime: number;                  // seconds each particle lives
  speed: number;                     // initial speed along the emission cone
  size: number;                      // initial particle size (metres)
  growth: number;                    // size multiplier at end of life (1 = constant)
  spread: number;                    // cone half-angle in degrees (0 = a tight jet)
  gravity: number;                   // gravity pull (negative = rises, like heat/smoke)
  color: [number, number, number];   // particle tint
  opacity: number;                   // starting alpha (fades to 0 over life)
  additive: boolean;                 // additive blend (glowing fire) vs normal (smoke)
  world: boolean;                    // simulate in world space (trail behind a mover)
}

export const PARTICLE_LOOK: ParticleLook = {
  rate: 20, lifetime: 1.5, speed: 1.2, size: 0.5, growth: 1.4, spread: 14,
  gravity: 0, color: [1, 1, 1], opacity: 0.8, additive: false, world: true,
};

// ── procedural soft round sprite (used when no texture folder is given) ───────
const SPRITE_SIZE = 64;
const puffCache = new WeakMap<Engine, Texture2D>();
/** a soft radial-gradient puff — a good default for fire/smoke without an asset */
function puffSprite(engine: Engine): Texture2D {
  const cached = puffCache.get(engine);
  if (cached) return cached;
  const tex = new Texture2D(engine, SPRITE_SIZE, SPRITE_SIZE, TextureFormat.R8G8B8A8, false);
  const buf = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  const c = (SPRITE_SIZE - 1) / 2;
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      const a = Math.max(0, 1 - d);          // linear falloff to the rim
      const soft = a * a * (3 - 2 * a);       // smoothstep for a gentle edge
      const i = (y * SPRITE_SIZE + x) * 4;
      buf[i] = buf[i + 1] = buf[i + 2] = 255;
      buf[i + 3] = Math.round(soft * 255);
    }
  }
  tex.setPixelBuffer(buf);
  puffCache.set(engine, tex);
  return tex;
}

/** build a particle emitter entity at (x,y,z) styled by a partial `look`. An
 *  optional `sprite` texture overrides the default soft puff (e.g. a map's flame
 *  or smoke sheet dropped onto the object's `tex` slot). */
export function buildParticles(
  engine: Engine, root: Entity, x: number, y: number, z: number,
  look: Partial<ParticleLook> = {}, sprite: Texture2D | null = null,
): Entity {
  const L = { ...PARTICLE_LOOK, ...look };
  const e = root.createChild("particles");
  e.transform.setPosition(x, y, z);

  const r = e.addComponent(ParticleRenderer);
  const mat = new ParticleMaterial(engine);
  mat.baseColor = new Color(1, 1, 1, 1);           // tint comes from startColor
  mat.baseTexture = sprite ?? puffSprite(engine);
  mat.isTransparent = true;
  mat.blendMode = L.additive ? BlendMode.Additive : BlendMode.Normal;
  r.setMaterial(mat);

  const g = r.generator;
  const main = g.main;
  main.startLifetime = new ParticleCompositeCurve(L.lifetime);
  main.startSpeed = new ParticleCompositeCurve(L.speed);
  main.startSize = new ParticleCompositeCurve(L.size);
  main.startColor = new ParticleCompositeGradient(new Color(L.color[0], L.color[1], L.color[2], L.opacity));
  main.gravityModifier = new ParticleCompositeCurve(L.gravity);
  main.simulationSpace = L.world ? ParticleSimulationSpace.World : ParticleSimulationSpace.Local;
  // headroom for the steady-state population, +a little for bursts
  main.maxParticles = Math.max(16, Math.ceil(L.rate * L.lifetime) + 8);

  g.emission.rateOverTime = new ParticleCompositeCurve(Math.max(0, L.rate));
  const cone = new ConeShape();
  cone.angle = L.spread;
  cone.radius = 0.05;
  g.emission.shape = cone;

  // grow (or shrink) each particle over its life
  if (L.growth !== 1) {
    const curve = new ParticleCurve();
    curve.addKey(0, 1);
    curve.addKey(1, Math.max(0, L.growth));
    g.sizeOverLifetime.enabled = true;
    g.sizeOverLifetime.size = new ParticleCompositeCurve(curve);
  }

  // fade alpha out over life (hold colour, ramp alpha 1 → 0)
  const grad = new ParticleGradient();
  grad.addColorKey(0, new Color(1, 1, 1));
  grad.addColorKey(1, new Color(1, 1, 1));
  grad.addAlphaKey(0, 1);
  grad.addAlphaKey(0.7, 0.6);
  grad.addAlphaKey(1, 0);
  g.colorOverLifetime.enabled = true;
  g.colorOverLifetime.color = new ParticleCompositeGradient(grad);

  return e;
}
