## 1. Map Editor & Asset Pipeline

> **Status:** Shipped. pnpm workspaces (`apps/game`, `apps/editor`,
> `packages/shared`), the file-driven asset scanner, JSON map format + runtime
> loader, and catalog-driven model/texture registration are in place. The map
> format is fully **object-based** — geometry (box/water/stairs), spawns,
> pickups, power-ups, props, lights and sounds are all object types with a
> transform (position/rotation/scale). The editor has a fly camera (RMB+WASD/QE),
> transform gizmos with Q/W/E/R tool shortcuts, click-select + drag-to-move, a
> unified asset browser (objects/models/audio/textures/materials) with a model
> turntable preview, and drag-drop placement (drag a model → a "prop", drag audio
> → a positional "sound"). Still to come: in-editor binary asset import
> (models/textures/audio are added by committing files today) and per-axis gizmo
> handle picking (current gizmos drag on the ground plane / single axis).

### 1.1 Overview
| Goal | Description |
|---|---|
| **Desktop Map Editor** | GUI application for creating and modifying maps outside the runtime client. |
| **JSON Map Format** | Maps stored as JSON files under `public/assets/maps/`; no map data in TypeScript source. |
| **File-Driven Assets** | All assets (models, textures, audio, materials) live in project directories and are discovered at runtime / edit-time; zero hardcoded asset lists in code. |
| **Git-First Workflow** | Committing maps, materials, and assets to the repository automatically makes them available to the client. |

### 1.2 Workspace Structure
| Workspace | Path | Purpose | Deploy |
|---|---|---|---|
| **game** | `apps/game/` | Runtime client used by players. | **Yes** — this is the deployed client. |
| **editor** | `apps/editor/` | Desktop-based map editor. | No — local development tool only. |
| **shared** | `packages/shared/` | Shared types, map schema, asset scanner, and utilities used by both game and editor. | Bundled into game and editor. |

- Use **pnpm workspaces** with a clean root `pnpm-workspace.yaml`.
- Game is built and deployed as the public client.
- Editor is started locally via a root command (e.g. `pnpm dev:editor`).
- Shared package is never deployed on its own; it is imported by both game and editor.

### 1.3 Directory Conventions
| Asset | Path | Naming Rule | Metadata |
|---|---|---|---|
| **Maps** | `public/assets/maps/{id}/map.json` | Folder per map (or flat `{id}.json`); `preview.*` images = picker screenshots | Inline in JSON |
| **Models** | `public/assets/models/{assetName}/` | Folder name = asset name | Optional `{assetName}.meta.json` inside folder |
| **Textures (PBR)** | `public/assets/textures/{assetName}/` | Folder name = asset name; expected maps: albedo, normal, roughness/metalness/ao | Optional `meta.json` |
| **Materials** | `public/assets/materials/{assetName}.json` or `public/assets/materials/{assetName}/` | File or folder name = material name | Same file or `meta.json` |
| **Audio** | `public/assets/audio/{assetName}/` | Folder name = asset name | Optional `meta.json` |
| **Objects / Entities** | Defined in TypeScript code | Registered by class; expose editor-configurable properties | Properties schema declared in code |

### 1.4 Editor Architecture
| Layer | Responsibility |
|---|---|
| **Viewport** | 3D scene preview, object selection, transform gizmos. |
| **Scene Graph** | Hierarchical list of placed objects in the current map. |
| **Inspector** | Edit selected object properties (position, rotation, scale, custom entity properties). |
| **Asset Panels** | Bottom dock with tabs/panels for Materials, Models, Textures, Audio, and Objects. |
| **Previewer** | Models: drag-to-rotate preview; Materials: sphere/cube preview with PBR maps. |

### 1.5 Editor Features
| Feature | Specification |
|---|---|
| **Map Management** | Load any map under `public/assets/maps/`, edit in-place, save, or create new maps written back to that folder. |
| **Asset Import** | Import models, PBR texture sets, audio files; editor creates the correct folder structure and metadata. |
| **Material Editor** | Create, edit, delete materials; assign PBR texture sets; live preview. |
| **Model Browser** | List available models, drag-to-rotate preview, place into map. |
| **Object Library** | Code-defined objects/entities with configurable properties exposed to the editor. |
| **Property Inspector** | Generic UI generated from each object's declared property schema. |

