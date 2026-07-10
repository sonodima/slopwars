// ─── Render settings: apply a map's env quality knobs to the live scene ──────
// One place that turns the declarative MapEnv graphics fields (shadows, fog
// falloff, tonemapping, bloom) into engine state, so the game and the editor
// viewport render a map identically. Both call these with their own scene /
// light / camera / effect refs; defaults live in @slopwars/shared so an
// untouched map keeps the engine's original built-in look.
import {
  BloomEffect, Color, FogMode, Scene, ShadowResolution, ShadowType, TonemappingEffect, TonemappingMode,
} from "@galacean/engine";
import type { DirectLight } from "@galacean/engine";
import { envFogFalloff, envPost, envShadows, type MapEnv, type ShadowQuality } from "@slopwars/shared";

/** how each quality tier maps to shadow-map resolution + filtering */
const SHADOW_TIER: Record<Exclude<ShadowQuality, "off">, { res: ShadowResolution; soft: ShadowType }> = {
  low: { res: ShadowResolution.Low, soft: ShadowType.SoftLow },
  medium: { res: ShadowResolution.Medium, soft: ShadowType.SoftLow },
  high: { res: ShadowResolution.High, soft: ShadowType.SoftHigh },
  ultra: { res: ShadowResolution.VeryHigh, soft: ShadowType.SoftHigh },
};

const QUALITY_ORDER: ShadowQuality[] = ["off", "low", "medium", "high", "ultra"];
/** clamp a quality tier to a ceiling (used by the editor's viewport-quality cap) */
export function clampQuality(q: ShadowQuality, cap: ShadowQuality): ShadowQuality {
  return QUALITY_ORDER[Math.min(QUALITY_ORDER.indexOf(q), QUALITY_ORDER.indexOf(cap))] ?? q;
}

/** apply shadow quality/behaviour to the scene + sun. `cap` optionally lowers the
 *  tier (editor perf preset); pass "ultra" for no cap (the game). */
export function applyShadows(scene: Scene, sun: DirectLight, env: MapEnv, cap: ShadowQuality = "ultra"): void {
  const s = envShadows(env);
  const q = clampQuality(s.quality, cap);
  if (q === "off") { sun.shadowType = ShadowType.None; scene.castShadows = false; return; }
  const tier = SHADOW_TIER[q];
  scene.castShadows = true;
  sun.shadowType = tier.soft;
  sun.shadowStrength = s.strength;
  scene.shadowResolution = tier.res;
  scene.shadowDistance = s.distance;
}

/** apply fog falloff + density (colour/start/end are set by the caller) */
export function applyFogFalloff(scene: Scene, fog: NonNullable<MapEnv["fog"]>): void {
  const { falloff, density } = envFogFalloff(fog);
  scene.fogMode = falloff === "exp" ? FogMode.Exponential : falloff === "exp2" ? FogMode.ExponentialSquared : FogMode.Linear;
  scene.fogColor = new Color(fog.color[0], fog.color[1], fog.color[2], 1);
  scene.fogStart = fog.start;
  scene.fogEnd = fog.end;
  scene.fogDensity = density;
}

/** apply tonemapping mode + bloom params to the post-process effects */
export function applyPost(env: MapEnv, bloom: BloomEffect | null, tone: TonemappingEffect | null): void {
  const p = envPost(env);
  if (bloom) {
    bloom.enabled = p.bloom.enabled;
    bloom.intensity.value = p.bloom.intensity;
    bloom.threshold.value = p.bloom.threshold;
    bloom.scatter.value = p.bloom.scatter;
  }
  if (tone) {
    tone.enabled = p.tonemapping !== "none";
    tone.mode.value = p.tonemapping === "neutral" ? TonemappingMode.Neutral : TonemappingMode.ACES;
  }
}
