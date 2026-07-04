// ─── "Waterfall" — tropical jungle ravine, vertical three-tier arena ─────────
// Basin (lower, water) → Mist Line (mid ledges) → Cliffside (upper deck north).
import { Brush, MapDef, Placement, Tuple3 } from "./schema";

const brushes: Brush[] = [
  // ground + ravine walls (tall stone)
  { k: "box", at: [0, -0.5, 0], size: [58, 1, 42], mat: "stone", tile: [14, 10] },
  { k: "box", at: [0, 4, -20.6], size: [58, 8, 1.2], mat: "stone", tile: [14, 2] },
  { k: "box", at: [0, 4, 20.6], size: [58, 8, 1.2], mat: "stone", tile: [14, 2] },
  { k: "box", at: [-28.6, 4, 0], size: [1.2, 8, 42], mat: "stone", tile: [10, 2] },
  { k: "box", at: [28.6, 4, 0], size: [1.2, 8, 42], mat: "stone", tile: [10, 2] },

  // ── cliffside (upper): raised massif along the north wall, walkable top y=4 ──
  { k: "box", at: [0, 2, -15.5], size: [54, 4, 9], mat: "stone", tile: [13, 2] },
  { k: "box", at: [0, 4.45, -11.3], size: [54, 0.9, 0.4], mat: "dark", tile: [13, 0.2] }, // edge rail
  { k: "stairs", at: [-9, 0, -6.4], axis: "z-", rise: 4, run: 6, width: 3, mat: "stone" },
  { k: "stairs", at: [9, 0, -6.4], axis: "z-", rise: 4, run: 6, width: 3, mat: "stone" },

  // ── mist line (mid): side ledges, walkable top y=2 ──
  { k: "box", at: [-21, 1, 3], size: [12, 2, 9], mat: "dark", tile: [3, 2.5] },
  { k: "box", at: [21, 1, 3], size: [12, 2, 9], mat: "dark", tile: [3, 2.5] },
  { k: "box", at: [-21, 2.3, 7.2], size: [12, 0.6, 0.4], mat: "stone", tile: [3, 0.15] }, // ledge lips
  { k: "box", at: [21, 2.3, 7.2], size: [12, 0.6, 0.4], mat: "stone", tile: [3, 0.15] },
  { k: "stairs", at: [-27.5, 0, 9], axis: "x+", rise: 2, run: 4.5, width: 3, mat: "stone" },
  { k: "stairs", at: [27.5, 0, 9], axis: "x-", rise: 2, run: 4.5, width: 3, mat: "stone" },

  // ── basin (lower): central water pool + rim, plus cover ──
  { k: "box", at: [0, 0.25, 13], size: [12, 0.5, 0.6], mat: "stone", tile: [4, 0.2] },
  { k: "box", at: [0, 0.25, 19], size: [12, 0.5, 0.6], mat: "stone", tile: [4, 0.2] },
  { k: "box", at: [-6, 0.25, 16], size: [0.6, 0.5, 6], mat: "stone", tile: [0.2, 2] },
  { k: "box", at: [6, 0.25, 16], size: [0.6, 0.5, 6], mat: "stone", tile: [0.2, 2] },
  { k: "water", at: [0, 0.12, 16], s: 11 },
  { k: "box", at: [-4, 0.75, -2], size: [3, 1.5, 3], mat: "stone", tile: [1, 0.6] }, // fallen rocks (cover)
  { k: "box", at: [5, 0.5, 1], size: [3.5, 1, 2.5], mat: "stone", tile: [1, 0.4] },
];

const objects: Placement[] = [
  // cliff-face rock pillars (cover, evoke the falls)
  { type: "column", at: [-2, 0, -9], params: { height: 4, radius: 0.5 } },
  { type: "column", at: [2, 0, -9], params: { height: 4, radius: 0.5 } },
  // lush vegetation
  { type: "shrub", at: [-10, 0, 6] },
  { type: "shrub", at: [10, 0, 6] },
  { type: "shrub", at: [-21, 2, 1] },
  { type: "shrub", at: [21, 2, 1] },
  { type: "succulent", at: [-6, 0, -3] },
  { type: "succulent", at: [7, 0, 2] },
  { type: "shrub", at: [0, 4, -14] },
  { type: "planter", at: [-24, 0, -18] },
  { type: "planter", at: [24, 0, -18] },
  // explosive barrels flanking the basin
  { type: "barrel", at: [-9, 0, 12] },
  { type: "barrel", at: [9, 0, 12] },
  // crates
  { type: "crate", at: [-13, 0, -4] },
  { type: "crate", at: [13, 0, -4] },
  { type: "lantern", at: [0, 3, -11], params: { color: 0x9fd8a0 } },
];

const pickups: Tuple3[] = [
  [0, 4.4, -15.5],   // cliffside top
  [-21, 2.4, 3],     // left mist ledge
  [21, 2.4, 3],      // right mist ledge
  [0, 0.6, 18],      // basin by the pool
];

const powerups: Tuple3[] = [
  [0, 0.8, 0], [-14, 0.8, 8], [14, 0.8, 8], [0, 4.6, -15.5],
];

const spawns = [
  { at: [-12, 17] as [number, number], yaw: 0 },
  { at: [12, 17] as [number, number], yaw: 0 },
  { at: [0, 15] as [number, number], yaw: 0 },
  { at: [-24, 12] as [number, number], yaw: 20 },
  { at: [24, 12] as [number, number], yaw: -20 },
  { at: [0, -14] as [number, number], yaw: 180 },
  { at: [-18, -2] as [number, number], yaw: 120 },
  { at: [18, -2] as [number, number], yaw: 240 },
  { at: [-21, 3] as [number, number], yaw: 90 },
  { at: [21, 3] as [number, number], yaw: -90 },
];

export const WATERFALL: MapDef = {
  meta: { id: "waterfall", name: "Waterfall", theme: "Tropical jungle ravine" },
  env: {
    sky: { hdri: "hdri/sky.hdr" },
    fog: { color: [0.62, 0.72, 0.66], start: 26, end: 90 },
    ambient: { color: [0.5, 0.66, 0.6], intensity: 0.7, specular: 0.8 },
    sun: { rot: [-58, -20, 0], color: [1.2, 1.24, 1.05], strength: 0.75 },
    water: [0, 0.4, 16],
  },
  brushes,
  objects,
  spawns,
  pickups,
  powerups,
};
