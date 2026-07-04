// ─── "Waterfall" — open tropical ravine, natural cliffs + terraces ───────────
// Redesigned for openness: north wall replaced by two split rock terraces with a
// low central gap (long sightline), flanking side terraces, an open basin/pool to
// the south. Cover is modeled (boulders, big trees, logs) — no random cubes. A
// huge cliff model sits beyond the north wall as the waterfall backdrop.
import { Brush, MapDef, Placement, Tuple3 } from "./schema";

const brushes: Brush[] = [
  // ── forest ground + lower perimeter walls (h=6, cliff-faced) ──
  { k: "box", at: [0, -0.5, 0], size: [58, 1, 42], mat: "floor", tile: [16, 11] },
  { k: "box", at: [0, 3, -20.6], size: [58, 6, 1.2], mat: "wall", tile: [15, 1.6] },
  { k: "box", at: [0, 3, 20.6], size: [58, 6, 1.2], mat: "wall", tile: [15, 1.6] },
  { k: "box", at: [-28.6, 3, 0], size: [1.2, 6, 42], mat: "wall", tile: [11, 1.6] },
  { k: "box", at: [28.6, 3, 0], size: [1.2, 6, 42], mat: "wall", tile: [11, 1.6] },

  // ── north cliff terraces: SPLIT into two, open central gap x∈[-5,5] ──
  { k: "box", at: [-16, 1.6, -15.5], size: [22, 3.2, 9], mat: "stone", tile: [6, 1.6] }, // left terrace, top y=3.2
  { k: "box", at: [16, 1.6, -15.5], size: [22, 3.2, 9], mat: "stone", tile: [6, 1.6] },  // right terrace
  { k: "box", at: [-16, 3.4, -11.2], size: [22, 0.4, 0.4], mat: "dark", tile: [6, 0.15] }, // edge lips
  { k: "box", at: [16, 3.4, -11.2], size: [22, 0.4, 0.4], mat: "dark", tile: [6, 0.15] },
  { k: "box", at: [0, 0.5, -16], size: [9, 1, 8], mat: "stone", tile: [3, 1] },           // low rock in the gap (route/cover)
  { k: "stairs", at: [-16, 0, -8.5], axis: "z-", rise: 3.2, run: 6, width: 3.4, mat: "stone" },
  { k: "stairs", at: [16, 0, -8.5], axis: "z-", rise: 3.2, run: 6, width: 3.4, mat: "stone" },

  // ── flanking side terraces (mid tier, walkable top y=1.8) ──
  { k: "box", at: [-24, 0.9, 3.5], size: [9, 1.8, 13], mat: "dark", tile: [2.5, 3.5] },
  { k: "box", at: [24, 0.9, 3.5], size: [9, 1.8, 13], mat: "dark", tile: [2.5, 3.5] },
  { k: "box", at: [-19.8, 2.05, 3.5], size: [0.4, 0.5, 13], mat: "stone", tile: [0.15, 3.5] }, // inner lips
  { k: "box", at: [19.8, 2.05, 3.5], size: [0.4, 0.5, 13], mat: "stone", tile: [0.15, 3.5] },
  { k: "stairs", at: [-27.5, 0, 12], axis: "x+", rise: 1.8, run: 4.5, width: 3.2, mat: "stone" },
  { k: "stairs", at: [27.5, 0, 12], axis: "x-", rise: 1.8, run: 4.5, width: 3.2, mat: "stone" },

  // ── south basin: wide shallow pool (fed by the falls) ──
  { k: "water", at: [0, 0.12, 15], s: 15 },
  { k: "box", at: [0, 0.18, 7.3], size: [16, 0.36, 0.5], mat: "stone", tile: [5, 0.15] }, // pool north rim (low)
];

