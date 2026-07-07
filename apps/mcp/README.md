# SlopWars Editor — MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
tools (Claude Code, Codex, …) **drive the SlopWars map editor** while it's open:
list / add / move / rotate / scale / delete objects, edit params, import
textures / models / audio / HDRIs, move + rotate the viewport camera, and take
screenshots.

It's dependency-free (JSON-RPC 2.0 over stdio, plain Node ≥18) and talks to the
editor's dev-server bridge, so the running editor page executes every action live
and writes changes into the repo (the same git-first flow as the rest of the
editor).

## Usage

1. Start the editor and **open it in a browser** (the page executes the commands):

   ```bash
   pnpm dev:editor          # → http://localhost:5173
   ```

2. Point your AI tool at the server. It connects to `http://localhost:5173` by
   default — override with `SLOPWARS_EDITOR_URL`.

   **Claude Code** (`.mcp.json` or `claude mcp add`):

   ```json
   {
     "mcpServers": {
       "slopwars-editor": {
         "command": "node",
         "args": ["apps/mcp/server.mjs"],
         "env": { "SLOPWARS_EDITOR_URL": "http://localhost:5173" }
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

When a command arrives, the editor shows an "MCP connected" toast.

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
