// ─── Tauri commands: editor file operations ──────────────────────────────────
// The frontend `api.ts` invokes these instead of the old dev-server endpoints.
// They read/write the repo's `maps/` and `public/assets/` directories with real
// desktop file access. The import logic is a Rust port of the shared Vite plugin's
// `importAsset`, so the JSON request/response shapes are unchanged.
use crate::catalog;
use crate::root::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use tauri::State;

// ── name / path helpers (mirror the TS sanitizers) ───────────────────────────

fn sanitize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect()
}

fn sanitize_file(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    base.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(128)
        .collect()
}

fn ext_of(file: &str) -> String {
    file.rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_default()
}

fn write_asset_b64(root: &Path, rel: &str, b64: &str) -> Result<(), String> {
    let abs = root.join("public").join("assets").join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = STANDARD.decode(b64).map_err(|e| format!("bad base64: {e}"))?;
    std::fs::write(&abs, bytes).map_err(|e| e.to_string())
}

// ── map I/O ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn scan_assets(state: State<'_, AppState>) -> Value {
    catalog::scan_assets(&state.root)
}

#[tauri::command]
pub fn scan_maps(state: State<'_, AppState>) -> Value {
    catalog::scan_maps(&state.root)
}

#[tauri::command]
pub fn load_map(state: State<'_, AppState>, file: &str) -> Result<Value, String> {
    // `file` is like "maps/koi.json"; only the basename is trusted.
    let name = Path::new(file)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid map file".to_string())?;
    let path = state.root.join("maps").join(name);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("invalid map JSON: {e}"))
}

#[tauri::command]
pub fn save_map(state: State<'_, AppState>, id: &str, def: Value) -> Result<Value, String> {
    let name = sanitize(id);
    if name.is_empty() {
        return Err("invalid map id".into());
    }
    let dir = state.root.join("maps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.json"));
    let body = serde_json::to_string_pretty(&def).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "file": format!("maps/{name}.json") }))
}

// ── asset import ──────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct ImportFile {
    name: String,
    data: String,
    #[serde(default)]
    slot: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ImportRequest {
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    files: Vec<ImportFile>,
}

fn err(msg: impl Into<String>) -> Value {
    json!({ "error": msg.into() })
}

#[tauri::command]
pub fn import_asset(state: State<'_, AppState>, req: ImportRequest) -> Value {
    let root = &state.root;
    let name = sanitize(&req.name);
    if req.files.is_empty() {
        return err("no files provided");
    }

    let img_ext: HashSet<&str> = ["jpg", "jpeg", "png", "webp", "ktx", "ktx2", "hdr"].into();
    let model_ext: HashSet<&str> =
        ["gltf", "glb", "bin", "jpg", "jpeg", "png", "webp", "ktx", "ktx2"].into();
    let audio_ext: HashSet<&str> = ["mp3", "wav", "ogg", "m4a"].into();

    match req.kind.as_str() {
        "texture" => {
            if name.is_empty() {
                return err("texture needs a name");
            }
            let mut written = Vec::new();
            for f in &req.files {
                let slot = f.slot.as_deref().unwrap_or("");
                let ext = ext_of(&f.name);
                if !["color", "normal", "arm"].contains(&slot) {
                    return err(format!("bad texture slot: {slot}"));
                }
                if !img_ext.contains(ext.as_str()) {
                    return err(format!("unsupported image type: .{ext}"));
                }
                let rel = format!("textures/{name}/{slot}.{ext}");
                if let Err(e) = write_asset_b64(root, &rel, &f.data) {
                    return err(e);
                }
                written.push(rel);
            }
            json!({ "ok": true, "name": name, "files": written })
        }
        "model" => {
            if name.is_empty() {
                return err("model needs a name");
            }
            let has_gltf = req
                .files
                .iter()
                .any(|f| matches!(ext_of(&f.name).as_str(), "gltf" | "glb"));
            if !has_gltf {
                return err("model needs a .gltf or .glb file");
            }
            let mut written = Vec::new();
            for f in &req.files {
                let ext = ext_of(&f.name);
                if !model_ext.contains(ext.as_str()) {
                    return err(format!("unsupported model file: .{ext}"));
                }
                let rel = format!("models/{name}/{}", sanitize_file(&f.name));
                if let Err(e) = write_asset_b64(root, &rel, &f.data) {
                    return err(e);
                }
                written.push(rel);
            }
            json!({ "ok": true, "name": name, "files": written })
        }
        "audio" => {
            let f = &req.files[0];
            let ext = ext_of(&f.name);
            if !audio_ext.contains(ext.as_str()) {
                return err(format!("unsupported audio type: .{ext}"));
            }
            let base = if name.is_empty() {
                sanitize(strip_ext(&f.name))
            } else {
                name
            };
            if base.is_empty() {
                return err("audio needs a name");
            }
            let rel = format!("audio/{base}.{ext}");
            if let Err(e) = write_asset_b64(root, &rel, &f.data) {
                return err(e);
            }
            json!({ "ok": true, "name": base, "files": [rel] })
        }
        "hdri" => {
            let f = &req.files[0];
            let mut ext = ext_of(&f.name);
            if ext.is_empty() {
                ext = "hdr".into();
            }
            if !["hdr", "exr"].contains(&ext.as_str()) {
                return err(format!("unsupported hdri type: .{ext}"));
            }
            let base = if name.is_empty() {
                sanitize(strip_ext(&f.name))
            } else {
                name
            };
            if base.is_empty() {
                return err("hdri needs a name");
            }
            let rel = format!("hdri/{base}.{ext}");
            if let Err(e) = write_asset_b64(root, &rel, &f.data) {
                return err(e);
            }
            json!({ "ok": true, "name": base, "files": [rel] })
        }
        other => err(format!("unknown import kind: {other}")),
    }
}

fn strip_ext(file: &str) -> &str {
    file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file)
}
