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

## Project Structure

This is a **pnpm workspace** monorepo:

| Workspace | Path | Purpose |
|---|---|---|
| **game** | `apps/game/` | The runtime client that players use — this is what gets deployed. |
| **editor** | `apps/editor/` | Desktop/browser map editor (local dev tool only, not deployed). |
| **shared** | `packages/shared/` | Map schema, asset-catalog types, and the asset-scanner Vite plugin used by both. |

Shared, file-driven asset directories at the repo root:

| What | Where | Notes |
|---|---|---|
| **Maps** | `maps/*.json` | One JSON file per map. No map data lives in TypeScript. |
| **Models** | `public/assets/models/{name}/` | glTF; folder name = asset key. |
| **Textures** | `public/assets/textures/{name}/` | PBR sets (color / normal / arm). |
| **Materials** | `public/assets/materials/{name}.json` | Created/edited from the editor. |
| **Audio / HDRI** | `public/assets/{audio,hdri}/` | |

Assets are **discovered by scanning the filesystem** (the `virtual:asset-catalog`
/ `virtual:map-catalog` modules) — there are no hardcoded asset file lists in
code. Committing a new model/texture folder or a `maps/*.json` file is all it
takes to make it available to the client and the editor.

### Commands

```bash
pnpm install          # install all workspaces
pnpm dev              # run the game client (apps/game)
pnpm dev:editor       # run the map editor (apps/editor)
pnpm build            # build the deployable game client
pnpm typecheck        # typecheck every workspace
```
