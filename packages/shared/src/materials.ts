// ─── Material definitions (shared by game + editor + the asset scanner) ───────
// A material is a first-class, reusable asset: `public/assets/materials/{name}.json`.
// Following every modern engine (Unity/Unreal/Godot/three), *a texture is never
// applied to geometry directly* — a Material is. The material owns the shading
// model (`type`) and all of its inputs (texture sets, colours, params). Objects
// reference a material by name; the game's material factory (game/materials.ts)
// turns a def into an engine material. New surface = a new `type`, no schema churn.
import type { Tuple3 } from "./schema";

/** the built-in shading models */
export type MaterialType = "standard" | "glass" | "water";

/** physically-based surface: a PBR texture set (by folder name) and/or a solid
 *  colour, with optional overrides. The common case — walls, floors, props. */
export interface StandardMaterialDef {
  type: "standard";
  texture?: string;                 // texture folder name (omit → solid colour)
  color?: Tuple3;                   // tint over the texture, or the solid colour
  tiling?: [number, number];        // base UV tiling (an object's `tile` multiplies this)
  roughness?: number;               // absolute (solid) / falls back to the arm map (textured)
  metallic?: number;
  emissive?: Tuple3;                // self-illumination (feeds bloom)
}

/** refractive/transmissive glass — a window, panel, bottle. Applied to any box. */
export interface GlassMaterialDef {
  type: "glass";
  color?: Tuple3;                   // glass tint (base colour rgb)
  opacity?: number;                 // base alpha (edge/grazing opacity)
  roughness?: number;               // 0 = perfectly clear, higher = frosted
  ior?: number;                     // index of refraction (≈1.5 window glass)
  thickness?: number;               // refraction thickness (bends light more when thicker)
  tint?: Tuple3;                    // absorption tint accumulated through the glass
}

/** animated liquid surface — used by the `water` object (a plane + flow system). */
export interface WaterMaterialDef {
  type: "water";
  color?: Tuple3;                   // surface tint
  opacity?: number;                 // base alpha
  roughness?: number;               // 0 = mirror sky reflection
  ior?: number;                     // index of refraction (1.33 = water)
  flow?: number;                    // ripple scroll speed
  waves?: number;                   // wave normal strength
  depthColor?: Tuple3;              // attenuation tint with depth
  depth?: number;                   // attenuation distance
  clarity?: number;                 // transmission amount (1 = fully see-through)
}

export type MaterialDef = StandardMaterialDef | GlassMaterialDef | WaterMaterialDef;

/** a material discovered under public/assets/materials/{name}.json */
export interface MaterialAsset {
  name: string;                     // file name (minus .json) = canonical key
  def: MaterialDef;
}
