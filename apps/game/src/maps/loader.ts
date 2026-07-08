// ─── Map loader: interpret a MapDef into a live world ────────────────────────
// A map is a flat list of object placements. Non-deferred objects (geometry,
// props, sounds, lights) build first; deferred markers (spawns/pickups/power-
// ups) build in a second pass, after all solids exist, so floor heights resolve.
// A placement in a group stores its transform in the group's local space, so we
// resolve each one to its world transform (composed up the group chain) before
// handing it to the builder — the game itself treats every object as world-space.
import { MapBuilder } from "../mapbuilder";
import { buildObject, isDeferredType } from "../objects";
import { MapDef, Placement, resolveWorld } from "./schema";

/** populate a GameMap (via its builder) from a MapDef. */
export function loadMapDef(b: MapBuilder, def: MapDef): void {
  const build = (o: Placement, i: number): void => {
    if (!o.group) { buildObject(b, o, i); return; }
    const w = resolveWorld(def, o);
    buildObject(b, { ...o, at: w.at, rot: w.rot, scale: w.scale }, i);
  };
  def.objects.forEach((o, i) => { if (!isDeferredType(o.type)) build(o, i); });
  def.objects.forEach((o, i) => { if (isDeferredType(o.type)) build(o, i); });
}
