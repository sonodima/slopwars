// One-shot: convert the old per-model prop object types (crate, chair, tree, …)
// into the generic `prop` object with `model` set to the real model folder name.
// These wrapper types were removed from objects.ts — a prop is now just a model
// placement (see the "no aliasing" cleanup). rot/scale/params are preserved;
// non-solid props carry solid:false. Idempotent: leaves already-`prop` objects be.
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("maps");

// removed prop type → [model folder, solid]
const PROP = {
  crate: ["old_military_crate", true],
  crate2: ["plastic_crate_01", true],
  rockset: ["rock_moss_set_01", true],
  boulder: ["namaqualand_boulder_04", true],
  fern: ["fern_02", false],
  stump: ["tree_stump_01", true],
  dtree: ["quiver_tree_01", true],
  deadtree: ["dead_tree_trunk", true],
  toolbox: ["metal_toolbox", true],
  desk: ["metal_office_desk", true],
  chair: ["SchoolChair_01", false],
  pplant: ["potted_plant_01", true],
  cabinet: ["drawer_cabinet", true],
  sofa: ["Sofa_01", true],
  bookshelf: ["wooden_bookshelf_worn", true],
  trashcan: ["metal_trash_can", true],
  extinguisher: ["korean_fire_extinguisher_01", false],
  cofftable: ["modern_coffee_table_01", true],
  cardbox: ["cardboard_box_01", true],
  pplant2: ["potted_plant_02", true],
  clock: ["wall_clock", false],
  tree: ["island_tree_01", true],
  tree2: ["island_tree_02", true],
  cliff: ["coastal_cliff_04", false],
  rockset2: ["rock_moss_set_02", true],
  tropplant: ["pachira_aquatica_01", true],
  leafplant: ["calathea_orbifolia_01", false],
};

function convert(o) {
  const entry = PROP[o.type];
  if (!entry) return o;
  const [model, solid] = entry;
  const params = { ...(o.params ?? {}) };
  // legacy numeric `scale` multiplier: fold it into the transform scale so the
  // generic prop (which has no scale param) looks identical.
  if (typeof params.scale === "number") {
    const m = params.scale;
    const s = o.scale ?? [1, 1, 1];
    o.scale = [s[0] * m, s[1] * m, s[2] * m];
    delete params.scale;
  }
  params.model = model;
  if (!solid) params.solid = false;
  const out = { type: "prop", at: o.at };
  if (o.name) out.name = o.name;
  if (o.rot) out.rot = o.rot;
  if (o.scale) out.scale = o.scale;
  out.params = params;
  if (o.group) out.group = o.group;
  return out;
}

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const p = path.join(dir, f);
  const def = JSON.parse(fs.readFileSync(p, "utf8"));
  let n = 0;
  def.objects = def.objects.map((o) => { const c = convert(o); if (c !== o) n++; return c; });
  fs.writeFileSync(p, JSON.stringify(def, null, 2) + "\n");
  console.log(`${f}: converted ${n} props`);
}
