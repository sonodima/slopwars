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