### 1.6 Runtime / Client Loading
| Step | Behavior |
|---|---|
| **Asset Discovery** | Client/editor scans asset directories to build an in-memory catalog (folder name → asset entry). |
| **Map Load** | Before loading a map, client resolves all referenced asset names, fetches the relevant folders/files, and then instantiates the map. |
| **No Hardcoded Assets** | Game code never contains asset file names; it only references asset keys that match directory names. |
| **PBR Textures** | Texture folders are expected to contain the three PBR maps already in use; missing maps fall back to defaults. |

### 1.7 Object / Entity Model
| Concept | Description |
|---|---|
| **Model** | Pure geometry file(s) in `assets/models/`. |
| **Texture** | Pure image data in `assets/textures/`. |
| **Material** | Reusable shading configuration referencing texture sets. |
| **Object / Entity** | TypeScript class that combines a model, material, audio, collision, and gameplay behavior; exposes editor-configurable properties. |
| **Property Schema** | Each entity class declares which fields the editor can inspect and serialize into the map JSON. |

### 1.8 Implementation Layers
1. **Workspace Setup** — Configure pnpm workspaces (`game/`, `editor/`, `shared/`) and root dev/deploy scripts.
2. **Convention & Folder Structure** — Finalize directory layout and JSON map schema.
3. **Asset Scanner** — Build a service that scans models, textures, materials, and audio folders and returns a catalog.
4. **JSON Map Loader / Saver** — Replace hardcoded map data with load/save utilities.
5. **Editor Shell** — Basic window, viewport, scene graph, inspector layout.
6. **Material Panel** — Material CRUD + PBR texture assignment + preview.
7. **Model Panel** — Model list + drag-to-rotate preview + placement.
8. **Object Panel & Inspector** — Register code-defined entities, generate property UI, serialize properties.
9. **Texture & Audio Import** — Import workflows for PBR texture sets and audio clips.
10. **Runtime Integration** — Client uses asset scanner + JSON loader to fetch and instantiate maps.
11. **Workflow Validation** — End-to-end test: create map in editor, commit, client loads it correctly.

---

## 2. Portal System

### 2.1 Core Mechanics
| Feature | Specification |
|---|---|
| **Spawning** | Player can spawn two linked portals (entry / exit) |
| **Traversal** | Player can enter a portal to teleport to the linked portal's location |
| **Projectile Routing** | Bullets and throwables pass through portals, maintaining trajectory and velocity |
| **Ownership** | Portals are **player-bound**; only the creator can use them |
| **Duration** | 45 seconds before automatic despawn |

### 2.2 Design Notes
- Portals must visually and audibly indicate their remaining lifespan.
- Projectile physics must seamlessly translate across portal boundaries without collision artifacts.

---

## 3. Weapons

### 3.1 Visuals
- **Current State:** Placeholder models in use.
- **Target:** Replace with finalized, high-quality weapon models.

### 3.2 Audio
- **Reload Sounds:** Unique reload SFX per weapon class.
- **Equip Sounds:** Distinct draw / holster audio cues.

---

## 4. Graphics

### 4.1 Fire Effects
- **Current State:** Visually unrealistic.
- **Target:** High-fidelity flame system comprising:
  - Realistic flame textures (sprite sheets or volumetric).
  - Dynamic particle effects (sparks, smoke, heat distortion).
  - Layered LOD to maintain performance across distances.

---

## 5. Map System

### 5.1 Architecture
- **File Format:** Custom `.map` files.
- **Encapsulation:** Each `.map` file is self-contained and defines:
  - Geometry & collision meshes
  - Textures & materials
  - Skybox
  - Lighting (ambient, directional, point, spot)
  - Spawn points (player & pickup)
  - Vegetation & decorative props
  - Interactive objects

### 5.2 Design Principles
- **Scale:** Compact, arena-style footprints; density over sprawl.
- **Detail:** Rich environmental storytelling via props, structures, and coherent item placement.
- **Differentiation:** Each map must have a unique visual identity and spatial flow.
- **Logic:** Geometry and object placement must feel intentional and believable.

### 5.3 Map Pool

#### 5.3.1 Waterfall
| Attribute | Description |
|---|---|
| **Theme** | Tropical jungle ravine |
| **Layout** | Vertical three-tier structure |
| **Zones** | • **Basin** (lower)&lt;br&gt;• **Mist Line** (mid)&lt;br&gt;• **Cliffside** (upper) |
| **Key Feature** | Waterfall acts as dynamic sound barrier; gunfire is muffled across waterfall faces |

