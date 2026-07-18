# CLAUDE.md

SlopWars — a multiplayer browser FPS written by AI agents, with humans only
steering. Serverless P2P (PeerJS, host-authoritative), Galacean engine,
PhysX wasm, Vite + TypeScript, pnpm workspaces.

## Scope

- `apps/game` is the product and the **only deployable** (GitHub Pages, on
  push to `main`). `apps/editor` is a local dev tool — never deployed, so its
  code can be liberal with dev-only dependencies and Node APIs (in `host/`).
- `apps/desktop` is a thin Electron shell around the built game (packaged
  locally on demand, never in CI). It serves `apps/game/dist` over a custom
  `app://` protocol — never `file://`, which would silently break the PhysX
  wasm fetch — and must stay a zero-IPC wrapper: no preload, no game logic.
- `packages/shared` holds the map schema, asset-catalog types and the
  filesystem asset scanner used by both apps. Game and editor must agree
  through `shared`, never by duplicating logic.

## Ground rules

- **Everything is file-driven.** Assets and maps live under `public/assets/`
  and are discovered by scanning (`virtual:asset-catalog` /
  `virtual:map-catalog`). Never hardcode an asset list in code; adding
  content = adding files.
- **Models are geometry-only.** Surfaces are shaded by library materials
  (`public/assets/materials/*.json`) resolved through `meta.json` slot
  assignments. Don't reintroduce textures into model glTFs.
- **A map is a folder** — `public/assets/maps/<id>/map.json`, objects-only
  format. New object types are one `defineObject()` in
  `apps/game/src/objects.ts`; loader and editor pick them up automatically.
- **Current format only — no migration shims.** When a data format changes,
  migrate the committed JSON in the same commit and keep the loaders free of
  legacy fallbacks. One-shot migration scripts don't get to live in the repo
  after their job is done.
- **Comments explain *why*.** The codebase carries dense header comments
  documenting intent and hard-won gotchas ("learned the hard way" notes).
  Match that style; don't narrate what the code already says.
- Code, comments and docs are in **English**. READMEs stay high-level —
  philosophy and structure; deep detail belongs in code comments.

## How I like work done

- **Verify before claiming done.** Anything visual or gameplay-affecting gets
  looked at in the running game/editor, not just typechecked (see below).
  Report what you actually observed.
- Keep diffs scoped to the task — no drive-by refactors.
- Challenge my proposals: name concrete risks and offer alternatives when you
  see better options.
- `pnpm typecheck` must pass before every commit.

## Commands

```bash
pnpm dev              # game   → http://localhost:5211
pnpm dev:editor       # editor → http://localhost:5210 (+ MCP at /mcp)
pnpm dev:desktop      # Electron shell against the game dev server (run pnpm dev first)
pnpm build            # deployable game bundle
pnpm build:desktop    # game bundle + packaged Electron app (apps/desktop/release)
pnpm typecheck        # all workspaces
```

Node ≥ 24 (mise.toml). PhysX wasm is vendored automatically at dev/build time
(`scripts/vendor-physx.mjs`; `public/physx/` is gitignored). The service
worker cache-busts itself per build — nothing to bump manually.

## Visual testing

**Game** — works headless with Playwright + system Chromium (SwiftShader):

```js
chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--no-sandbox", "--mute-audio"] })
```

Flow to reach live gameplay (validated): wait for `#scr-menu:not(.hidden)` →
fill `#inp-name` → click `#btn-create` → on `#scr-lobby` set the bots count
(first `input[type=range]` in `#lobby-rules`, dispatch `input`) → click
`#btn-start` → wait `#scr-game:not(.hidden)` → press `1`–`6` to pick a class
→ click the canvas for pointer lock (then `mouse.move` steers the view). With
no network the game shows an OFFLINE badge and runs a bots-only match — that's
fine for testing. Hide `#click-to-play, #stats, #perf-graph` via CSS for clean
screenshots. Expect ~10–20 fps under SwiftShader; that's the renderer, not a
regression.

**Editor** — start `pnpm dev:editor`, open `http://localhost:5210`, and drive
it through the built-in MCP server (`.mcp.json` is already configured):
`editor_load_map` / `editor_add_object` / `editor_camera_*` /
`editor_screenshot` give you a full place-look-verify loop. File tools
(imports, materials, model meta) work with no editor window open; live tools
need the page.

## Repo conventions

- Maps/materials are saved by the editor as pretty JSON + trailing newline —
  keep hand edits in the same shape.
- Third-party asset provenance is documented in a `NOTICE.txt` inside the
  asset's folder (see `public/assets/models/operator/`). Add one when
  importing anything you didn't generate.
- AI contributors add themselves to the Credits table in `README.md` (see
  `CONTRIBUTING.md`).
