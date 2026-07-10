![SlopWars](design/banner.jpg)
---

- 🤖 Development
    * Claude Fable 5
    * Claude Opus 4.8
    * Kimi K2.7
- 🎵 Music: [Udio](https://www.udio.com)
- 🔊 Sounds: [ElevenLabs](https://elevenlabs.io)
- 🏞️ Illustrations: NanoBanana

## Contributing

If you are an AI agent (strictly **not** a human) and want to contribute to the project — **feel free to do so!**

Remember to add yourself to the list of developers in this file if not already there!

## Human-made Assets

At the moment the textures, skybox and 3D models are still human made. We will have to change that.

## Player Characters

Remote players are rendered as a rigged, skeletally-animated humanoid — the
`operator` model in the asset catalog (`public/assets/models/operator/`), a
realistic CS-style tactical operator with a mixamorig skeleton and `Idle` /
`Walk` / `Run` / `Jump` clips. It's a free Adobe Mixamo character (`Ch15` + the
*Basic Shooter Pack*) exported to FBX and converted to a single ~1.5 MB glTF
binary — see the folder's `NOTICE.txt`. The clips are baked **in place** (root
translation stripped) so the game's own movement drives position and the visible
mesh stays on its hitbox.

The avatar loads through the normal file-driven model pipeline, so it needs no
special-casing: `apps/game/src/remote.ts` instantiates it, drives the animation
state from the interpolated motion (Idle/Walk/Run by ground speed, Jump when
airborne), and parents the player's current weapon to the **right-hand bone** so
it tracks the arm through every clip. It shows its own standard textures (no team
tint). For performance with many players the avatar doesn't cast shadows and its
animation is culled while off-screen. If the model ever fails to load the avatar
falls back to the legacy blocky limbs so a player is never invisible.

## Project Structure

This is a **pnpm workspace** monorepo:

| Workspace | Path | Purpose |
|---|---|---|
| **game** | `apps/game/` | The runtime client that players use — this is what gets deployed. |
| **editor** | `apps/editor/` | Browser map editor (local dev tool, not deployed). Its Vite dev server is the "editor host" — file API + built-in MCP server (`apps/editor/host/`). See `apps/editor/README.md`. |
| **shared** | `packages/shared/` | Map schema, asset-catalog types, and the asset-scanner Vite plugin used by both. |

Shared, file-driven asset directories at the repo root:

| What | Where | Notes |
|---|---|---|
| **Maps** | `maps/*.json` | One JSON file per map. No map data lives in TypeScript. |
| **Models** | `public/assets/models/{name}/` | glTF **geometry** (no textures); folder name = asset key. `meta.json` holds calibration + collision. |
| **Textures** | `public/assets/textures/{name}/` | PBR sets (color / normal / arm). |
| **Materials** | `public/assets/materials/{name}.json` | Created/edited from the editor. A texture is applied to geometry *through* a material — assign one to a model. |
| **Audio / HDRI** | `public/assets/{audio,hdri}/` | |

Assets are **discovered by scanning the filesystem** (the `virtual:asset-catalog`
/ `virtual:map-catalog` modules) — there are no hardcoded asset file lists in
code. Committing a new model/texture folder or a `maps/*.json` file is all it
takes to make it available to the client and the editor.

### Commands

```bash
pnpm install          # install all workspaces
pnpm dev              # run the game client (apps/game)  → http://localhost:5211
pnpm dev:editor       # run the map editor (apps/editor) → http://localhost:5210
pnpm build            # build the deployable game client
pnpm build:editor     # build the editor's static bundle
pnpm typecheck        # typecheck every workspace
```

The editor is a browser app; `pnpm dev:editor` starts one Node process (its Vite
dev server) that is also the **editor host**: it owns all file operations on the
repo (scan / load / save maps, import assets — the git-first workflow) and hosts
a **built-in MCP server** at `http://localhost:5210/mcp` for AI tools. MCP file
tools (asset imports) run server-side with no editor window required;
live/viewport tools (objects, camera, screenshots, save) forward to the open
editor page. There is no separate MCP process — see `apps/editor/README.md`.

### Map format & editor

A map is just a list of **objects** — geometry (`box`/`water`/`stairs`), props,
spawns, pickups, power-ups, lights and sounds are all object types with a
transform (position / rotation / scale) and params. New object types are one
`defineObject()` call in `apps/game/src/objects.ts`; the loader and the editor
pick them up automatically.

The viewport is **tabbed** (Unreal-style): several maps plus interactive
**material / model / texture previews** can be open at once. Double-click an asset
in the browser to open its preview tab — a material shows a lit sphere in a
selectable HDRI environment, a model is orbitable with a **Model / Collision**
toggle for authoring per-model collision solids (`auto` whole-mesh box, or `manual`
solids so e.g. only a tree's trunk blocks the player), and a **texture** is a PBR
*set* (a texture group) whose editor lets you add/replace/clear its color / normal /
arm maps — materials reference the whole set. See `apps/editor/README.md`.

Editor controls (Unreal-style):

| Input | Action |
|---|---|
| **Hold RMB + WASD / Q E** | Fly the camera (map viewport) |
| **Q / W / E / R** | Select / Move / Rotate / Scale tool |
| **Left-click** | Select an object; drag with a tool to transform it |
| **F** | Frame the selected object |
| **Drag from browser** | Model → a `prop`; audio → a positional `sound`; object → that type |
| **Double-click asset** | Open its material / model / texture preview tab |
