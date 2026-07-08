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
| `editor_import_model` | glTF geometry (`.glb`, or `.gltf`+`.bin`) → `public/assets/models/<name>/` |
| `editor_import_audio` / `editor_import_hdri` | → `public/assets/audio` / `hdri` |
| `editor_list_materials` / `editor_get_material` | inspect materials (name + full def) |
| `editor_create_material` | create a material (`standard`/`water`/`glass`) |
| `editor_update_material` / `editor_rename_material` / `editor_delete_material` | edit materials in place |
| `editor_get_model_meta` / `editor_set_model_meta` | model calibration + **collision** (base/scale/material/mode/solids) |
| `editor_delete_model` / `editor_delete_texture` | remove an asset folder |
| `editor_list_tabs` / `editor_open_tab` / `editor_focus_tab` / `editor_close_tab` | drive the viewport tabs (map / material / model / texture) |
| `editor_set_model_view` | a model tab's sub-view: `model` or `collision` |
| `editor_camera_focus` / `editor_camera_set` / `editor_camera_move` | drive the viewport camera |
| `editor_screenshot` | PNG of the current viewport |
| `editor_save_map` / `editor_load_map` / `editor_new_map` | map management |

Import tools take **local file paths**; the host reads them. Material / model-meta
edits (create/update/collision) run **server-side** (no editor window required);
tab / camera / object edits are **live** (they need the open page). All geometry
edits are undoable in the editor (Ctrl+Z) and saved with `editor_save_map`.

## Viewport tabs

The centre viewport is **tabbed** — one tab per open document:

- **map** — a map being edited (scene outliner on the left, object inspector on the
  right). Several maps can be open at once; New / double-clicking a map in the
  browser opens (or focuses) a tab.
- **material** — an interactive lit **sphere** shaded by the material, inside a
  selectable **HDRI environment** (the left panel picks it). Drag to orbit, scroll
  to zoom. The inspector holds the material's controls.
- **model** — the model itself, orbitable, with a **Model / Collision** toggle.
  Collision view dims the mesh and shows the model's authored collision solids.
- **texture** — a lit sphere textured with the raw PBR set.

**Double-click** any asset in the bottom browser to open its tab (single-click no
longer drives the inspector). Selecting an object in the outliner brings its map
tab back into view.

### Materials, textures & models

A **texture is never applied to a model directly** — you import textures, build a
**material** from them, then assign that material to the model (in the model tab's
inspector). Importing a model brings in **geometry only** (no textures), keeping
the material system generic.

### Collision (per model)

Each model has a collision **mode** (`models/<name>/meta.json`):

- **auto** — one AABB hugs the whole mesh (classic).
- **manual** — only the **solids you author** block the player. Switch a model tab
  to *Collision*, add solids, and position/size them — so e.g. only a tree's trunk
  collides, not its canopy.

## Editor controls (Unreal-style)

| Input | Action |
|---|---|
| **Hold RMB + WASD / Q E** | Fly the camera (map viewport) |
| **W / E / R** | Move / Rotate / Scale tool |
| **Left-click** | Select an object; drag with a tool to transform it |
| **F** | Frame the selected object |
| **Drag from browser** | Model → a `prop`; audio → a positional `sound`; object → that type |
| **Double-click asset** | Open its material / model / texture preview tab |
| **Drag (preview tab)** | Orbit the camera; scroll to zoom |
