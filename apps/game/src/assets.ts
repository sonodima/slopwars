// ─── Asset loading infra: URL manifest + typed resourceManager wrappers ──────
// Assets live in public/assets/ (copied verbatim by Vite). Loaded at runtime by
// URL via Galacean's resourceManager. base "./" → BASE_URL keeps paths portable.
import {
  AssetType, Engine, GLTFResource, Texture2D, TextureCube, TextureWrapMode,
} from "@galacean/engine";

const BASE = import.meta.env.BASE_URL;

/** absolute-at-runtime url for an asset under public/assets/ */
export function assetUrl(path: string): string {
  return `${BASE}assets/${path}`;
}

/** load a Texture2D with tiling (Repeat) enabled. `srgb` MUST match how the map is
 *  consumed: base-colour/albedo is authored in sRGB (default), but data maps —
 *  tangent normals and the packed AO/Roughness/Metallic set — are LINEAR data and
 *  must load with `srgb: false`. Loading a data map as sRGB makes the GPU gamma-decode
 *  it on sample, so e.g. a roughness of 0.5 reads as ~0.21 and every surface comes out
 *  far glossier/more reflective than authored — the classic "not real PBR" look. (The
 *  glTF loader already picks the right space per texture; this is for our own maps.) */
export async function loadTexture2D(engine: Engine, path: string, srgb = true): Promise<Texture2D> {
  const t = await engine.resourceManager.load<Texture2D>({
    url: assetUrl(path), type: AssetType.Texture2D, params: { isSRGBColorSpace: srgb },
  });
  t.wrapModeU = TextureWrapMode.Repeat;
  t.wrapModeV = TextureWrapMode.Repeat;
  return t;
}

/** equirectangular .hdr → prefiltered TextureCube (skybox + IBL specular) */
export async function loadHDRCube(engine: Engine, path: string): Promise<TextureCube> {
  return engine.resourceManager.load<TextureCube>({ url: assetUrl(path), type: AssetType.HDR });
}

export async function loadGLTF(engine: Engine, path: string): Promise<GLTFResource> {
  return engine.resourceManager.load<GLTFResource>({ url: assetUrl(path), type: AssetType.GLTF });
}
