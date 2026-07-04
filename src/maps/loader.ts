// ─── Map loader: interpret a MapDef into a live world ────────────────────────
// Brushes → geometry/collision, placements → registry objects, then spawns/
// pickups/powerups. Runs entirely through MapBuilder so maps stay data-only.
import { MapBuilder } from "../mapbuilder";
import { buildObject } from "../objects";
import { MapDef } from "./schema";

/** populate a GameMap (via its builder) from a MapDef. Solids are built before
 *  spawns so floor heights resolve correctly. */
export function loadMapDef(b: MapBuilder, def: MapDef): void {
  const T = b.tex;
  const matOf = { wall: T.wall, floor: T.floor, crate: T.crate, metal: T.metal, stone: T.stone, dark: T.dark };

  // ── structural brushes ──
  for (const br of def.brushes) {
    if (br.k === "box") {
      const [tu, tv] = br.tile ?? [1, 1];
      b.box(br.at[0], br.at[1], br.at[2], br.size[0], br.size[1], br.size[2], matOf[br.mat], tu, tv, br.solid !== false);
    } else if (br.k === "water") {
      b.water(br.at[0], br.at[1], br.at[2], br.s);
    } else if (br.k === "stairs") {
      b.stairs(br.at, br.axis, br.rise, br.run, br.width, matOf[br.mat ?? "dark"], br.steps ?? 8);
    }
  }

  // ── named objects (props + interactive) ──
  for (const o of def.objects) buildObject(b, o.type, o.at, o.rot, o.params);

  // ── spawns (resolve floor height) / pickups / powerups ──
  const map = b.map;
  for (const s of def.spawns) {
    map.spawns.push({ p: { x: s.at[0], y: map.floorY(s.at[0], s.at[1]) + 0.05, z: s.at[1] }, yaw: s.yaw });
  }
  for (const p of def.pickups) map.pickupSpots.push({ x: p[0], y: p[1], z: p[2] });
  for (const p of def.powerups) map.powerupSpots.push({ x: p[0], y: p[1], z: p[2] });
}
