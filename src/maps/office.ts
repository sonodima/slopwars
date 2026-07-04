// ─── "Office" — a single floor of a corporate building ───────────────────────
// Enclosed interior. A central cross of corridors splits the floor into 4
// quadrant rooms, each reachable by two doorways → tight, covered flow, no long
// open sightlines:
//   NW  open-plan cubicle farm      NE  conference room + break room
//   SW  storage / server room       SE  reception lounge under a manager mezzanine
// Lit only by daylight: windows punched through every exterior wall + a central
// skylight let the city HDRI in — no artificial lamps.
// Bounds: x ∈ [-27,27], z ∈ [-20,20]. north = -z. Units ≈ metres.
import { Brush, MapDef, Placement, Tuple3 } from "./schema";

const IW = 4.7;   // interior wall height (meets ceiling underside)
const IY = IW / 2;
const T = 0.35;   // interior wall thickness
const LINTEL = 3.45; // door-header center (2.2 → 4.7)

// ── perimeter window helpers ──────────────────────────────────────────────
const WT = 1.2;   // perimeter wall thickness
const WH = 5;     // perimeter wall height (floor → roof)
const SILL = 1.0; // window opening bottom
const HEAD = 2.7; // window opening top
const WINW = 2.6; // window width

/** exterior wall running along x at constant z, with window openings at `wins` */
function xWall(z: number, x0: number, x1: number, wins: number[]): Brush[] {
  const out: Brush[] = [];
  const e = [x0, ...wins.flatMap((c) => [c - WINW / 2, c + WINW / 2]), x1];
  for (let i = 0; i < e.length - 1; i += 2) {
    const a = e[i], b = e[i + 1];
    if (b - a > 0.05) out.push({ k: "box", at: [(a + b) / 2, WH / 2, z], size: [b - a, WH, WT], mat: "wall", tile: [(b - a) / 4, 1.4] });
  }
  for (const c of wins) {
    out.push({ k: "box", at: [c, SILL / 2, z], size: [WINW, SILL, WT], mat: "wall", tile: [0.7, 0.3] });
    out.push({ k: "box", at: [c, (HEAD + WH) / 2, z], size: [WINW, WH - HEAD, WT], mat: "wall", tile: [0.7, 0.6] });
    out.push({ k: "box", at: [c, SILL + 0.07, z], size: [WINW + 0.3, 0.14, WT + 0.3], mat: "stone", tile: [0.8, 0.1] }); // sill ledge
    out.push({ k: "box", at: [c, (SILL + HEAD) / 2, z], size: [0.12, HEAD - SILL, WT * 0.5], mat: "dark", tile: [0.1, 0.6], solid: false }); // mullion
  }
  return out;
}
/** exterior wall running along z at constant x, with window openings at `wins` */
function zWall(x: number, z0: number, z1: number, wins: number[]): Brush[] {
  const out: Brush[] = [];
  const e = [z0, ...wins.flatMap((c) => [c - WINW / 2, c + WINW / 2]), z1];
  for (let i = 0; i < e.length - 1; i += 2) {
    const a = e[i], b = e[i + 1];
    if (b - a > 0.05) out.push({ k: "box", at: [x, WH / 2, (a + b) / 2], size: [WT, WH, b - a], mat: "wall", tile: [(b - a) / 4, 1.4] });
  }
  for (const c of wins) {
    out.push({ k: "box", at: [x, SILL / 2, c], size: [WT, SILL, WINW], mat: "wall", tile: [0.7, 0.3] });
    out.push({ k: "box", at: [x, (HEAD + WH) / 2, c], size: [WT, WH - HEAD, WINW], mat: "wall", tile: [0.7, 0.6] });
    out.push({ k: "box", at: [x, SILL + 0.07, c], size: [WT + 0.3, 0.14, WINW + 0.3], mat: "stone", tile: [0.8, 0.1] });
    out.push({ k: "box", at: [x, (SILL + HEAD) / 2, c], size: [WT * 0.5, HEAD - SILL, 0.12], mat: "dark", tile: [0.1, 0.6], solid: false });
  }
  return out;
}

