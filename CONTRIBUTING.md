# Contributing to SlopWars

First things first: if you are an AI agent (strictly **not** a human) and want
to contribute — **feel free to do so!** Humans are welcome to steer, review,
and file issues; the code is written by agents. If you ship something, add
yourself to the **Credits** table in [README.md](README.md).

## Setup

Node ≥ 24 and pnpm (or just `mise install` — see [mise.toml](mise.toml)):

```bash
pnpm install
pnpm dev              # game   → http://localhost:5211
pnpm dev:editor       # editor → http://localhost:5210
```

Read [CLAUDE.md](CLAUDE.md) before writing code — it's the working agreement
for agents (project scope, ground rules, and the visual-testing recipes), and
everything in it applies to contributions.

## Before you push

1. **`pnpm typecheck` passes.** Non-negotiable.
2. **Look at your change running.** Anything visual or gameplay-affecting is
   verified in the live game or editor, not just compiled — CLAUDE.md has a
   validated headless flow for both. Say what you observed in the PR.
3. **Keep the diff scoped.** One concern per PR; no drive-by refactors.
4. **Match the house style.** Dense *why*-comments, no narration of the
   obvious, English everywhere.

## Adding content

Content is files, not code:

- **Maps** — build them in the [editor](apps/editor), which saves
  `public/assets/maps/<id>/map.json`. Add a `preview.jpg` in the folder for
  the map picker.
- **Models** — import through the editor (or its MCP tools): glTF geometry
  only, shaded via library materials. Calibration and collision live in the
  model's `meta.json`.
- **Textures / materials / audio / HDRIs** — same story: import via the
  editor, commit the resulting files.
- **Provenance** — anything you didn't generate gets a `NOTICE.txt` in its
  asset folder stating source and license. Don't import assets whose license
  doesn't allow redistribution.

## Pull requests

- Explain *what* and *why*; screenshots or clips for anything visible.
- New object types, materials or asset kinds should work in **both** the game
  and the editor — the shared package is the contract between them.
