// ─── "Overgrowth" — bio-reclaimed corporate office, nature vs. cubicles ──────
// Interior arena: cubicle farm (low partitions), a walled conference room, and a
// raised "CEO vertical garden" deck. Soft green interior light, no open sky.
import { Brush, MapDef, Placement, Tuple3 } from "./schema";

const brushes: Brush[] = [
  // office floor + perimeter walls
  { k: "box", at: [0, -0.5, 0], size: [54, 1, 42], mat: "floor", tile: [15, 11] },
  { k: "box", at: [0, 3, -20.6], size: [54, 6, 1.2], mat: "wall", tile: [13, 1.4] },
  { k: "box", at: [0, 3, 20.6], size: [54, 6, 1.2], mat: "wall", tile: [13, 1.4] },
  { k: "box", at: [-26.6, 3, 0], size: [1.2, 6, 42], mat: "wall", tile: [10, 1.4] },
  { k: "box", at: [26.6, 3, 0], size: [1.2, 6, 42], mat: "wall", tile: [10, 1.4] },

  // ── cubicle farm (low metal partitions, h≈1.5) ──
  { k: "box", at: [-14, 0.75, -8], size: [8, 1.5, 0.3], mat: "metal", tile: [3, 0.6] },
  { k: "box", at: [-14, 0.75, -3], size: [8, 1.5, 0.3], mat: "metal", tile: [3, 0.6] },
  { k: "box", at: [-10, 0.75, -5.5], size: [0.3, 1.5, 5], mat: "metal", tile: [2, 0.6] },
  { k: "box", at: [-18, 0.75, -5.5], size: [0.3, 1.5, 5], mat: "metal", tile: [2, 0.6] },
  { k: "box", at: [-13, 0.75, 6], size: [10, 1.5, 0.3], mat: "metal", tile: [4, 0.6] },
  { k: "box", at: [-8, 0.75, 9], size: [0.3, 1.5, 6], mat: "metal", tile: [2.5, 0.6] },
  { k: "box", at: [8, 0.75, -6], size: [0.3, 1.5, 8], mat: "metal", tile: [3, 0.6] },
  { k: "box", at: [12, 0.75, -10], size: [8, 1.5, 0.3], mat: "metal", tile: [3, 0.6] },

  // ── conference room (NE corner, walls + doorway gap) ──
  { k: "box", at: [18, 1.6, -14], size: [16, 3.2, 0.4], mat: "wall", tile: [5, 1] },
  { k: "box", at: [10.2, 1.6, -17.5], size: [0.4, 3.2, 7], mat: "wall", tile: [2, 1] },
  { k: "box", at: [23, 1.6, -8.5], size: [0.4, 3.2, 4], mat: "wall", tile: [1.2, 1] }, // partial → doorway
  { k: "box", at: [18, 0.5, -15], size: [6, 1, 2.4], mat: "crate", tile: [2, 0.6] }, // meeting table
  { k: "box", at: [18, 3.4, -14.5], size: [15, 0.3, 6], mat: "dark", tile: [4, 2], solid: false }, // dropped ceiling

  // ── CEO vertical garden (raised deck, SW, top y=2.4) ──
  { k: "box", at: [-18, 1.2, 13], size: [12, 2.4, 10], mat: "stone", tile: [3.5, 2.5] },
  { k: "box", at: [-18, 2.5, 8.2], size: [12, 0.5, 0.4], mat: "dark", tile: [3.5, 0.15] }, // deck lip
  { k: "stairs", at: [-11, 0, 10], axis: "x-", rise: 2.4, run: 5, width: 3, mat: "stone" },

  // central atrium cover
  { k: "box", at: [3, 0.6, 3], size: [4, 1.2, 4], mat: "stone", tile: [1.4, 0.5] },
];

const objects: Placement[] = [
  // nature reclaiming the office — planters + vegetation everywhere
  { type: "planter", at: [-18, 2.4, 13], params: { plant: "shrub" } },
  { type: "planter", at: [-21, 2.4, 15], params: { plant: "succulent" } },
  { type: "planter", at: [-15, 2.4, 15], params: { plant: "shrub" } },
  { type: "planter", at: [3, 1.2, 3] },
  { type: "shrub", at: [-14, 0, -5.5] },
  { type: "shrub", at: [9, 0, 8] },
  { type: "shrub", at: [22, 0, 6] },
  { type: "succulent", at: [-6, 0, -2] },
  { type: "succulent", at: [6, 0, -14] },
  { type: "succulent", at: [14, 0, 12] },
  { type: "shrub", at: [-24, 0, -16] },
  { type: "shrub", at: [24, 0, 16] },

  // office clutter + hazards
  { type: "crate", at: [10, 0, 10], params: { size: 1.2 } },
  { type: "crate", at: [12, 0, 12], params: { size: 1.2 } },
  { type: "crate", at: [11, 1.2, 11], params: { size: 1.0 } },
  { type: "pallet", at: [-2, 0, 14] },
  { type: "sandbags", at: [16, 0, 4], params: { rot: 0 } },
  { type: "barrel", at: [21, 0, -11] }, // in the conference room
  { type: "barrel", at: [-24, 0, 2] },
  { type: "barrel", at: [4, 0, -8] },
  { type: "lantern", at: [0, 3.2, 0], params: { color: 0xbfe6a0, distance: 14 } },
  { type: "lantern", at: [18, 3, -14], params: { color: 0xcfe8b0, distance: 10 } },
];

const pickups: Tuple3[] = [
  [-18, 2.65, 13],   // garden deck
  [18, 0.6, -15],    // conference table area
  [-14, 0.6, -5.5],  // cubicle
  [3, 1.35, 3],      // atrium block
];

const powerups: Tuple3[] = [
  [0, 0.8, 0], [-14, 0.8, 12], [14, 0.8, -6], [18, 0.8, -12],
];

const spawns = [
  { at: [-24, -17] as [number, number], yaw: 135 },
  { at: [24, -17] as [number, number], yaw: 225 },
  { at: [-24, 17] as [number, number], yaw: 45 },
  { at: [0, 17] as [number, number], yaw: 0 },
  { at: [0, -17] as [number, number], yaw: 180 },
  { at: [12, 16] as [number, number], yaw: 10 },
  { at: [-12, -14] as [number, number], yaw: 160 },
  { at: [22, 8] as [number, number], yaw: -90 },
  { at: [-22, -6] as [number, number], yaw: 90 },
  { at: [8, -3] as [number, number], yaw: 200 },
];

export const OVERGROWTH: MapDef = {
  meta: { id: "overgrowth", name: "Overgrowth", theme: "Bio-reclaimed corporate office" },
  env: {
    sky: { solid: [0.09, 0.12, 0.09] },
    fog: { color: [0.14, 0.18, 0.13], start: 20, end: 75 },
    ambient: { color: [0.4, 0.5, 0.38], intensity: 0.6, specular: 0.55 },
    sun: { rot: [-64, -46, 0], color: [0.85, 0.95, 0.78], strength: 0.5 },
  },
  brushes,
  objects,
  spawns,
  pickups,
  powerups,
};