const brushes: Brush[] = [
  // ── floor ──
  { k: "box", at: [0, -0.5, 0], size: [56, 1, 42], mat: "floor", tile: [16, 12] },

  // ── perimeter walls with daylight windows (all 4 sides) ──
  ...xWall(-20.6, -27, 27, [-20, -11, 11, 20]),  // north
  ...xWall(20.6, -27, 27, [-20, -11, 11, 20]),   // south
  ...zWall(-27.6, -20, 20, [-14, -7, 7, 14]),    // west
  ...zWall(27.6, -20, 20, [-14, -7, 7, 14]),     // east
  // corner posts closing the perimeter
  { k: "box", at: [-27.6, WH / 2, -20.6], size: [1.2, WH, 1.2], mat: "wall", tile: [0.3, 1.4] },
  { k: "box", at: [27.6, WH / 2, -20.6], size: [1.2, WH, 1.2], mat: "wall", tile: [0.3, 1.4] },
  { k: "box", at: [-27.6, WH / 2, 20.6], size: [1.2, WH, 1.2], mat: "wall", tile: [0.3, 1.4] },
  { k: "box", at: [27.6, WH / 2, 20.6], size: [1.2, WH, 1.2], mat: "wall", tile: [0.3, 1.4] },

  // ── ceiling: 4 slabs leaving a 6×6 skylight over the central junction ──
  { k: "box", at: [0, 4.85, -11.5], size: [56, 0.3, 17], mat: "dark", tile: [14, 5], solid: false },
  { k: "box", at: [0, 4.85, 11.5], size: [56, 0.3, 17], mat: "dark", tile: [14, 5], solid: false },
  { k: "box", at: [-15.5, 4.85, 0], size: [25, 0.3, 6], mat: "dark", tile: [7, 2], solid: false },
  { k: "box", at: [15.5, 4.85, 0], size: [25, 0.3, 6], mat: "dark", tile: [7, 2], solid: false },
  { k: "box", at: [0, 4.7, 0], size: [6.6, 0.3, 0.4], mat: "stone", tile: [2, 0.1], solid: false }, // skylight frame N/S
  { k: "box", at: [0, 4.7, 0.0], size: [0.4, 0.3, 6.6], mat: "stone", tile: [0.1, 2], solid: false }, // skylight frame E/W (placeholder pair below)

  // ── N-S corridor walls (x = ±3), full height, doorways at z = ∓9 ──
  { k: "box", at: [-3, IY, -15], size: [T, IW, 10], mat: "wall", tile: [3, 1.6] },
  { k: "box", at: [-3, IY, -5.5], size: [T, IW, 5], mat: "wall", tile: [1.5, 1.6] },
  { k: "box", at: [-3, IY, 5.5], size: [T, IW, 5], mat: "wall", tile: [1.5, 1.6] },
  { k: "box", at: [-3, IY, 15], size: [T, IW, 10], mat: "wall", tile: [3, 1.6] },
  { k: "box", at: [-3, LINTEL, -9], size: [T, 2.5, 2], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [-3, LINTEL, 9], size: [T, 2.5, 2], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [3, IY, -15], size: [T, IW, 10], mat: "wall", tile: [3, 1.6] },
  { k: "box", at: [3, IY, -5.5], size: [T, IW, 5], mat: "wall", tile: [1.5, 1.6] },
  { k: "box", at: [3, IY, 5.5], size: [T, IW, 5], mat: "wall", tile: [1.5, 1.6] },
  { k: "box", at: [3, IY, 15], size: [T, IW, 10], mat: "wall", tile: [3, 1.6] },
  { k: "box", at: [3, LINTEL, -9], size: [T, 2.5, 2], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [3, LINTEL, 9], size: [T, 2.5, 2], mat: "wall", tile: [0.6, 0.8] },

  // ── E-W corridor walls (z = ±3), full height, doorways at x = ∓15 ──
  { k: "box", at: [-21.5, IY, -3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [-8.5, IY, -3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [8.5, IY, -3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [21.5, IY, -3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [-15, LINTEL, -3], size: [2, 2.5, T], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [15, LINTEL, -3], size: [2, 2.5, T], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [-21.5, IY, 3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [-8.5, IY, 3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [8.5, IY, 3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [21.5, IY, 3], size: [11, IW, T], mat: "wall", tile: [3.3, 1.6] },
  { k: "box", at: [-15, LINTEL, 3], size: [2, 2.5, T], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [15, LINTEL, 3], size: [2, 2.5, T], mat: "wall", tile: [0.6, 0.8] },

  // ── NW cubicle farm: low grey partition panels (h≈1.5) ──
  { k: "box", at: [-15, 0.75, -11], size: [22, 1.5, 0.16], mat: "wall", tile: [7, 0.5] },
  { k: "box", at: [-15, 0.75, -15.5], size: [0.16, 1.5, 7], mat: "wall", tile: [2.3, 0.5] },
  { k: "box", at: [-15, 0.75, -7], size: [0.16, 1.5, 6.5], mat: "wall", tile: [2.2, 0.5] },
  { k: "box", at: [-9, 0.75, -18], size: [0.16, 1.5, 4], mat: "wall", tile: [1.4, 0.5] },

  // ── SW storage: low pony wall carving a back aisle ──
  { k: "box", at: [-19, 0.9, 12], size: [0.3, 1.8, 8], mat: "wall", tile: [3, 0.7] },

  // ── NE divider: conference (west) | break room (east), door at z = -9 ──
  { k: "box", at: [15, IY, -14.5], size: [T, IW, 9], mat: "wall", tile: [2.7, 1.6] },
  { k: "box", at: [15, IY, -6.5], size: [T, IW, 3], mat: "wall", tile: [0.9, 1.6] },
  { k: "box", at: [15, LINTEL, -9], size: [T, 2.5, 2], mat: "wall", tile: [0.6, 0.8] },
  { k: "box", at: [9, 0.5, -12], size: [5.2, 1.0, 2.4], mat: "crate", tile: [2, 0.6] },       // meeting table
  { k: "box", at: [9, 1.05, -12], size: [5.4, 0.1, 2.6], mat: "stone", tile: [2, 1], solid: false },
  { k: "box", at: [21, 0.55, -18.5], size: [10, 1.1, 1.2], mat: "stone", tile: [3, 0.4] },    // kitchenette counter
  { k: "box", at: [21, 1.15, -18.5], size: [10.2, 0.1, 1.4], mat: "dark", tile: [3, 0.4], solid: false },

  // ── SE reception counter + manager mezzanine (walk under, climb to top) ──
  { k: "box", at: [9, 0.55, 17], size: [5, 1.1, 1.0], mat: "crate", tile: [1.8, 0.4] },       // reception desk
  { k: "box", at: [9, 1.15, 17], size: [5.2, 0.1, 1.2], mat: "stone", tile: [1.8, 0.4], solid: false },
  { k: "box", at: [21.5, 3.0, 14.5], size: [11, 0.4, 9], mat: "stone", tile: [3.5, 3] },       // mezz slab
  { k: "box", at: [16, 3.65, 11.5], size: [0.25, 0.9, 3], mat: "dark", tile: [1, 0.3] },       // west railing (S of stair)
  { k: "box", at: [16, 3.65, 17.5], size: [0.25, 0.9, 3], mat: "dark", tile: [1, 0.3] },       // west railing (N of stair)
  { k: "box", at: [21.5, 3.65, 10], size: [11, 0.9, 0.25], mat: "dark", tile: [3.5, 0.3] },    // north railing
  { k: "stairs", at: [11, 0, 14.5], axis: "x+", rise: 3.2, run: 5, width: 3, mat: "dark" },

  // ── central atrium: low planter block under the skylight (cover for mid pickup) ──
  { k: "box", at: [0, 0.4, 0], size: [3, 0.8, 3], mat: "stone", tile: [1.2, 0.4] },
];

const objects: Placement[] = [
  // ── NW open-plan cubicles: 4 desk+chair pods, cabinets on the west wall ──
  { type: "desk", at: [-21, 0, -16.5], rot: 0 },
  { type: "chair", at: [-21, 0, -15.3], rot: 180 },
  { type: "desk", at: [-9.5, 0, -16.5], rot: 0 },
  { type: "chair", at: [-9.5, 0, -15.3], rot: 180 },
  { type: "desk", at: [-21, 0, -7.5], rot: 0 },
  { type: "chair", at: [-21, 0, -6.3], rot: 180 },
  { type: "desk", at: [-9.5, 0, -7.5], rot: 0 },
  { type: "chair", at: [-9.5, 0, -6.3], rot: 180 },
  { type: "cabinet", at: [-26.5, 0, -12], rot: 90 },
  { type: "trashcan", at: [-24, 0, -5], rot: 0 },
  { type: "pplant2", at: [-5, 0, -18], rot: 0 },
  { type: "clock", at: [-24, 3.2, -6], rot: 90 },

  // ── SW storage / server room: shelves, cabinets, cardboard clutter (dense cover) ──
  { type: "bookshelf", at: [-26.6, 0, 8], rot: 90 },
  { type: "bookshelf", at: [-26.6, 0, 14], rot: 90 },
  { type: "cabinet", at: [-6, 0, 5.5], rot: -90 },
  { type: "cabinet", at: [-6, 0, 8], rot: -90 },
  { type: "cardbox", at: [-22, 0, 6], rot: 20 },
  { type: "cardbox", at: [-22.5, 0, 6.9], rot: -30 },
  { type: "cardbox", at: [-21.6, 0, 7.4], rot: 60 },
  { type: "cardbox", at: [-14, 0, 16], rot: 10 },
  { type: "cardbox", at: [-13.2, 0, 16.7], rot: -45 },
  { type: "cardbox", at: [-14.3, 0, 17.2], rot: 30 },
  { type: "crate", at: [-9, 0, 17.5], rot: 15 },
  { type: "crate", at: [-24, 0, 17], rot: -20 },
  { type: "trashcan", at: [-16, 0, 6], rot: 0 },
  { type: "toolbox", at: [-11, 0, 11], rot: 40 },

  // ── NE conference room: table chairs, plant, wall detail ──
  { type: "chair", at: [6.5, 0, -11], rot: -90 },
  { type: "chair", at: [6.5, 0, -13], rot: -90 },
  { type: "chair", at: [11.5, 0, -11], rot: 90 },
  { type: "chair", at: [11.5, 0, -13], rot: 90 },
  { type: "pplant", at: [5, 0, -18], rot: 0 },
  { type: "clock", at: [9, 3.2, -20.0], rot: 0 },
  { type: "extinguisher", at: [4.4, 1.1, -5], rot: -90 },

  // ── NE break room: coffee tables + chairs + bin + plant ──
  { type: "cofftable", at: [19, 0, -12], rot: 0 },
  { type: "chair", at: [19, 0, -10.5], rot: 180 },
  { type: "chair", at: [19, 0, -13.5], rot: 0 },
  { type: "cofftable", at: [24, 0, -8], rot: 0 },
  { type: "chair", at: [24, 0, -6.6], rot: 180 },
  { type: "trashcan", at: [26, 0, -13], rot: 0 },
  { type: "pplant2", at: [17, 0, -6], rot: 0 },

  // ── SE reception lounge (under the mezzanine): sofa set + plants ──
  { type: "sofa", at: [6, 0, 12], rot: -90 },
  { type: "cofftable", at: [8.2, 0, 12], rot: 90 },
  { type: "sofa", at: [10.5, 0, 12], rot: 90 },
  { type: "pplant", at: [5, 0, 18], rot: 0 },
  { type: "pplant2", at: [13, 0, 18.5], rot: 0 },
  { type: "trashcan", at: [12, 0, 16], rot: 0 },
  { type: "extinguisher", at: [26.6, 1.1, 6], rot: 90 },
  // manager office up on the mezzanine
  { type: "desk", at: [23.5, 3.2, 13], rot: -90 },
  { type: "chair", at: [22.2, 3.2, 13], rot: 90 },
  { type: "cabinet", at: [25.5, 3.2, 17.5], rot: 180 },
  { type: "pplant2", at: [18, 3.2, 12], rot: 0 },
];

const pickups: Tuple3[] = [
  [0, 1.0, 0],        // central atrium block (under skylight)
  [23.5, 3.6, 15],    // manager mezzanine
  [9, 1.15, -12],     // conference table
  [-15, 0.5, 11],     // storage aisle floor
];

const powerups: Tuple3[] = [
  [-15, 0.8, -11],    // cubicle farm center
  [21, 0.8, -12],     // break room
  [0, 0.8, -14],      // north corridor
  [0, 0.8, 14],       // south corridor
];

const spawns = [
  { at: [-24, -17] as [number, number], yaw: 135 },
  { at: [-20, -6] as [number, number], yaw: 90 },
  { at: [-24, 17] as [number, number], yaw: 45 },
  { at: [-14, 13] as [number, number], yaw: 20 },
  { at: [24, -17] as [number, number], yaw: 225 },
  { at: [20, -6] as [number, number], yaw: 270 },
  { at: [24, 6] as [number, number], yaw: 315 },
  { at: [7, 16] as [number, number], yaw: 0 },
  { at: [0, -17] as [number, number], yaw: 180 },
  { at: [0, 17] as [number, number], yaw: 0 },
];

export const OFFICE: MapDef = {
  meta: { id: "office", name: "Office", theme: "Corporate building floor" },
  env: {
    sky: { hdri: "hdri/shanghai_bund.hdr" },
    fog: { color: [0.62, 0.66, 0.72], start: 55, end: 170 },
    ambient: { color: [0.66, 0.69, 0.74], intensity: 1.05, specular: 1.0 },
    sun: { rot: [-50, -35, 0], color: [1.0, 0.98, 0.94], strength: 0.95 },
  },
  textures: { wall: "office_wall", floor: "office_carpet", stone: "office_tile", dark: "office_ceil" },
  brushes,
  objects,
  spawns,
  pickups,
  powerups,
};
