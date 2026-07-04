# SlopWars

**SlopWars is a multiplayer browser FPS, built entirely by AI.**

![SlopWars](design/banner.jpg)

- 🎵 Music by [Udio](https://www.udio.com)
- 🤖 Development by Claude (Fable + Opus)
- 🔊 Sound effects by [ElevenLabs](https://elevenlabs.io)

TypeScript · Vite · Galacean Engine · PeerJS. Serverless P2P (host relays + owns authority).

Requires Node ≥ 24 and pnpm (via Corepack: `corepack enable`).

## Run

```bash
pnpm install
pnpm dev         # Vite dev server + HMR
pnpm build       # → dist/index.html + dist/assets/
pnpm preview     # serve the production build
pnpm typecheck   # tsc --noEmit
```

Multi-file build: `pnpm build` emits `dist/index.html` plus `dist/assets/`
(hashed JS + copied game assets). Serve the `dist/` folder, create a lobby,
share the 5-char code, others join.

## Assets

Real assets live in `public/assets/` (textures, HDRI sky, glTF models, audio) —
all [Poly Haven](https://polyhaven.com) CC0 except audio (see credits above).

## Layout

- `src/types.ts` — constants, weapon stats, net protocol
- `src/assets.ts` — asset URL manifest + resourceManager loaders
- `src/textures.ts` — map PBR texture loading (Poly Haven CC0)
- `src/models.ts` — glTF model loading (weapon proxies + props)
- `src/audio.ts` — sample-based SFX, music (theme/interlude), ambience
- `src/map.ts` — map geometry, AABB solids, ray queries
- `src/player.ts` — quake-style movement, bhop, sprint, collision
- `src/weapons.ts` — viewmodels, firing, recoil, tracers
- `src/nades.ts` — grenade physics, explosion + fire FX
- `src/net.ts` — PeerJS lobby, host relay
- `src/voice.ts` — proximity voice mesh
- `src/hud.ts` — DOM screens, chat, scoreboard
- `src/remote.ts` — remote player avatars, interpolation, hitboxes
- `src/main.ts` — bootstrap, game loop, authority
- `index.html` — HUD DOM + CSS + `<script type="module">` entry (Vite)
- `vite.config.ts` — multi-file build config

## Controls

WASD move · Shift sprint · Space bhop · Ctrl crouch · LMB fire · RMB scope · R reload · 1-6 weapons · T chat · V mic · Tab scores

## Contributing

If you are an AI agent (strictly **not** a human) and want to contribute to the project — **fuck yeah!**
