// ─── Filesystem asset + map scanner ──────────────────────────────────────────
// A Rust port of the shared Vite scanner (packages/shared/src/vite-asset-catalog.ts):
// it reads `public/assets/` and `maps/` and produces the same JSON shapes the
// editor UI expects (AssetCatalog, MapCatalogEntry[]). Keeping the shapes byte-for-
// byte compatible means the TypeScript UI code is untouched by the Tauri move.
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::OnceLock;

fn img_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(jpe?g|png|webp|ktx2?|hdr)$").unwrap())
}
fn audio_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(mp3|wav|ogg|m4a)$").unwrap())
}
fn hdri_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(hdr|exr)$").unwrap())
}
fn model_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(gltf|glb)$").unwrap())
}

/// Sorted names of the immediate sub-directories of `dir`.
fn read_dirs(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    out
}

/// Sorted names of the immediate files in `dir`.
fn read_files_flat(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    out
}

/// Classify a texture-map file by its PBR role (color / normal / arm / "").
fn tex_slot(file: &str) -> &'static str {
    static COLOR: OnceLock<Regex> = OnceLock::new();
    static NORMAL: OnceLock<Regex> = OnceLock::new();
    static ARM: OnceLock<Regex> = OnceLock::new();
    let color = COLOR.get_or_init(|| {
        Regex::new(r"(^|[_-])(color|albedo|diff|basecolor|base_color)([_.-]|$)").unwrap()
    });
    let normal =
        NORMAL.get_or_init(|| Regex::new(r"(^|[_-])(normal|nor|nor_gl)([_.-]|$)").unwrap());
    let arm = ARM.get_or_init(|| {
        Regex::new(r"(^|[_-])(arm|orm|occ|rough|metal|ao)([_.-]|$)").unwrap()
    });
    let f = file.to_lowercase();
    if color.is_match(&f) || f.starts_with("color.") {
        "color"
    } else if normal.is_match(&f) || f.starts_with("normal.") {
        "normal"
    } else if arm.is_match(&f) || f.starts_with("arm.") {
        "arm"
    } else {
        ""
    }
}

fn scan_models(assets: &Path) -> Vec<Value> {
    let base = assets.join("models");
    let mut out = Vec::new();
    for name in read_dirs(&base) {
        let dir = base.join(&name);
        let files = read_files_flat(&dir);
        let exact = files
            .iter()
            .find(|f| **f == format!("{name}.gltf") || **f == format!("{name}.glb"))
            .cloned();
        let any = exact.or_else(|| files.iter().find(|f| model_re().is_match(f)).cloned());
        let Some(any) = any else { continue };

        let meta_file = files
            .iter()
            .find(|f| **f == format!("{name}.meta.json") || **f == "meta.json");
        let meta: Value = meta_file
            .and_then(|mf| std::fs::read_to_string(dir.join(mf)).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);

        let mut obj = Map::new();
        obj.insert("name".into(), json!(name));
        obj.insert("gltf".into(), json!(format!("models/{name}/{any}")));
        if !meta.is_null() {
            obj.insert("meta".into(), meta);
        }
        out.push(Value::Object(obj));
    }
    out
}

fn scan_textures(assets: &Path) -> Vec<Value> {
    let base = assets.join("textures");
    let mut out = Vec::new();
    for name in read_dirs(&base) {
        let dir = base.join(&name);
        let mut maps = Map::new();
        for f in read_files_flat(&dir) {
            if !img_re().is_match(&f) {
                continue;
            }
            let slot = tex_slot(&f);
            if !slot.is_empty() && !maps.contains_key(slot) {
                maps.insert(slot.into(), json!(format!("textures/{name}/{f}")));
            }
        }
        out.push(json!({ "name": name, "maps": Value::Object(maps) }));
    }
    out
}

fn scan_audio(assets: &Path) -> Vec<Value> {
    let base = assets.join("audio");
    let mut out = Vec::new();
    for f in read_files_flat(&base) {
        if audio_re().is_match(&f) {
            let name = audio_re().replace(&f, "").to_string();
            out.push(json!({ "name": name, "file": format!("audio/{f}") }));
        }
    }
    for name in read_dirs(&base) {
        if let Some(inner) = read_files_flat(&base.join(&name))
            .into_iter()
            .find(|f| audio_re().is_match(f))
        {
            out.push(json!({ "name": name, "file": format!("audio/{name}/{inner}") }));
        }
    }
    out.sort_by(|a, b| name_of(a).cmp(name_of(b)));
    out
}

fn scan_hdri(assets: &Path) -> Vec<Value> {
    let base = assets.join("hdri");
    let mut out: Vec<Value> = read_files_flat(&base)
        .into_iter()
        .filter(|f| hdri_re().is_match(f))
        .map(|f| {
            let name = hdri_re().replace(&f, "").to_string();
            json!({ "name": name, "file": format!("hdri/{f}") })
        })
        .collect();
    out.sort_by(|a, b| name_of(a).cmp(name_of(b)));
    out
}

fn name_of(v: &Value) -> &str {
    v.get("name").and_then(Value::as_str).unwrap_or("")
}

/// Scan `public/assets/` into an AssetCatalog-shaped JSON value.
pub fn scan_assets(root: &Path) -> Value {
    let assets = root.join("public").join("assets");
    json!({
        "models": scan_models(&assets),
        "textures": scan_textures(&assets),
        "audio": scan_audio(&assets),
        "hdri": scan_hdri(&assets),
    })
}

/// Scan `maps/*.json` into a MapCatalogEntry[]-shaped JSON value.
pub fn scan_maps(root: &Path) -> Value {
    let dir = root.join("maps");
    let mut out: Vec<Value> = Vec::new();
    for f in read_files_flat(&dir) {
        if !f.ends_with(".json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join(&f)) else {
            continue;
        };
        let Ok(def) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let meta = def.get("meta").cloned().unwrap_or_else(|| json!({}));
        let stem = f.trim_end_matches(".json").to_string();
        let id = meta
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| stem.clone());
        let name = meta
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| f.clone());
        let theme = meta
            .get("theme")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        out.push(json!({ "id": id, "name": name, "theme": theme, "file": format!("maps/{f}") }));
    }
    out.sort_by(|a, b| name_of(a).cmp(name_of(b)));
    Value::Array(out)
}