const objects: Placement[] = [
  // ── waterfall cliff backdrop (scenery, beyond the north wall) ──
  { type: "cliff", at: [-6, 1.5, -30], rot: 0, params: { scale: 0.55 } },

  // ── big canopy trees framing the ravine (thin-trunk collision) ──
  { type: "tree", at: [-25, 0, -18], params: { scale: 1.1 } },
  { type: "tree", at: [25, 0, -18], params: { scale: 1.0 } },
  { type: "tree", at: [-26, 0, 17], params: { scale: 0.95 } },
  { type: "tree2", at: [24, 0, 17], params: { scale: 1.0 } },
  { type: "tree2", at: [-16, 3.2, -17], params: { scale: 0.8 } }, // on the left terrace
  { type: "tree2", at: [16, 3.2, -17], params: { scale: 0.8 } },  // on the right terrace

  // ── rock cover scattered through the open center (no boxes) ──
  { type: "rockset", at: [-9, 0, -3], params: { scale: 0.7 }, rot: 30 },
  { type: "rockset2", at: [9, 0, -3], params: { scale: 0.9 }, rot: -40 },
  { type: "boulder", at: [0, 0, 2], params: { scale: 0.62 }, rot: 15 },
  { type: "boulder", at: [-6, 0, 9], params: { scale: 0.5 }, rot: 20 },
  { type: "boulder", at: [7, 0, 9], params: { scale: 0.55 }, rot: -35 },
  { type: "rockset2", at: [0, 0.4, -15.5], params: { scale: 0.55 }, rot: 50 }, // dress the gap rock
  { type: "stump", at: [-13, 0, 6], params: { scale: 1.1 } },
  { type: "stump", at: [14, 0, 5], params: { scale: 1.0 } },
  // fallen logs across lanes
  { type: "deadtree", at: [-4, 0, 5], rot: 90, params: { scale: 0.9 } },
  { type: "deadtree", at: [-24, 1.8, 6], rot: 8, params: { scale: 0.7 } },

  // ── lush tropical undergrowth (decoration) ──
  { type: "tropplant", at: [-11, 0, 10], params: { scale: 1.2 } },
  { type: "tropplant", at: [11, 0, 10], params: { scale: 1.2 } },
  { type: "tropplant", at: [-16, 3.2, -14], params: { scale: 1.0 } },
  { type: "tropplant", at: [16, 3.2, -14], params: { scale: 1.0 } },
  { type: "leafplant", at: [-6, 0, 3] },
  { type: "leafplant", at: [6, 0, 2] },
  { type: "leafplant", at: [-3, 0, -8] },
  { type: "leafplant", at: [3, 0, -7] },
  { type: "fern", at: [-10, 0, 6], params: { scale: 1.4 } },
  { type: "fern", at: [10, 0, 6], params: { scale: 1.4 } },
  { type: "fern", at: [-2, 0, 11], params: { scale: 1.2 } },
  { type: "fern", at: [4, 0, 12], params: { scale: 1.2 } },
  { type: "fern", at: [-24, 1.8, 1], params: { scale: 1.0 } },
  { type: "fern", at: [24, 1.8, 1], params: { scale: 1.0 } },
  { type: "fern", at: [0, 1, -15], params: { scale: 1.1 } },
  { type: "shrub", at: [-20, 0, -6] },
  { type: "shrub", at: [20, 0, -6] },
  { type: "succulent", at: [-7, 0, -6] },
  { type: "succulent", at: [8, 0, -5] },

  // explosive barrels flanking the basin
  { type: "barrel", at: [-9, 0, 13] },
  { type: "barrel", at: [9, 0, 13] },
  { type: "lantern", at: [-16, 3.4, -15], params: { color: 0x9fd8a0, distance: 11 } },
  { type: "lantern", at: [16, 3.4, -15], params: { color: 0x9fd8a0, distance: 11 } },
];

const pickups: Tuple3[] = [
  [-16, 3.4, -15],   // left terrace top
  [16, 3.4, -15],    // right terrace top
  [-24, 2.0, 3.5],   // left side terrace
  [24, 2.0, 3.5],    // right side terrace
];

const powerups: Tuple3[] = [
  [0, 0.8, 0], [-14, 0.8, 10], [14, 0.8, 10], [0, 1.3, -15.5],
];

const spawns = [
  { at: [-12, 17] as [number, number], yaw: 0 },
  { at: [12, 17] as [number, number], yaw: 0 },
  { at: [0, 18] as [number, number], yaw: 0 },
  { at: [-25, 15] as [number, number], yaw: 20 },
  { at: [25, 15] as [number, number], yaw: -20 },
  { at: [0, 3] as [number, number], yaw: 0 },
  { at: [-15, 8] as [number, number], yaw: 45 },
  { at: [15, 8] as [number, number], yaw: -45 },
  { at: [-24, 15] as [number, number], yaw: 90 },
  { at: [24, 15] as [number, number], yaw: -90 },
];

export const WATERFALL: MapDef = {
  meta: { id: "waterfall", name: "Waterfall", theme: "Tropical jungle ravine" },
  env: {
    sky: { hdri: "hdri/epping_forest_02.hdr" },
    fog: { color: [0.52, 0.64, 0.55], start: 26, end: 95 },
    ambient: { color: [0.48, 0.62, 0.54], intensity: 0.72, specular: 0.75 },
    sun: { rot: [-58, -20, 0], color: [1.12, 1.2, 1.0], strength: 0.72 },
    water: [0, 0.4, 15],
  },
  textures: { floor: "wf_floor", wall: "wf_wall", stone: "wf_stone", dark: "wf_dark" },
  brushes,
  objects,
  spawns,
  pickups,
  powerups,
};
