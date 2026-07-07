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

/** a material — either discovered under public/assets/materials/{name}.json, or
 *  one of the code-registered built-ins below. */
export interface MaterialAsset {
  name: string;                     // file name (minus .json) = canonical key
  def: MaterialDef;
  /** true for the code-registered built-ins (water/glass): not editable, not a
   *  file, always present. The editor renders these read-only. */
  builtin?: boolean;
}

// ── code-registered built-in materials ───────────────────────────────────────
// The special shading types (`water`, `glass`) are singletons defined in code,
// not per-map JSON: there is exactly one water and one glass look for the whole
// project. They always exist, can't be renamed/deleted, and their look lives here
// as the single source of truth (the game builds the engine material from it, the
// editor previews it). Standard materials, by contrast, are user-created files.
export const BUILTIN_MATERIALS: MaterialAsset[] = [
  {
    name: "water", builtin: true,
    def: {
      type: "water",
      color: [0.015, 0.06, 0.08], opacity: 0.96, roughness: 0.12, ior: 1.33,
      flow: 0.05, waves: 0.6, depthColor: [0.04, 0.18, 0.22], depth: 1.6, clarity: 0.4,
    },
  },
  {
    name: "glass", builtin: true,
    def: {
      type: "glass",
      color: [0.85, 0.92, 0.95], opacity: 0.16, roughness: 0.02, ior: 1.5,
      thickness: 0.4, tint: [0.9, 0.96, 0.98],
    },
  },
];

/** merge the code built-ins with file materials (built-ins win + sort by name) —
 *  the full material list every consumer (game library, editor browser) sees. */
export function mergeBuiltinMaterials(fileMaterials: MaterialAsset[]): MaterialAsset[] {
  const byName = new Map<string, MaterialAsset>();
  for (const m of fileMaterials) byName.set(m.name, m);
  for (const b of BUILTIN_MATERIALS) byName.set(b.name, b);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
