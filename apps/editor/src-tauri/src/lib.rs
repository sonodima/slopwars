// ─── SlopWars Editor — Tauri backend ─────────────────────────────────────────
// Wires up the editor's file-operation commands and the MCP bridge, then runs the
// desktop window that hosts the (Vite-built) editor frontend.
mod catalog;
mod commands;
mod mcp;
mod root;

use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = root::AppState {
        root: root::find_root(),
    };
    eprintln!("[slopwars-editor] repo root: {}", state.root.display());

    let bridge = Arc::new(mcp::Bridge::new());
    let http_bridge = bridge.clone();

    tauri::Builder::default()
        .manage(state)
        .manage(bridge)
        .setup(move |_app| {
            mcp::start_http(http_bridge.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_assets,
            commands::scan_maps,
            commands::load_map,
            commands::save_map,
            commands::import_asset,
            mcp::mcp_poll,
            mcp::mcp_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SlopWars editor");
}
