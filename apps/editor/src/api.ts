// ─── Editor API client: talk to the dev server's file endpoints ──────────────
// These hit the middleware in the asset-catalog Vite plugin (editor:true), which
// reads/writes the repo's maps/ and public/assets/materials/ directories. This
// is the git-first workflow: the editor writes JSON into the working tree.
import type { AssetCatalog, MapCatalogEntry, MapDef, MaterialDef, MaterialType, ModelMeta } from "@slopwars/shared";

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}
async function jpost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${url} → ${res.status}`);
  return data;
}

/** one uploaded file for an import: base64 `data`, original `name`, optional
 *  PBR `slot` (texture sets). */
export interface ImportFile { name: string; data: string; slot?: "color" | "normal" | "arm" }
export interface ImportRequest { kind: "texture" | "model" | "audio" | "hdri"; name: string; files: ImportFile[] }
export interface ImportResult { ok?: boolean; error?: string; name?: string; files?: string[] }

export const api = {
  catalog: (): Promise<AssetCatalog> => jget("/__editor/catalog"),
  maps: (): Promise<MapCatalogEntry[]> => jget("/__editor/maps"),
  loadMap: (file: string): Promise<MapDef> => jget(`/${file}`),
  saveMap: (id: string, def: MapDef): Promise<unknown> => jpost("/__editor/save", { id, def }),
  importAsset: (req: ImportRequest): Promise<ImportResult> => jpost("/__editor/import", req) as Promise<ImportResult>,
  // materials are *created* (not imported) and edited in place → write JSON files.
  // create defaults to a plain gray material; the kind is chosen in the inspector.
  createMaterial: (type?: MaterialType): Promise<{ name?: string; error?: string }> => jpost("/__editor/material", { op: "create", type }) as Promise<{ name?: string; error?: string }>,
  saveMaterial: (name: string, def: MaterialDef): Promise<{ name?: string; error?: string }> => jpost("/__editor/material", { op: "save", name, def }) as Promise<{ name?: string; error?: string }>,
  renameMaterial: (from: string, to: string): Promise<{ name?: string; error?: string }> => jpost("/__editor/material", { op: "rename", from, to }) as Promise<{ name?: string; error?: string }>,
  deleteMaterial: (name: string): Promise<{ error?: string }> => jpost("/__editor/material", { op: "delete", name }) as Promise<{ error?: string }>,
  // models: calibration meta (base/scale/material) + delete
  saveModelMeta: (name: string, meta: ModelMeta): Promise<{ name?: string; error?: string }> => jpost("/__editor/model", { op: "save", name, meta }) as Promise<{ name?: string; error?: string }>,
  deleteModel: (name: string): Promise<{ error?: string }> => jpost("/__editor/model", { op: "delete", name }) as Promise<{ error?: string }>,
  // textures are a *group* of PBR maps: create an empty set, then fill its maps in the
  // texture editor (no up-front multi-file import dialog).
  createTexture: (): Promise<{ name?: string; error?: string }> => jpost("/__editor/texture", { op: "create" }) as Promise<{ name?: string; error?: string }>,
  deleteTexture: (name: string): Promise<{ error?: string }> => jpost("/__editor/texture", { op: "delete", name }) as Promise<{ error?: string }>,
  // clear a single PBR map (color/normal/arm) of a texture set, leaving the set intact
  clearTextureMap: (name: string, slot: "color" | "normal" | "arm"): Promise<{ error?: string }> => jpost("/__editor/texture", { op: "clearMap", name, slot }) as Promise<{ error?: string }>,
  // skyboxes (hdri) + audio are single files, deleted by their catalog path
  deleteAsset: (file: string): Promise<{ error?: string }> => jpost("/__editor/asset", { op: "delete", file }) as Promise<{ error?: string }>,
  deleteMap: (file: string): Promise<{ error?: string }> => jpost("/__editor/map", { op: "delete", file }) as Promise<{ error?: string }>,
};
