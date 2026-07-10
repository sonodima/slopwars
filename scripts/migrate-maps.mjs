// One-shot: convert maps/*.json from the legacy shape (separate brushes /
// spawns / pickups / powerups arrays, rot-as-number) into the unified
// objects-only format (everything a Placement with a transform).
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("maps");

function normRot(o) {
  const rot = typeof o.rot === "number" ? [0, o.rot, 0] : o.rot;
  const out = { type: o.type, at: o.at };
  if (rot) out.rot = rot;
  if (o.scale) out.scale = o.scale;
  if (o.params) out.params = o.params;
  return out;
}

function migrate(raw) {
  if (Array.isArray(raw.objects) && !raw.brushes && !raw.spawns && !raw.pickups && !raw.powerups) {
    return { meta: raw.meta, env: raw.env, textures: raw.textures, objects: raw.objects.map(normRot) };
  }
  const objects = [];
  for (const b of raw.brushes ?? []) {
    if (b.k === "box") objects.push({ type: "box", at: b.at, scale: b.size, params: { mat: b.mat, tile: b.tile ?? [1, 1], solid: b.solid !== false } });
    else if (b.k === "water") objects.push({ type: "water", at: b.at, scale: [b.s, 1, b.s] });
    else if (b.k === "stairs") objects.push({ type: "stairs", at: b.at, params: { axis: b.axis, rise: b.rise, run: b.run, width: b.width, steps: b.steps ?? 8, mat: b.mat ?? "dark" } });
  }
  for (const o of raw.objects ?? []) objects.push(normRot(o));
  for (const s of raw.spawns ?? []) objects.push({ type: "spawn", at: [s.at[0], 0, s.at[1]], rot: [0, s.yaw, 0] });
  for (const p of raw.pickups ?? []) objects.push({ type: "pickup", at: p });
  for (const p of raw.powerups ?? []) objects.push({ type: "powerup", at: p });
  return { meta: raw.meta, env: raw.env, textures: raw.textures, objects };
}

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const p = path.join(dir, f);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const next = migrate(raw);
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
  console.log(`migrated ${f}: ${next.objects.length} objects`);
}
