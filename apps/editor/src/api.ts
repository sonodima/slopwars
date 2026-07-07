// ─── Editor API client: file operations via the Tauri backend ────────────────
// These invoke Rust commands (src-tauri/src/commands.rs) that read/write the
// repo's maps/ and public/assets/ directories directly on disk. This is the
// git-first workflow: the editor writes JSON into the working tree using real
// desktop file access — no dev-server middleware required, and it keeps working
// in the packaged app.
import { invoke } from "@tauri-apps/api/core";
import type { AssetCatalog, MapCatalogEntry, MapDef } from "@slopwars/shared";

/** one uploaded file for an import: base64 `data`, original `name`, optional
 *  PBR `slot` (texture sets). */
export interface ImportFile { name: string; data: string; slot?: "color" | "normal" | "arm" }
export interface ImportRequest { kind: "texture" | "model" | "audio" | "hdri"; name: string; files: ImportFile[] }
export interface ImportResult { ok?: boolean; error?: string; name?: string; files?: string[] }

export const api = {
  catalog: (): Promise<AssetCatalog> => invoke("scan_assets"),
  maps: (): Promise<MapCatalogEntry[]> => invoke("scan_maps"),
  loadMap: (file: string): Promise<MapDef> => invoke("load_map", { file }),
  saveMap: (id: string, def: MapDef): Promise<unknown> => invoke("save_map", { id, def }),
  importAsset: (req: ImportRequest): Promise<ImportResult> => invoke("import_asset", { req }),
};
