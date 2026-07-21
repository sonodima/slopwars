// ─── WeatherFX: one facade over the atmospheric layers ────────────────────────
// Owns the per-map lifecycle of clouds (clouds.ts), fog/mist/rays (atmo.ts) and
// rain (rain.ts), driven purely by env.weather (schema). main.ts talks to this
// facade only: applyEnv() → apply(), the settings knob → setEnabled(), and the
// depth-prepass coordination reads needsDepth().
//
// Ordering contract with applyEnv(): main sets the STOCK sky/background first,
// then calls apply() — weather only *overrides* the background with the
// cloud-compositing sky material when clouds are on. Turning weather off (map
// change or settings) therefore just needs applyEnv to run again; there is no
// bespoke "restore" path to keep in sync.
import { BackgroundMode, Camera, Entity } from "@galacean/engine";
import type { DirectLight, Scene, TextureCube } from "@galacean/engine";
import { envSunColor, envWeather, type MapEnv } from "./maps/schema";
import { CloudFX } from "./clouds";
import { AtmoFX } from "./atmo";
import { RainFX } from "./rain";

export class WeatherFX {
  private clouds: CloudFX;
  private atmo: AtmoFX;
  private rain: RainFX;
  private scene: Scene;
  private enabled = true;          // the settings knob (map env decides the look)

  private constructor(clouds: CloudFX, atmo: AtmoFX, rain: RainFX, scene: Scene) {
    this.clouds = clouds;
    this.atmo = atmo;
    this.rain = rain;
    this.scene = scene;
  }

  static attach(root: Entity, cam: Camera, sun: DirectLight | null): WeatherFX {
    return new WeatherFX(
      CloudFX.attach(root, sun),
      AtmoFX.attach(root, cam, sun),
      RainFX.attach(root, cam.entity),
      root.scene,
    );
  }

  /** apply a map's weather (called from applyEnv AFTER the stock sky is set).
   *  `cube` is the map's already-loaded HDRI, or null on solid-sky maps. */
  apply(env: MapEnv, cube: TextureCube | null): void {
    const w = this.enabled ? envWeather(env) : { clouds: null, mist: null, rays: null, rain: null };

    this.clouds.configure(w.clouds, env.ambient.color, env.ambient.intensity);
    if (w.clouds && CloudFX.supported(this.scene.engine)) {
      this.clouds.setSky(cube, env.sky.solid ?? [0.03, 0.04, 0.06], envSunColor(env));
      this.scene.background.mode = BackgroundMode.Sky;
      this.scene.background.sky.material = this.clouds.skyMat;
    }
    this.atmo.configure(w.mist, w.rays);
    this.rain.configure(w.rain);
  }

  /** the settings knob. Returns true when the value changed — the caller then
   *  re-runs applyEnv (which restores the stock sky and re-applies weather). */
  setEnabled(on: boolean): boolean {
    if (this.enabled === on) return false;
    this.enabled = on;
    return true;
  }

  /** whether the screen-space pass needs the camera depth prepass right now */
  needsDepth(): boolean { return this.atmo.needsDepth(); }

  /** current rainfall (0 = dry) — drives the rain ambience loop */
  rainLevel(): number { return this.enabled ? this.rain.intensity() : 0; }
}
