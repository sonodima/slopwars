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

/** color/normal/arm map, tiling (Repeat) enabled */
export async function loadTexture2D(engine: Engine, path: string): Promise<Texture2D> {
  const t = await engine.resourceManager.load<Texture2D>({ url: assetUrl(path), type: AssetType.Texture2D });
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
