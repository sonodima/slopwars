// ─── Map loader: interpret a MapDef into a live world ────────────────────────
// A map is a flat list of object placements. Non-deferred objects (geometry,
// props, sounds, lights) build first; deferred markers (spawns/pickups/power-
// ups) build in a second pass, after all solids exist, so floor heights resolve.
// A placement in a group stores its transform in the group's local space, so we
// resolve each one to its world transform (composed up the group chain) before
// handing it to the builder — the game itself treats every object as world-space.
//
// One exception: a group flagged `physics` becomes a single movable rigid body.
// Its members (recursively) are built under one dynamic-body entity and simulated
// together (a lantern = mesh + light, a crate stack…), so they never take the
// per-object static path.
import { MapBuilder } from "../mapbuilder";
import { buildObject, isDeferredType } from "../objects";
import { MapDef, Placement, Tuple3, groupMembers, groupWorldTf, resolveWorld, topPhysicsGroups } from "./schema";

/** populate a GameMap (via its builder) from a MapDef. */
export function loadMapDef(b: MapBuilder, def: MapDef): void {
  // groups simulated as one body — build their members under a dynamic body and
  // claim them so the normal per-object passes skip them.
  const claimed = new Set<Placement>();
  for (const g of topPhysicsGroups(def)) {
    const members = groupMembers(def, g.id);
    for (const o of members) claimed.add(o);
    const origin = groupWorldTf(def, g.id).at;
    b.beginGroupBody(origin);
    for (const o of members) {
      if (isDeferredType(o.type)) continue;   // markers don't belong to a moving body
      const w = resolveWorld(def, o);
      const at: Tuple3 = [w.at[0] - origin[0], w.at[1] - origin[1], w.at[2] - origin[2]];
      buildObject(b, { ...o, at, rot: w.rot, scale: w.scale }, def.objects.indexOf(o));
    }
    b.endGroupBody(g, origin);
  }

  const build = (o: Placement, i: number): void => {
    if (!o.group) { buildObject(b, o, i); return; }
    const w = resolveWorld(def, o);
    buildObject(b, { ...o, at: w.at, rot: w.rot, scale: w.scale }, i);
  };
  def.objects.forEach((o, i) => { if (!claimed.has(o) && !isDeferredType(o.type)) build(o, i); });
  def.objects.forEach((o, i) => { if (!claimed.has(o) && isDeferredType(o.type)) build(o, i); });
}
