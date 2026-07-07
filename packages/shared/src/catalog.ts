// ─── Asset catalog: the file-driven inventory of everything under public/assets ─
// The catalog is produced at dev/build time by the Vite asset-scanner plugin
// (vite-asset-catalog.ts), which reads the filesystem so that *no* asset file
// names are hardcoded in game or editor source. Adding a model/texture folder
// and committing it is all it takes to make the asset available — the scanner
// discovers it, the client loads it, and the editor lists it.

/** a glTF model discovered under public/assets/models/{name}/ */
export interface ModelAsset {
  name: string;            // folder name = canonical asset key
  gltf: string;            // path under assets/ e.g. "models/Barrel_01/Barrel_01.gltf"
  meta?: Record<string, unknown>;
}

/** which of the standard PBR maps a texture folder provides */
export interface TextureMaps {
  color?: string;   // path under assets/
  normal?: string;
  arm?: string;     // packed AO / roughness / metallic
  [k: string]: string | undefined;
}

/** a PBR texture set discovered under public/assets/textures/{name}/ */
export interface TextureAsset {
  name: string;
  maps: TextureMaps;
  meta?: Record<string, unknown>;
}

/** an audio clip discovered under public/assets/audio/ (flat file or folder) */
export interface AudioAsset {
  name: string;
  file: string;            // path under assets/
}

/** an HDRI environment map under public/assets/hdri/ */
export interface HdriAsset {
  name: string;
  file: string;            // path under assets/
}

import type { MaterialAsset } from "./materials";

/** the complete discovered inventory */
export interface AssetCatalog {
  models: ModelAsset[];
  textures: TextureAsset[];
  materials: MaterialAsset[];
  audio: AudioAsset[];
  hdri: HdriAsset[];
}

/** map summary produced by scanning maps/*.json (for the pool + editor picker) */
export interface MapCatalogEntry {
  id: string;
  name: string;
  theme: string;
  file: string;            // path relative to the served root, e.g. "maps/koi.json"
}

// ── lookup helpers (used by both apps) ──────────────────────────────────────

export function findModel(cat: AssetCatalog, name: string): ModelAsset | undefined {
  return cat.models.find((m) => m.name === name);
}

export function findTexture(cat: AssetCatalog, name: string): TextureAsset | undefined {
  return cat.textures.find((t) => t.name === name);
}
