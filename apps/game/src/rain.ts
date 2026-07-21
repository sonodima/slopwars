// ─── Rain: camera-following world-space particle field ────────────────────────
// A single cone emitter hovers a dozen metres above the local camera and rains
// stretched-billboard drops in WORLD simulation space — the emitter teleports
// with the player every frame but the drops already in flight keep falling
// straight, so strafing never drags the rain sideways. Purely cosmetic and
// client-side: rain is authored per map (env.weather.rain), identical for every
// player, and never occludes anything gameplay-relevant.
import {
  Color, ConeShape, Entity, ParticleCompositeCurve, ParticleCompositeGradient, ParticleGradient,
  ParticleMaterial, ParticleRenderMode, ParticleRenderer, ParticleSimulationSpace, Script,
  Texture2D, TextureFormat,
} from "@galacean/engine";
import type { Engine } from "@galacean/engine";
import type { EnvRain } from "./maps/schema";

const RATE = 1900;        // drops/s at intensity 1
const AREA_R = 15;        // emission disc radius (m)
const HEIGHT = 12;        // emitter height above the camera (m)
const FALL = 17;          // mean fall speed (m/s)
const LIFE = 1.5;         // seconds — enough to fall past a low camera

/** slim vertical droplet sprite; the stretch billboard elongates it along the
 *  fall velocity into a streak. */
function dropSprite(engine: Engine): Texture2D {
  const S = 32;
  const tex = new Texture2D(engine, S, S, TextureFormat.R8G8B8A8, false);
  const buf = new Uint8Array(S * S * 4);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      const a = Math.max(0, 1 - d);
      const soft = a * a;
      const i = (y * S + x) * 4;
      buf[i] = buf[i + 1] = buf[i + 2] = 255;
      buf[i + 3] = Math.round(soft * 255);
    }
  }
  tex.setPixelBuffer(buf);
  return tex;
}

export class RainFX extends Script {
  private target: Entity | null = null;   // the camera to follow
  private outer!: Entity;
  private renderer!: ParticleRenderer;
  private level = 0;
  private wind: [number, number] = [0, 0];

  static attach(root: Entity, camEntity: Entity): RainFX {
    const engine = root.engine;
    const fx = root.createChild("rain-fx").addComponent(RainFX);
    fx.target = camEntity;

    const outer = root.createChild("rain");
    // outer +Y flipped to point down; the inner +90°X child aims the cone along
    // outer +Y (same trick as particles.ts) — so drops emit straight down
    outer.transform.setRotation(180, 0, 0);
    const emit = outer.createChild("emit");
    emit.transform.setRotation(90, 0, 0);

    const r = emit.addComponent(ParticleRenderer);
    const mat = new ParticleMaterial(engine);
    mat.baseColor = new Color(1, 1, 1, 1);
    mat.isTransparent = true;
    mat.baseTexture = dropSprite(engine);
    r.setMaterial(mat);
    r.renderMode = ParticleRenderMode.StretchBillboard;   // streaks, not dots
    r.lengthScale = 8;
    r.velocityScale = 0;

    const g = r.generator;
    const main = g.main;
    main.startLifetime = new ParticleCompositeCurve(LIFE);
    main.startSpeed = new ParticleCompositeCurve(FALL - 2, FALL + 2);
    main.startSize = new ParticleCompositeCurve(0.018, 0.032);
    main.startColor = new ParticleCompositeGradient(new Color(0.62, 0.68, 0.8, 0.45));
    main.gravityModifier = new ParticleCompositeCurve(0.35);
    main.simulationSpace = ParticleSimulationSpace.World;
    main.maxParticles = Math.ceil(RATE * LIFE) + 64;

    g.emission.rateOverTime = new ParticleCompositeCurve(0);
    const cone = new ConeShape();
    cone.angle = 3;
    cone.radius = AREA_R;
    g.emission.shape = cone;

    // hold colour, quick fade-in and a short dissolve at end of life
    const grad = new ParticleGradient();
    grad.addColorKey(0, new Color(1, 1, 1));
    grad.addColorKey(1, new Color(1, 1, 1));
    grad.addAlphaKey(0, 0.6);
    grad.addAlphaKey(0.85, 1);
    grad.addAlphaKey(1, 0);
    g.colorOverLifetime.enabled = true;
    g.colorOverLifetime.color = new ParticleCompositeGradient(grad);
    g.play();

    fx.outer = outer;
    fx.renderer = r;
    outer.isActive = false;
    return fx;
  }

  /** set rainfall from the resolved env block (null = dry) */
  configure(rain: EnvRain | null): void {
    this.level = rain?.intensity ?? 0;
    this.wind = rain?.wind ?? [0, 0];
    this.outer.isActive = this.level > 0;
    this.renderer.generator.emission.rateOverTime = new ParticleCompositeCurve(RATE * this.level);
    // wind = a slight emitter tilt (drops keep their world-space velocity)
    const tiltZ = (Math.atan2(this.wind[0], FALL) * 180) / Math.PI;
    const tiltX = (Math.atan2(this.wind[1], FALL) * 180) / Math.PI;
    this.outer.transform.setRotation(180 + tiltX, 0, tiltZ);
  }

  /** current rainfall level (drives the ambience loop volume in main) */
  intensity(): number { return this.level; }

  override onLateUpdate(): void {
    if (!this.outer.isActive || !this.target) return;
    const p = this.target.transform.worldPosition;
    // lead slightly upwind so the visible column stays centred on the player
    this.outer.transform.setPosition(
      p.x - this.wind[0] * 0.35 * HEIGHT / FALL,
      p.y + HEIGHT,
      p.z - this.wind[1] * 0.35 * HEIGHT / FALL,
    );
  }
}