#### 5.3.2 Neon Graveyard
| Attribute | Description |
|---|---|
| **Theme** | Cyberpunk cemetery during a rainy night |
| **Layout** | Mausoleum maze + underground crypts + overhead maglev rail |
| **Skybox** | Rain-soaked night, megastructures, neon reflections on wet surfaces |

#### 5.3.3 Overgrowth
| Attribute | Description |
|---|---|
| **Theme** | Bio-reclaimed corporate office |
| **Layout** | Cubicle farms + conference rooms + CEO vertical garden |
| **Atmosphere** | Nature overtaking sterile corporate architecture |

#### 5.3.4 Koi (the current map that we have at the moment)

### 5.4 Match Flow
| Phase | Behavior |
|---|---|
| **Initial Match** | Map is selected at random from the pool. |
| **Interlude (between rounds)** | Voting interface presented to all players. |
| **Next Map** | Map with the plurality of votes is loaded for the subsequent round. |

---

## 6. Game Modes

### 6.1 Lobby Integration
- **Selection:** Host chooses the game mode from a dropdown / card interface in the pre-game lobby.
- **Persistence:** Selected mode is displayed in the lobby header and server browser.
- **Configuration:** Each mode exposes adjustable parameters (score limit, time limit, etc.) editable by the host before match start.

---

### 6.2 Free for All (FFA)

#### 6.2.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | None — every player is an independent combatant. |
| **Respawn** | Instant respawn at random spawn points across the map. |
| **Friendly Fire** | N/A (no teams). |

#### 6.2.2 Scoring
| Event | Points |
|---|---|
| Kill | +1 |
| Death | 0 (no penalty) |
| Suicide | -1 |

#### 6.2.3 Win Condition
- **Score Limit:** First player to reach the configured kill threshold (default: 20) wins the match.
- **Time Limit:** If no player reaches the score limit, the player with the highest score when the timer expires wins.
- **Tiebreaker:** If tied at time expiry, the match enters **Sudden Death** — next kill wins.

#### 6.2.4 HUD & Feedback
- Real-time scoreboard sorted by kills (descending).
- Personal streak announcement (e.g., "Killing Spree," "Rampage").
- Kill feed with weapon icon.

---

### 6.3 Team Deathmatch (TDM)

#### 6.3.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | Two teams (Alpha / Bravo). |
| **Team Size** | Balanced automatically; max delta = 1 player. |
| **Respawn** | Delayed respawn (3 s) at team-proximate spawn points. |
| **Friendly Fire** | Off by default; host-toggleable. |

#### 6.3.2 Scoring
| Event | Team Points |
|---|---|
| Enemy Kill | +1 |
| Team Kill (if FF ON) | -1 |
| Suicide | -1 |

#### 6.3.3 Win Condition
- **Score Limit:** First team to reach the configured threshold (default: 50) wins.
- **Time Limit:** Highest team score wins when timer expires.
- **Tiebreaker:** If tied, match continues in **Overtime** — first team to score +2 wins.

#### 6.3.4 HUD & Feedback
- Team score displayed prominently at the top of the screen.
- Colored player names and outlines for ally identification.
- Team voice channel auto-assigned.
- End-of-match MVP screen (most kills, best K/D, most assists).

---

### 6.4 Gun Game

#### 6.4.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | None — free-for-all progression. |
| **Weapon System** | Linear tier list; every player starts at Tier 1. |
| **Advancement** | Promoted to the next weapon tier upon securing a kill. |
| **Demotion** | Melee kill from an opponent demotes the victim by **one** tier. |
| **Respawn** | Instant respawn; invulnerability frame: 2.0 s. |

#### 6.4.2 Win Condition
- **Final Tier Kill:** The first player to score a kill with the Tier 10 (Knife) weapon wins immediately.
- **No Time Limit:** Match persists until a player achieves the final-tier kill.

#### 6.4.3 HUD & Feedback
- Current weapon tier icon and name displayed center-bottom.
- Progress bar showing advancement through the 10 tiers.
- Global announcement when a player reaches Tier 9 ("One Away!").
- Melee kill notification includes demotion warning.
- Leader tracker: HUD highlights the player(s) currently at the highest tier.

---

### 6.5 Shared Systems Across All Modes

| System | Description |
|---|---|
| **Scoreboard** | Tab-overlay showing Kills / Deaths / Assists / Score / Ping. Updates in real time. |
| **Interlude** | 15-second post-round lobby. Displays final standings, map vote, and mode rematch option. |
| **Spectator** | Eliminated players (if respawn disabled) or joining players enter free-cam spectator mode. |
