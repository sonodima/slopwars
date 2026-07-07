// ─── Repo-root resolution ────────────────────────────────────────────────────
// The editor reads/writes the project's `maps/` and `public/assets/` directories,
// so the backend needs to know where the repo root is. We resolve it once at
// startup: an explicit `SLOPWARS_ROOT` override wins, otherwise we walk up from
// the working directory and the executable location looking for the workspace
// marker (`pnpm-workspace.yaml`). This makes `tauri dev` (cwd = apps/editor) and a
// packaged binary both land on the same root.
use std::path::{Path, PathBuf};

/// Shared application state: the resolved repo root.
pub struct AppState {
    pub root: PathBuf,
}

const MARKER: &str = "pnpm-workspace.yaml";

fn walk_up_for_marker(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(MARKER).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Resolve the repo root, falling back to the current directory.
pub fn find_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("SLOPWARS_ROOT") {
        let p = PathBuf::from(explicit);
        if p.is_dir() {
            return p;
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = walk_up_for_marker(&cwd) {
            return root;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = walk_up_for_marker(&exe) {
            return root;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
