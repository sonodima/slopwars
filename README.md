# CSBOH — web FPS

TypeScript · Vite · Galacean Engine · PeerJS. Serverless P2P (host relays + owns authority).

Requires Node ≥ 24 and pnpm (via Corepack: `corepack enable`).

## Run

```bash
pnpm install
pnpm dev         # Vite dev server + HMR
pnpm build       # → single inlined dist/index.html
pnpm preview     # serve the production build
pnpm typecheck   # tsc --noEmit
```

`pnpm build` inlines all JS/CSS into one self-contained `dist/index.html`
(via `vite-plugin-singlefile`) — the shareable serverless build. Open it,
create a lobby, share the 5-char code, others join.

## Layout

- `src/types.ts` — constants, weapon stats, net protocol
- `src/textures.ts` — procedural canvas textures
- `src/audio.ts` — WebAudio synth SFX
- `src/map.ts` — Kasbah map geometry, AABB solids, ray queries
- `src/player.ts` — quake-style movement, bhop, collision
- `src/weapons.ts` — viewmodels, firing, recoil, tracers
- `src/nades.ts` — grenade physics, explosion + fire FX
- `src/net.ts` — PeerJS lobby, host relay
- `src/voice.ts` — proximity voice mesh
- `src/hud.ts` — DOM screens, chat, scoreboard
- `src/remote.ts` — remote player avatars, interpolation, hitboxes
- `src/main.ts` — bootstrap, game loop, authority
- `index.html` — HUD DOM + CSS + `<script type="module">` entry (Vite)
- `vite.config.ts` — single-file inline build config

## Controls

WASD move · Space bhop · Ctrl crouch · LMB fire · RMB scope · R reload · 1-6 weapons · T chat · V mic · Tab scores
