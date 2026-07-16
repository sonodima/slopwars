// ─── Particle emitter: fire / smoke / dust / sparks from one tunable object ────
// A thin, data-driven wrapper over the engine's ParticleRenderer. Every knob a
// map author needs — sprite texture, spawn rate, particle lifetime, speed, size,
// growth, cone spread, gravity, colour, opacity, blend mode — is a plain param,
// so the `particles` object (and its `fire`/`smoke` presets) are just different
// default param sets over this one builder. Emission direction is the object's
// own rotation: the cone points up its local +Y, so rotating the object aims it.
import {
  BlendMode, Color, ConeShape, Engine, Entity, ParticleCompositeCurve, ParticleCompositeGradient,
  ParticleCurve, ParticleGradient, ParticleMaterial, ParticleRenderMode, ParticleRenderer,
  ParticleSimulationSpace, SphereShape, Texture2D, TextureFormat,
} from "@galacean/engine";

/** every look/behaviour control for an emitter (all required in object defaults) */
export interface ParticleLook {
  rate: number;                      // particles spawned per second
  lifetime: number;                  // seconds each particle lives
  speed: number;                     // initial speed along the emission cone
  size: number;                      // initial particle size (metres)
  growth: number;                    // size multiplier at end of life (1 = constant)
  spread: number;                    // cone half-angle in degrees (0 = a tight jet)
  emitRadius?: number;               // radius of the emission disc (spread the source over an area, e.g. a fire puddle)
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
  const e = root.createChild("particles");
  e.transform.setPosition(x, y, z);

  // Galacean's ConeShape emits along local −Z; a fresh emitter would therefore
  // spray sideways. The renderer lives on a child pitched +90° about X so the
  // cone points up the *outer* entity's local +Y — the object's own rotation
  // (from the editor's Rotate tool) then aims the emitter as documented.
  const emit = e.createChild("emit");
  emit.transform.setRotation(90, 0, 0);

  const r = emit.addComponent(ParticleRenderer);
  const mat = new ParticleMaterial(engine);
  mat.baseColor = new Color(1, 1, 1, 1);           // tint comes from startColor
  mat.isTransparent = true;
  r.setMaterial(mat);
  configureEmitter(r, mat, { ...PARTICLE_LOOK, ...look }, sprite, engine);
  return e;
}

// ── one-shot burst emitters (explosions) ──────────────────────────────────────

/** look of a pooled burst emitter. Unlike ParticleLook these are RANGES — each particle
 *  rolls its own lifetime/speed/size, which is what makes a blast read as chaotic debris
 *  instead of a uniform shell. The emitter idles at rate 0; fire a burst with
 *  `renderer.generator.emit(count)` after moving its parent to the blast point. */
export interface BurstLook {
  lifetime: [number, number];      // per-particle lifetime range (s)
  speed: [number, number];         // initial radial speed range (m/s, sphere emission)
  size: [number, number];          // initial particle size range (m)
  growth: number;                  // size multiplier at end of life (<1 = shrink)
  gravity: number;                 // gravity modifier (positive = falls, negative = rises)
  color: [number, number, number]; // tint; HDR values (>1) glow through bloom
  opacity: number;                 // starting alpha (fades to 0 over life)
  additive: boolean;               // additive (fire/sparks) vs normal (smoke)
  radius: number;                  // emission sphere radius (m)
  stretch?: number;                // >0: stretch along velocity (spark streaks), as lengthScale
  max?: number;                    // particle budget (default 128) — covers overlapping blasts
}

/** build a persistent, world-space, rate-0 emitter for on-demand bursts. One instance is
 *  reused by every explosion: move it, emit(), and the already-flying particles of the
 *  previous blast are unaffected (world simulation space). */
