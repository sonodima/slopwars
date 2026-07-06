// ─── Map loader: interpret a MapDef into a live world ────────────────────────
// A map is a flat list of object placements. Non-deferred objects (geometry,
// props, sounds, lights) build first; deferred markers (spawns/pickups/power-
// ups) build in a second pass, after all solids exist, so floor heights resolve.
import { MapBuilder } from "../mapbuilder";
import { buildObject, isDeferredType } from "../objects";
import { MapDef } from "./schema";

/** populate a GameMap (via its builder) from a MapDef. */
export function loadMapDef(b: MapBuilder, def: MapDef): void {
  def.objects.forEach((o, i) => { if (!isDeferredType(o.type)) buildObject(b, o, i); });
  def.objects.forEach((o, i) => { if (isDeferredType(o.type)) buildObject(b, o, i); });
}
