# SlopWars Map Editor

A browser-based level editor for [SlopWars](../../README.md) — Unreal-style
viewport, git-first storage, and a built-in MCP server so AI agents can drive
it like a human would.

![Editor](../../design/screenshots/editor.png)

```bash
pnpm dev:editor      # → http://localhost:5210
```

## Philosophy

- **Git-first.** The editor reads and writes the project's working tree
  directly: maps under `public/assets/maps/`, materials, models and textures
  under their own asset folders. Saving is writing pretty JSON; shipping is
  committing. There is no database and no export step — the game picks the
  files up on its next scan.
- **One process, two owners.** `pnpm dev:editor` starts a single Vite dev
  server that is also the *editor host*: the **browser** owns the live editing
  session (the in-memory map, selection, undo/redo, camera), the **host** owns
  every file operation. Nothing else to run.
- **Agent-native.** The host exposes an MCP server, so everything below — from
  placing objects to taking viewport screenshots — is scriptable by AI tools.

## Features

### Viewport

- **Tabbed, Unreal-style.** Several maps plus interactive **material / model /
  texture** preview tabs open side by side — double-click any asset in the
  browser dock to open its tab. Fly camera, move/rotate/scale gizmos with
  rotation snapping, multi-select, copy/paste, grouping, and full undo/redo.
- **First-class groups.** Objects group into transformable parents (move,
  rotate and scale a whole structure as a unit, nested arbitrarily); a group
  flagged *dynamic body* becomes a single PhysX rigid body in-game — mesh,
  light and all.
- **Preview environments.** Material and model tabs render inside a selectable
  HDRI environment; a graphics-quality switch previews maps at any tier.

### World authoring

- A map's whole **environment** is edited in the inspector: HDRI or
  solid-color sky, sun direction / color / brightness, ambient light and
  reflections, shadow quality, distance fog — plus the map meta (name, theme,
  rotation flag) that drives the in-game map pool.
- Every placeable comes from the game's `defineObject()` registry — geometry,
  spawns, pickups, power-ups, lights, sounds, particles. New object types
  defined in the game show up in the editor automatically, their params
  rendered as inspector fields.
- **Drag & drop placement** — drag a model in for a prop, an audio file for a
  positional sound, an object type for anything else.

### Asset pipeline

- **Asset browser.** Objects · Models · Materials · Textures · Skyboxes ·
  Audio · Maps, searchable, with live-rendered thumbnails; audio cards carry a
  scrubbable waveform preview.
- **Materials-first.** A texture is never applied to a model directly: import
  texture sets, build **materials** (standard / water / glass) from them,
  assign those to a model's surface slots. Imported models are stripped to
  pure geometry and wired to auto-created library materials, so they render
  the moment they land.
- **Model calibration.** Per-model base offset / rotation / scale, per-surface
  material slots, and **collision authoring**: `auto` (one box hugging the
  mesh) or `manual` — place the solids yourself so only a tree's trunk blocks
  the player, not its canopy. Named **anchors** (e.g. a weapon's `muzzle`) and
  a Prop-Hunt disguise opt-in round out the metadata.
- **Texture sets** are PBR groups (color / normal / arm) assembled in the
  texture tab; materials reference the whole set.
- **Maps are folders** — saved as pretty JSON to `public/assets/maps/<id>/`;
  drop screenshot images next to `map.json` and the in-game map picker grows
  a gallery.

## MCP server

The host serves Model Context Protocol over Streamable HTTP at
`http://localhost:5210/mcp` — no separate process. The repo's
[`.mcp.json`](../../.mcp.json) already wires it up for Claude Code:

```json
{
  "mcpServers": {
    "slopwars-editor": { "type": "http", "url": "http://localhost:5210/mcp" }
  }
}
```

Tools come in two flavors:

- **File tools** — importing models / textures / audio / HDRIs, creating and
  editing materials, model calibration + collision meta. These run
  server-side against the repo and need **no editor window open**.
- **Live tools** — placing and editing objects, camera moves, viewport
  screenshots, saving / loading maps, driving tabs. These forward to the open
  editor page (you'll see an "MCP connected" toast).

Every geometry edit an agent makes is undoable in the editor with Ctrl+Z.