export function buildBurstEmitter(engine: Engine, root: Entity, look: BurstLook): ParticleRenderer {
  const e = root.createChild("burst");
  const r = e.addComponent(ParticleRenderer);
  const mat = new ParticleMaterial(engine);
  mat.baseColor = new Color(1, 1, 1, 1);
  mat.isTransparent = true;
  mat.blendMode = look.additive ? BlendMode.Additive : BlendMode.Normal;
  mat.baseTexture = puffSprite(engine);
  r.setMaterial(mat);
  if (look.stretch) {
    r.renderMode = ParticleRenderMode.StretchBillboard; // motion-streaked sparks
    r.lengthScale = look.stretch;
    r.velocityScale = 0.02;
  }

  const g = r.generator;
  const main = g.main;
  main.startLifetime = new ParticleCompositeCurve(look.lifetime[0], look.lifetime[1]);
  main.startSpeed = new ParticleCompositeCurve(look.speed[0], look.speed[1]);
  main.startSize = new ParticleCompositeCurve(look.size[0], look.size[1]);
  main.startColor = new ParticleCompositeGradient(new Color(look.color[0], look.color[1], look.color[2], look.opacity));
  main.gravityModifier = new ParticleCompositeCurve(look.gravity);
  main.simulationSpace = ParticleSimulationSpace.World;
  main.maxParticles = look.max ?? 128;

  g.emission.rateOverTime = new ParticleCompositeCurve(0); // bursts only
  const shape = new SphereShape();
  shape.radius = Math.max(0.02, look.radius);
  g.emission.shape = shape;

  if (look.growth !== 1) {
    const curve = new ParticleCurve();
    curve.addKey(0, 1);
    curve.addKey(1, Math.max(0, look.growth));
    g.sizeOverLifetime.enabled = true;
    g.sizeOverLifetime.size = new ParticleCompositeCurve(curve);
  }
  // hold colour, ramp alpha out — the tail of a blast dissolves instead of popping off
  const grad = new ParticleGradient();
  grad.addColorKey(0, new Color(1, 1, 1));
  grad.addColorKey(1, new Color(1, 1, 1));
  grad.addAlphaKey(0, 1);
  grad.addAlphaKey(0.55, 0.7);
  grad.addAlphaKey(1, 0);
  g.colorOverLifetime.enabled = true;
  g.colorOverLifetime.color = new ParticleCompositeGradient(grad);
  g.play(); // ensure the generator is running — emit() is a no-op on a stopped generator
  return r;
}

/** re-apply a look to an emitter built by buildParticles WITHOUT tearing it down, so
 *  an editor rebuild that only tweaked params (or moved the object) keeps the existing
 *  particle stream flowing instead of restarting it. Returns false if `e` isn't a
 *  particle emitter (the caller then builds a fresh one). Reposition `e` separately. */
export function reconfigureParticles(e: Entity, look: Partial<ParticleLook>, sprite: Texture2D | null, engine: Engine): boolean {
  const emit = e.children[0];
  const r = emit?.getComponent(ParticleRenderer);
  const mat = (r?.getMaterial() as ParticleMaterial | null) ?? null;
  if (!r || !mat) return false;
  configureEmitter(r, mat, { ...PARTICLE_LOOK, ...look }, sprite, engine);
  return true;
}

/** write a full look onto a renderer + material. Shared by build + reconfigure. Only
 *  reallocates the particle buffer when maxParticles actually changes (reallocating
 *  clears live particles — avoiding it is what keeps a moved/edited emitter smooth). */
function configureEmitter(r: ParticleRenderer, mat: ParticleMaterial, L: ParticleLook, sprite: Texture2D | null, engine: Engine): void {
  mat.baseTexture = sprite ?? puffSprite(engine);
  mat.blendMode = L.additive ? BlendMode.Additive : BlendMode.Normal;

  const g = r.generator;
  const main = g.main;
  main.startLifetime = new ParticleCompositeCurve(L.lifetime);
  main.startSpeed = new ParticleCompositeCurve(L.speed);
  main.startSize = new ParticleCompositeCurve(L.size);
  main.startColor = new ParticleCompositeGradient(new Color(L.color[0], L.color[1], L.color[2], L.opacity));
  main.gravityModifier = new ParticleCompositeCurve(L.gravity);
  main.simulationSpace = L.world ? ParticleSimulationSpace.World : ParticleSimulationSpace.Local;
  // headroom for the steady-state population, +a little for bursts
  const maxP = Math.max(16, Math.ceil(L.rate * L.lifetime) + 8);
  if (main.maxParticles !== maxP) main.maxParticles = maxP;   // realloc only when needed

  g.emission.rateOverTime = new ParticleCompositeCurve(Math.max(0, L.rate));
  const cone = new ConeShape();
  cone.angle = L.spread;
  cone.radius = Math.max(0.02, L.emitRadius ?? 0.05);
  g.emission.shape = cone;

  // grow (or shrink) each particle over its life
  if (L.growth !== 1) {
    const curve = new ParticleCurve();
    curve.addKey(0, 1);
    curve.addKey(1, Math.max(0, L.growth));
    g.sizeOverLifetime.enabled = true;
    g.sizeOverLifetime.size = new ParticleCompositeCurve(curve);
  } else {
    g.sizeOverLifetime.enabled = false;
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
}
