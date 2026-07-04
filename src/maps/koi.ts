// ─── "Koi" — the original Kasbah courtyard, ported to the MapDef format ───────
// Bounds: x ∈ [-30,30], z ∈ [-22,22]. north = -z. Faithful 1:1 of the former
// hard-coded GameMap.build(). Serves as the reference map + format worked example.
import { Brush, MapDef, Placement, Tuple3 } from "./schema";

const H = 6; // outer wall height

const brushes: Brush[] = [
  // ── ground + outer walls + cornice ledges ──
  { k: "box", at: [0, -0.5, 0], size: [64, 1, 48], mat: "floor", tile: [16, 12] },
  { k: "box", at: [0, H / 2, -22.6], size: [62, H, 1.2], mat: "wall", tile: [12, 1.2] },
  { k: "box", at: [0, H / 2, 22.6], size: [62, H, 1.2], mat: "wall", tile: [12, 1.2] },
  { k: "box", at: [-30.6, H / 2, 0], size: [1.2, H, 46], mat: "wall", tile: [9, 1.2] },
  { k: "box", at: [30.6, H / 2, 0], size: [1.2, H, 46], mat: "wall", tile: [9, 1.2] },
  { k: "box", at: [0, 5.6, -21.85], size: [62, 0.35, 0.5], mat: "stone", tile: [12, 0.2] },
  { k: "box", at: [0, 5.6, 21.85], size: [62, 0.35, 0.5], mat: "stone", tile: [12, 0.2] },
  { k: "box", at: [-29.85, 5.6, 0], size: [0.5, 0.35, 46], mat: "stone", tile: [9, 0.2] },
  { k: "box", at: [29.85, 5.6, 0], size: [0.5, 0.35, 46], mat: "stone", tile: [9, 0.2] },

  // ── courtyard dividers z = ±13, framed double doorways at x = ±7 ──
  // (loop over zs = -13, 13 expanded to data)
  { k: "box", at: [-10.6, 2, -13], size: [4.8, 4, 0.9], mat: "wall", tile: [1.4, 0.8] },
  { k: "box", at: [0, 2, -13], size: [11.6, 4, 0.9], mat: "wall", tile: [3.3, 0.8] },
  { k: "box", at: [10.6, 2, -13], size: [4.8, 4, 0.9], mat: "wall", tile: [1.4, 0.8] },
  { k: "box", at: [-8.2, 1.35, -13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [-5.8, 1.35, -13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [-7, 3.35, -13], size: [2.9, 1.3, 1.1], mat: "stone", tile: [0.9, 0.45] },
  { k: "box", at: [5.8, 1.35, -13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [8.2, 1.35, -13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [7, 3.35, -13], size: [2.9, 1.3, 1.1], mat: "stone", tile: [0.9, 0.45] },
  { k: "box", at: [0, 4.15, -13], size: [26, 0.5, 1.2], mat: "stone", tile: [6, 0.25] },
  { k: "box", at: [-10.6, 2, 13], size: [4.8, 4, 0.9], mat: "wall", tile: [1.4, 0.8] },
  { k: "box", at: [0, 2, 13], size: [11.6, 4, 0.9], mat: "wall", tile: [3.3, 0.8] },
  { k: "box", at: [10.6, 2, 13], size: [4.8, 4, 0.9], mat: "wall", tile: [1.4, 0.8] },
  { k: "box", at: [-8.2, 1.35, 13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [-5.8, 1.35, 13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [-7, 3.35, 13], size: [2.9, 1.3, 1.1], mat: "stone", tile: [0.9, 0.45] },
  { k: "box", at: [5.8, 1.35, 13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [8.2, 1.35, 13], size: [0.3, 2.7, 1.1], mat: "stone", tile: [0.25, 0.9] },
  { k: "box", at: [7, 3.35, 13], size: [2.9, 1.3, 1.1], mat: "stone", tile: [0.9, 0.45] },
  { k: "box", at: [0, 4.15, 13], size: [26, 0.5, 1.2], mat: "stone", tile: [6, 0.25] },

  // ── fountain (center) ──
  { k: "box", at: [0, 0.3, -1.95], size: [4.2, 0.6, 0.5], mat: "stone", tile: [1.4, 0.25] },
  { k: "box", at: [0, 0.3, 1.95], size: [4.2, 0.6, 0.5], mat: "stone", tile: [1.4, 0.25] },
  { k: "box", at: [-1.95, 0.3, 0], size: [0.5, 0.6, 3.4], mat: "stone", tile: [0.25, 1.2] },
  { k: "box", at: [1.95, 0.3, 0], size: [0.5, 0.6, 3.4], mat: "stone", tile: [0.25, 1.2] },
  { k: "water", at: [0, 0.42, 0], s: 3.3 },
  { k: "box", at: [0, 0.7, 0], size: [0.9, 1.4, 0.9], mat: "stone", tile: [0.4, 0.6] },

  // ── west building (arcade) + rooftop route ──
  { k: "box", at: [-22.3, 1.7, -9.9], size: [0.9, 3.4, 6.2], mat: "wall", tile: [1.8, 0.9] },
  { k: "box", at: [-22.3, 1.7, -1.0], size: [0.9, 3.4, 8.4], mat: "wall", tile: [2.4, 0.9] },
  { k: "box", at: [-22.3, 1.7, 8.9], size: [0.9, 3.4, 8.2], mat: "wall", tile: [2.4, 0.9] },
  { k: "box", at: [-17.5, 1.7, -13], size: [8.6, 3.4, 0.9], mat: "wall", tile: [2.5, 0.9] },
  { k: "box", at: [-17.5, 1.7, 13], size: [8.6, 3.4, 0.9], mat: "wall", tile: [2.5, 0.9] },
  { k: "box", at: [-13.2, 3.15, 0], size: [0.7, 0.5, 26], mat: "stone", tile: [0.2, 7] },
  { k: "box", at: [-17.75, 3.6, 0], size: [10, 0.4, 26], mat: "dark", tile: [3, 7] },
  { k: "box", at: [-13.05, 4.15, -4], size: [0.4, 0.7, 18.5], mat: "stone", tile: [0.15, 5] },
  { k: "stairs", at: [-11.4, 0, 12.2], axis: "z-", rise: 3.8, run: 6.2, width: 2.1 },
  { k: "box", at: [-11.75, 3.6, 5.2], size: [3.5, 0.4, 1.8], mat: "dark", tile: [1, 0.5] },

  // ── east building interior room ──
  { k: "box", at: [13.3, 1.7, -8.25], size: [0.9, 3.4, 5.5], mat: "wall", tile: [1.8, 0.9] },
  { k: "box", at: [13.3, 1.7, -0.9], size: [0.9, 3.4, 3.8], mat: "wall", tile: [1.2, 0.9] },
  { k: "box", at: [13.3, 3, -4.2], size: [1.02, 0.8, 2.8], mat: "stone", tile: [0.9, 0.3] },
  { k: "box", at: [18.5, 1.7, -11.3], size: [11.3, 3.4, 0.9], mat: "wall", tile: [3, 0.9] },
  { k: "box", at: [24.3, 1.7, -8.55], size: [0.9, 3.4, 5.5], mat: "wall", tile: [1.6, 0.9] },
  { k: "box", at: [24.3, 1.7, -1.75], size: [0.9, 3.4, 4.9], mat: "wall", tile: [1.4, 0.9] },
  { k: "box", at: [15.5, 1.7, 0.7], size: [5.3, 3.4, 0.9], mat: "wall", tile: [1.6, 0.9] },
  { k: "box", at: [22.5, 1.7, 0.7], size: [3.9, 3.4, 0.9], mat: "wall", tile: [1.2, 0.9] },
  { k: "box", at: [19.8, 3, 0.7], size: [2.8, 0.8, 1.02], mat: "stone", tile: [0.9, 0.3] },
  { k: "box", at: [18.75, 3.6, -5.3], size: [11.9, 0.4, 12.9], mat: "dark", tile: [3, 3] },
  { k: "box", at: [13.1, 3.95, -5.3], size: [0.4, 0.35, 12.9], mat: "stone", tile: [0.15, 3] },
  { k: "box", at: [18.75, 3.95, -11.55], size: [11.9, 0.35, 0.4], mat: "stone", tile: [3, 0.15] },
  { k: "box", at: [18, 0.45, -8.5], size: [2.6, 0.9, 1.2], mat: "crate", tile: [0.9, 0.4] },

  // ── east balcony over alley + side-yard stairs ──
  { k: "box", at: [24.3, 1.5, 4.35], size: [0.9, 3, 6.1], mat: "wall", tile: [1.8, 0.8] },
  { k: "box", at: [24.3, 1.5, 11.25], size: [0.9, 3, 2.9], mat: "wall", tile: [0.9, 0.8] },
  { k: "box", at: [27.35, 3.2, 3.5], size: [6.9, 0.4, 11], mat: "dark", tile: [2, 3] },
  { k: "box", at: [24.3, 3.85, 2.7], size: [0.4, 0.9, 9.4], mat: "stone", tile: [0.12, 3] },
  { k: "box", at: [27.35, 3.85, 9.2], size: [6.9, 0.9, 0.4], mat: "stone", tile: [2, 0.12] },
  { k: "stairs", at: [17.6, 0, 8.6], axis: "x+", rise: 3.4, run: 6.4, width: 2.4 },
];

const objects: Placement[] = [
  // west arcade windows + colonnade + lamps
  { type: "window", at: [-22.3, 0, -6] },
  { type: "window", at: [-22.3, 0, 4] },
  { type: "column", at: [-13.2, 0, -10.5] },
  { type: "column", at: [-13.2, 0, -7] },
  { type: "column", at: [-13.2, 0, -3.5] },
  { type: "column", at: [-13.2, 0, 0] },
  { type: "column", at: [-13.2, 0, 3.5] },
  { type: "column", at: [-13.2, 0, 7] },
  { type: "column", at: [-13.2, 0, 10.5] },
  { type: "lantern", at: [-13.6, 2.7, -7] },
  { type: "lantern", at: [-13.6, 2.7, 7] },

  // east room: door awning, window, pallets, lamp
  { type: "awning", at: [12.4, 2.6, -4.2] },
  { type: "window", at: [24.3, 0, -5], params: { east: true } },
  { type: "pallet", at: [21.5, 0, -2] },
  { type: "pallet", at: [15.5, 0, -9.5] },
  { type: "lantern", at: [18.5, 2.9, -5] },

  // balcony lamp
  { type: "lantern", at: [27.3, 2.5, -6] },

  // market stalls
  { type: "stall", at: [8.5, 0, -6.5] },
  { type: "stall", at: [8.5, 0, 5.5] },

  // sandbags (courtyard west)
  { type: "sandbags", at: [-7.5, 0, -1.5], params: { rot: 0 } },
  { type: "sandbags", at: [-7.9, 0, 0], params: { rot: 1 } },
  { type: "sandbags", at: [-7.5, 0, 1.5], params: { rot: 0 } },
  { type: "sandbags", at: [-6.2, 0, -0.8], params: { rot: 1 } },

  // plaza props
  { type: "crate", at: [-3, 0, -17] },
  { type: "crate", at: [-3, 1.6, -17], params: { size: 1.1 } },
  { type: "crate", at: [-4.7, 0, -16.2] },
  { type: "crate", at: [4, 0, 17.5] },
  { type: "crate", at: [4, 1.6, 17.5], params: { size: 1.1 } },
  { type: "crate", at: [5.8, 0, 16.8] },
  { type: "crate", at: [26.5, 0, -17] },
  { type: "crate", at: [-26.5, 0, 17] },
  { type: "barrel", at: [-27.5, 0, -15] },
  { type: "barrel", at: [-26.3, 0, -15.4] },
  { type: "barrel", at: [27.6, 0, 15.2] },
  { type: "barrel", at: [11.8, 0, -1] },
  { type: "barrel", at: [11.8, 0, 0.4] },
  { type: "planter", at: [-26, 0, -20] },
  { type: "planter", at: [26, 0, 20] },
  { type: "planter", at: [-3.5, 0, 10.5] },
  { type: "planter", at: [3.5, 0, -10.5] },
  { type: "pallet", at: [-15, 0, -16] },
  { type: "pallet", at: [14, 0, 18.5] },

  // vegetation (rests on floor at its x/z)
  { type: "shrub", at: [-8.6, 0, -2.2] },
  { type: "succulent", at: [-6.4, 0, 2.1] },
  { type: "succulent", at: [9.2, 0, -9.3] },
  { type: "shrub", at: [9.4, 0, 9.1] },
  { type: "shrub", at: [-27.2, 0, -19] },
  { type: "shrub", at: [27.2, 0, 19] },
  { type: "succulent", at: [-3.6, 0, 10.6] },
  { type: "succulent", at: [3.6, 0, -10.6] },
  { type: "shrub", at: [11.6, 0, 1.1] },
  { type: "succulent", at: [-24.2, 0, 15.3] },
  { type: "succulent", at: [26.6, 0, -17.4] },
  { type: "shrub", at: [-15.4, 0, -15.8] },
];

const pickups: Tuple3[] = [
  [0, 1.75, 0],       // fountain plinth
  [-17.5, 4.3, -1],   // west roof
  [18.5, 0.55, -5],   // east room floor
  [27.3, 3.95, 0],    // east balcony
];

const powerups: Tuple3[] = [
  [0, 0.8, -8], [0, 0.8, 8], [-17.75, 4.1, 5], [18.75, 4.1, -8],
];

const spawns = [
  { at: [0, -18] as [number, number], yaw: 180 },
  { at: [-13, -17.5] as [number, number], yaw: 150 },
  { at: [13, -17.5] as [number, number], yaw: 210 },
  { at: [-24, -18] as [number, number], yaw: 135 },
  { at: [24, -18] as [number, number], yaw: 225 },
  { at: [0, 18] as [number, number], yaw: 0 },
  { at: [-13, 17.5] as [number, number], yaw: 30 },
  { at: [13, 17.5] as [number, number], yaw: -30 },
  { at: [-24, 18] as [number, number], yaw: 45 },
  { at: [24, 18] as [number, number], yaw: -45 },
  { at: [-26.5, 0] as [number, number], yaw: 180 },
  { at: [27.3, -8] as [number, number], yaw: 0 },
];

export const KOI: MapDef = {
  meta: { id: "koi", name: "Koi", theme: "Sunlit kasbah courtyard" },
  env: {
    sky: { hdri: "hdri/sky.hdr" },
    fog: { color: [0.78, 0.74, 0.66], start: 40, end: 150 },
    ambient: { color: [0.55, 0.6, 0.72], intensity: 0.62, specular: 0.85 },
    sun: { rot: [-52, -38, 0], color: [1.35, 1.22, 1.0], strength: 0.82 },
    water: [0, 0.4, 0],
  },
  brushes,
  objects,
  spawns,
  pickups,
  powerups,
};
