## 1. Portal System

### 1.1 Core Mechanics
| Feature | Specification |
|---|---|
| **Spawning** | Player can spawn two linked portals (entry / exit) |
| **Traversal** | Player can enter a portal to teleport to the linked portal's location |
| **Projectile Routing** | Bullets and throwables pass through portals, maintaining trajectory and velocity |
| **Ownership** | Portals are **player-bound**; only the creator can use them |
| **Duration** | 45 seconds before automatic despawn |

### 1.2 Design Notes
- Portals must visually and audibly indicate their remaining lifespan.
- Projectile physics must seamlessly translate across portal boundaries without collision artifacts.

---

## 2. Weapons

### 2.1 Visuals
- **Current State:** Placeholder models in use.
- **Target:** Replace with finalized, high-quality weapon models.

### 2.2 Audio
- **Reload Sounds:** Unique reload SFX per weapon class.
- **Equip Sounds:** Distinct draw / holster audio cues.

---

## 3. Graphics

### 3.1 Fire Effects
- **Current State:** Visually unrealistic.
- **Target:** High-fidelity flame system comprising:
  - Realistic flame textures (sprite sheets or volumetric).
  - Dynamic particle effects (sparks, smoke, heat distortion).
  - Layered LOD to maintain performance across distances.

---

## 4. Map System

### 4.1 Architecture
- **File Format:** Custom `.map` files.
- **Encapsulation:** Each `.map` file is self-contained and defines:
  - Geometry & collision meshes
  - Textures & materials
  - Skybox
  - Lighting (ambient, directional, point, spot)
  - Spawn points (player & pickup)
  - Vegetation & decorative props
  - Interactive objects

### 4.2 Design Principles
- **Scale:** Compact, arena-style footprints; density over sprawl.
- **Detail:** Rich environmental storytelling via props, structures, and coherent item placement.
- **Differentiation:** Each map must have a unique visual identity and spatial flow.
- **Logic:** Geometry and object placement must feel intentional and believable.

### 4.3 Map Pool

#### 4.3.1 Waterfall
| Attribute | Description |
|---|---|
| **Theme** | Tropical jungle ravine |
| **Layout** | Vertical three-tier structure |
| **Zones** | • **Basin** (lower)&lt;br&gt;• **Mist Line** (mid)&lt;br&gt;• **Cliffside** (upper) |
| **Key Feature** | Waterfall acts as dynamic sound barrier; gunfire is muffled across waterfall faces |

#### 4.3.2 Neon Graveyard
| Attribute | Description |
|---|---|
| **Theme** | Cyberpunk cemetery during a rainy night |
| **Layout** | Mausoleum maze + underground crypts + overhead maglev rail |
| **Skybox** | Rain-soaked night, megastructures, neon reflections on wet surfaces |

#### 4.3.3 Overgrowth
| Attribute | Description |
|---|---|
| **Theme** | Bio-reclaimed corporate office |
| **Layout** | Cubicle farms + conference rooms + CEO vertical garden |
| **Atmosphere** | Nature overtaking sterile corporate architecture |

#### 4.3.4 Koi (the current map that we have at the moment)

### 4.4 Match Flow
| Phase | Behavior |
|---|---|
| **Initial Match** | Map is selected at random from the pool. |
| **Interlude (between rounds)** | Voting interface presented to all players. |
| **Next Map** | Map with the plurality of votes is loaded for the subsequent round. |

---

## 5. Game Modes

### 5.1 Lobby Integration
- **Selection:** Host chooses the game mode from a dropdown / card interface in the pre-game lobby.
- **Persistence:** Selected mode is displayed in the lobby header and server browser.
- **Configuration:** Each mode exposes adjustable parameters (score limit, time limit, etc.) editable by the host before match start.

---

### 5.2 Free for All (FFA)

#### 5.2.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | None — every player is an independent combatant. |
| **Respawn** | Instant respawn at random spawn points across the map. |
| **Friendly Fire** | N/A (no teams). |

#### 5.2.2 Scoring
| Event | Points |
|---|---|
| Kill | +1 |
| Death | 0 (no penalty) |
| Suicide | -1 |

#### 5.2.3 Win Condition
- **Score Limit:** First player to reach the configured kill threshold (default: 20) wins the match.
- **Time Limit:** If no player reaches the score limit, the player with the highest score when the timer expires wins.
- **Tiebreaker:** If tied at time expiry, the match enters **Sudden Death** — next kill wins.

#### 5.2.4 HUD & Feedback
- Real-time scoreboard sorted by kills (descending).
- Personal streak announcement (e.g., "Killing Spree," "Rampage").
- Kill feed with weapon icon.

---

### 5.3 Team Deathmatch (TDM)

#### 5.3.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | Two teams (Alpha / Bravo). |
| **Team Size** | Balanced automatically; max delta = 1 player. |
| **Respawn** | Delayed respawn (3 s) at team-proximate spawn points. |
| **Friendly Fire** | Off by default; host-toggleable. |

#### 5.3.2 Scoring
| Event | Team Points |
|---|---|
| Enemy Kill | +1 |
| Team Kill (if FF ON) | -1 |
| Suicide | -1 |

#### 5.3.3 Win Condition
- **Score Limit:** First team to reach the configured threshold (default: 50) wins.
- **Time Limit:** Highest team score wins when timer expires.
- **Tiebreaker:** If tied, match continues in **Overtime** — first team to score +2 wins.

#### 5.3.4 HUD & Feedback
- Team score displayed prominently at the top of the screen.
- Colored player names and outlines for ally identification.
- Team voice channel auto-assigned.
- End-of-match MVP screen (most kills, best K/D, most assists).

---

### 5.4 Gun Game

#### 5.4.1 Rules
| Parameter | Value |
|---|---|
| **Teams** | None — free-for-all progression. |
| **Weapon System** | Linear tier list; every player starts at Tier 1. |
| **Advancement** | Promoted to the next weapon tier upon securing a kill. |
| **Demotion** | Melee kill from an opponent demotes the victim by **one** tier. |
| **Respawn** | Instant respawn; invulnerability frame: 2.0 s. |

#### 5.4.2 Win Condition
- **Final Tier Kill:** The first player to score a kill with the Tier 10 (Knife) weapon wins immediately.
- **No Time Limit:** Match persists until a player achieves the final-tier kill.

#### 5.4.3 HUD & Feedback
- Current weapon tier icon and name displayed center-bottom.
- Progress bar showing advancement through the 10 tiers.
- Global announcement when a player reaches Tier 9 ("One Away!").
- Melee kill notification includes demotion warning.
- Leader tracker: HUD highlights the player(s) currently at the highest tier.

---

### 5.5 Shared Systems Across All Modes

| System | Description |
|---|---|
| **Scoreboard** | Tab-overlay showing Kills / Deaths / Assists / Score / Ping. Updates in real time. |
| **Interlude** | 15-second post-round lobby. Displays final standings, map vote, and mode rematch option. |
| **Spectator** | Eliminated players (if respawn disabled) or joining players enter free-cam spectator mode. |
