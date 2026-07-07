# SlopWars Map Editor

A browser-based map editor for SlopWars, and a local dev tool: it reads and
writes the project's `maps/*.json` and `public/assets/` **directly in the git
working tree** (the git-first workflow — you edit, commit, and the client picks
it up on the next scan).

```bash
pnpm dev:editor      # → http://localhost:5173
```

## Architecture

One process. `pnpm dev:editor` runs the editor's Vite dev server, which is also
the **editor host** (`host/`):

| Concern | Where |
|---|---|
| UI, 3D viewport, gizmos, inspector, asset browser | `src/` (browser) |
| File operations on the repo (scan / load / save maps, import assets) | `host/files.ts` |
| Live-op bridge to the open page (long-poll) | `host/bridge.ts` + `src/mcpbridge.ts` |
| MCP server (tool defs + JSON-RPC) | `host/mcp.ts` |
| Wiring it all into the dev server | `host/plugin.ts` |

The **browser owns the live editing session** (the in-memory map, undo/redo,
camera); the **host owns the files**. MCP tools are routed accordingly.

## MCP server (built in)

The editor host exposes a Model Context Protocol server over **Streamable HTTP**
at `http://localhost:5173/mcp`, so AI tools (Claude Code, Codex, …) can drive the
editor. There is no separate process to run — just start the editor.

- **File tools** (`editor_import_texture` / `_model` / `_audio` / `_hdri`) run
  server-side against the repo and work with **no editor window open**.
- **Live tools** (objects, camera, screenshots, `editor_save_map` / `_load_map` /
  `_new_map`, listings) forward to the **open editor page** — open
  `http://localhost:5173` in a browser for these. If no page is connected they
  return a clear "editor window not open" error.

Point your tool at the URL:

**Claude Code** (`.mcp.json` or `claude mcp add --transport http …`):

```json
{
  "mcpServers": {
    "slopwars-editor": { "type": "http", "url": "http://localhost:5173/mcp" }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.slopwars-editor]
url = "http://localhost:5173/mcp"
```

When a live command arrives, the editor page shows an "MCP connected" toast.

### Tools

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

Import tools take **local file paths**; the host reads them. All geometry edits
are undoable in the editor (Ctrl+Z) and saved with `editor_save_map`.

## Editor controls (Unreal-style)

| Input | Action |
|---|---|
| **Hold RMB + WASD / Q E** | Fly the camera (mouse to look) |
| **W / E / R** | Move / Rotate / Scale tool |
| **Left-click** | Select an object; drag with a tool to transform it |
| **F** | Frame the selected object |
| **Drag from browser** | Model → a `prop`; audio → a positional `sound`; object → that type |
