// ─── Material library: turn material defs into engine materials ───────────────
// The one place that knows how to build a Galacean material from a MaterialDef.
// Geometry references a material by *name* (an object's `mat` param); this library
// resolves the name to its def (from the scanned catalog) and builds/caches the
// PBRMaterial. `standard` and `glass` both produce a PBRMaterial (glass just adds
// transmission); `water` is a surface *system* (an animated plane), so the water
// object builds it from the def's WaterLook — see water.ts. Textures are inputs a
// standard material consumes, never applied to geometry directly.
import { Color, Engine, PBRMaterial, RefractionMode, Vector4 } from "@galacean/engine";
import catalog from "virtual:asset-catalog";
import type { MaterialDef, StandardMaterialDef, GlassMaterialDef } from "@slopwars/shared";
import { MapTextures, PbrSet, DEFAULT_FOLDER } from "./textures";
import { WATER_LOOK, type WaterLook } from "./water";

/** the scanned material defs (file-based). The editor can pass a live override
 *  map into a MaterialLibrary so unsaved edits preview in the viewport. */
const CATALOG_DEFS = new Map<string, MaterialDef>(catalog.materials.map((m) => [m.name, m.def]));
/** a material guaranteed to exist — the fallback for an object that names a gap */
export const DEFAULT_MATERIAL = CATALOG_DEFS.has("gray") ? "gray" : (catalog.materials[0]?.name ?? "gray");

/** look up a material def by name (falls back to the default material) */
export function materialDef(name: string, defs: Map<string, MaterialDef> = CATALOG_DEFS): MaterialDef {
  return defs.get(name) ?? defs.get(DEFAULT_MATERIAL) ?? CATALOG_DEFS.get(DEFAULT_MATERIAL) ?? { type: "standard" };
}

/** the texture folders a set of materials need loaded (only `standard` materials
 *  with a texture; glass/water carry no textures). `defs` may be an editor-live
 *  override so a just-assigned texture is loaded before the rebuild. */
export function materialTextureFolders(names: Iterable<string>, defs: Map<string, MaterialDef> = CATALOG_DEFS): string[] {
  const set = new Set<string>();
  for (const n of names) {
    const d = defs.get(n);
    if (d?.type === "standard" && d.texture) set.add(d.texture);
  }
  return [...set];
}

/** resolve a texture folder's PBR set, falling back to the default folder */
function texOf(tex: MapTextures, folder?: string): PbrSet {
  return (folder && tex.get(folder)) || tex.get(DEFAULT_FOLDER) || tex.values().next().value!;
}

export class MaterialLibrary {
  // built materials cached by (name + per-instance tiling), so identical surfaces
  // share one material — the whole point of the abstraction (edit once, reuse).
  private cache = new Map<string, PBRMaterial>();

  /** `defs` overrides the scanned catalog (the editor passes its live, possibly
   *  unsaved, material defs so edits preview immediately); the game omits it. */
  constructor(private engine: Engine, private tex: MapTextures, private defs: Map<string, MaterialDef> = CATALOG_DEFS) {}

  def(name: string): MaterialDef { return materialDef(name, this.defs); }
  isWater(name: string): boolean { return this.def(name).type === "water"; }

  /** WaterLook for a `water` material (defaults for any missing field) */
  waterLook(name: string): WaterLook {
    const d = this.def(name);
    if (d.type !== "water") return { ...WATER_LOOK };
    return {
      color: d.color ?? WATER_LOOK.color, opacity: d.opacity ?? WATER_LOOK.opacity,
      roughness: d.roughness ?? WATER_LOOK.roughness, ior: d.ior ?? WATER_LOOK.ior,
      flow: d.flow ?? WATER_LOOK.flow, waves: d.waves ?? WATER_LOOK.waves,
      depthColor: d.depthColor ?? WATER_LOOK.depthColor, depth: d.depth ?? WATER_LOOK.depth,
      clarity: d.clarity ?? WATER_LOOK.clarity,
    };
  }

  /** build (or fetch the cached) opaque/transparent material for a surface at the
   *  given per-instance tiling. `water` materials have no mesh material — the
   *  caller builds a water surface instead — so they resolve to the default. */
  build(name: string, tu = 1, tv = 1): PBRMaterial {
    const key = `${name}:${tu}:${tv}`;
    let m = this.cache.get(key);
    if (m) return m;
    const d = this.def(name);
    m = d.type === "glass" ? this.buildGlass(d) : this.buildStandard(d.type === "standard" ? d : { type: "standard" }, tu, tv);
    this.cache.set(key, m);
    return m;
  }

  private buildStandard(d: StandardMaterialDef, tu: number, tv: number): PBRMaterial {
    const m = new PBRMaterial(this.engine);
    if (d.texture) {
      const set = texOf(this.tex, d.texture);
      m.baseTexture = set.color;
      m.normalTexture = set.normal;
      m.roughnessMetallicTexture = set.arm; // G=roughness, B=metallic
      m.occlusionTexture = set.arm;         // R=ambient occlusion
      if (d.color) m.baseColor = new Color(d.color[0], d.color[1], d.color[2], 1);
      if (d.roughness != null) m.roughness = d.roughness;
      if (d.metallic != null) m.metallic = d.metallic;
    } else {
      const c = d.color ?? [0.6, 0.6, 0.62];
      m.baseColor = new Color(c[0], c[1], c[2], 1);
      m.roughness = d.roughness ?? 0.9;
      m.metallic = d.metallic ?? 0.02;
    }
    if (d.emissive) m.emissiveColor = new Color(d.emissive[0], d.emissive[1], d.emissive[2], 1);
    m.tilingOffset = new Vector4(tu, tv, 0, 0);   // tiling comes from the geometry (`tile`)
    return m;
  }

  private buildGlass(d: GlassMaterialDef): PBRMaterial {
    const m = new PBRMaterial(this.engine);
    const color = d.color ?? [0.85, 0.92, 0.95];
    const tint = d.tint ?? [0.9, 0.96, 0.98];
    m.baseColor = new Color(color[0], color[1], color[2], d.opacity ?? 0.16);
    m.roughness = d.roughness ?? 0.02;
    m.metallic = 0.0;
    m.ior = d.ior ?? 1.5;
    m.isTransparent = true;
    m.refractionMode = RefractionMode.Planar;   // refract the scene behind (opaque texture)
    m.transmission = 1.0;
    m.attenuationColor = new Color(tint[0], tint[1], tint[2], 1);
    m.attenuationDistance = 1.5;
    m.thickness = d.thickness ?? 0.4;
    return m;
  }
}
