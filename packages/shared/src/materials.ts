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
 *  colour, with optional overrides. The common case — walls, floors, props.
 *  Tiling is NOT here: it's a property of the *geometry* (an object's `tile`),
 *  since the same material maps onto a huge floor and a small crate at different
 *  repeats to keep a consistent texel density. */
export interface StandardMaterialDef {
  type: "standard";
  texture?: string;                 // texture folder name (omit → solid colour)
  color?: Tuple3;                   // tint over the texture, or the solid colour
  roughness?: number;               // absolute (solid) / multiplies the arm map (textured)
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

/** the material kinds a user can create (the editor's "New material" picker) */
export const MATERIAL_TYPES: MaterialType[] = ["standard", "water", "glass"];

/** a fresh default def for a newly-created material of a given kind. Water and
 *  glass share their engine logic (animated surface / refraction) and only differ
 *  by these tunable params, so "create → kind=water → tune → name" yields as many
 *  distinct water/glass materials as you like. */
export function defaultMaterialDef(type: MaterialType): MaterialDef {
  if (type === "water") {
    return {
      type: "water",
      color: [0.015, 0.06, 0.08], opacity: 0.96, roughness: 0.12, ior: 1.33,
      flow: 0.05, waves: 0.6, depthColor: [0.04, 0.18, 0.22], depth: 1.6, clarity: 0.4,
    };
  }
  if (type === "glass") {
    return {
      type: "glass",
      color: [0.85, 0.92, 0.95], opacity: 0.16, roughness: 0.02, ior: 1.5,
      thickness: 0.4, tint: [0.9, 0.96, 0.98],
    };
  }
  return { type: "standard", color: [0.7, 0.7, 0.72], roughness: 0.85, metallic: 0 };
}
