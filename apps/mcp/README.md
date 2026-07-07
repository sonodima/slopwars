# SlopWars Editor — MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
tools (Claude Code, Codex, …) **drive the SlopWars map editor** while it's open:
list / add / move / rotate / scale / delete objects, edit params, import
textures / models / audio / HDRIs, move + rotate the viewport camera, and take
screenshots.

It's dependency-free (JSON-RPC 2.0 over stdio, plain Node ≥18) and talks to the
editor app's **built-in MCP bridge** (a small HTTP endpoint in the Tauri Rust
backend), so the running editor window executes every action live and writes
changes into the repo (the same git-first flow as the rest of the editor). No
separate dev server is required.

## Usage

1. Launch the editor **desktop app** (its window executes the commands):

   ```bash
   pnpm dev:editor          # Tauri app; bridge listens on http://127.0.0.1:5174
   ```

2. Point your AI tool at the server. It connects to `http://127.0.0.1:5174` by
   default — override with `SLOPWARS_BRIDGE_URL` (`SLOPWARS_EDITOR_URL` is still
   accepted). The bridge port can be changed with `SLOPWARS_BRIDGE_PORT` on the
   editor app.

   **Claude Code** (`.mcp.json` or `claude mcp add`):

   ```json
   {
     "mcpServers": {
       "slopwars-editor": {
         "command": "node",
         "args": ["apps/mcp/server.mjs"],
         "env": { "SLOPWARS_BRIDGE_URL": "http://127.0.0.1:5174" }
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.slopwars-editor]
   command = "node"
   args = ["apps/mcp/server.mjs"]
   ```

When a command arrives, the editor window shows an "MCP connected" toast.

## Tools

| Tool | What it does |
|---|---|
| `editor_get_state` | current map, object count, camera pose |
| `editor_list_objects` / `editor_get_object` | inspect placed objects (index-tagged) |
| `editor_list_object_types` | placeable types + default params |
| `editor_list_assets` | available models / textures / audio / HDRIs |
| `editor_get_map` | the full MapDef |
| `editor_add_object` | place any object type at `[x,y,z]` |
| `editor_place_model` / `editor_place_sound` | shortcuts for a model prop / positional sound |
| `editor_update_object` / `editor_move_object` | edit transform / name / group / params |
| `editor_delete_object` / `editor_duplicate_object` / `editor_select_object` | |
| `editor_import_texture` | PBR set (color/normal/arm) → `public/assets/textures/<name>/` |
| `editor_import_model` | glTF (+ .bin/textures) → `public/assets/models/<name>/` |
| `editor_import_audio` / `editor_import_hdri` | → `public/assets/audio` / `hdri` |
| `editor_camera_focus` / `editor_camera_set` / `editor_camera_move` | drive the viewport camera |
| `editor_screenshot` | PNG of the current viewport |
| `editor_save_map` / `editor_load_map` / `editor_new_map` | map management |

Import tools take **local file paths**; the server reads and uploads them. All
geometry edits are undoable in the editor (Ctrl+Z) and saved with
`editor_save_map`.
