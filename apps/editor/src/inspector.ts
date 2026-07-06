// ─── Inspector: edit the selected item's properties ──────────────────────────
// Env, brushes, spawns/pickups/powerups have fixed schemas; object placements
// get a *generic* property UI derived from the registry's declared defaults —
// so a new object type's params become editable with zero editor changes.
import type { BoxBrush, MapDef, StairBrush, WaterBrush } from "@slopwars/shared";
import { objectDefaults } from "@game/objects";
import { state } from "./state";
import { clear, el, numField, vec3Field, selectField, checkField, textField } from "./ui";

const MATS = ["wall", "floor", "crate", "metal", "stone", "dark"];
const AXES = ["x+", "x-", "z+", "z-"];

export function renderInspector(host: HTMLElement, onEdit: () => void): void {
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }
  const touch = (): void => { state.touch(); onEdit(); };

  switch (state.sel.kind) {
    case "env": return envInspector(host, map, touch);
    case "brush": return brushInspector(host, map, state.sel.index, touch);
    case "object": return objectInspector(host, map, state.sel.index, touch);
    case "spawn": return spawnInspector(host, map, state.sel.index, touch);
    case "pickup": return pointInspector(host, map.pickups[state.sel.index], "Pickup", touch);
    case "powerup": return pointInspector(host, map.powerups[state.sel.index], "Power-up", touch);
    default: host.append(el("div", "empty", "Select something in the scene graph"));
  }
}

function head(host: HTMLElement, title: string): void { host.append(el("h3", "insp-title", title)); }

function envInspector(host: HTMLElement, map: MapDef, touch: () => void): void {
  head(host, "Environment");
  const e = map.env;
  host.append(el("div", "insp-group", "Meta"));
  host.append(textField("name", () => map.meta.name, (v) => (map.meta.name = v), touch));
  host.append(textField("theme", () => map.meta.theme, (v) => (map.meta.theme = v), touch));

  host.append(el("div", "insp-group", "Sky"));
  host.append(textField("hdri", () => e.sky.hdri ?? "", (v) => (e.sky.hdri = v || undefined), touch));
  if (!e.sky.solid) e.sky.solid = [0.06, 0.07, 0.09];
  host.append(vec3Field("solid rgb", e.sky.solid, touch, 0.02));

  host.append(el("div", "insp-group", "Ambient"));
  host.append(vec3Field("color", e.ambient.color, touch, 0.02));
  host.append(numField("intensity", () => e.ambient.intensity, (v) => (e.ambient.intensity = v), touch, 0.05));

  host.append(el("div", "insp-group", "Sun"));
  host.append(vec3Field("rotation", e.sun.rot, touch, 1));
  host.append(vec3Field("color", e.sun.color, touch, 0.02));
  host.append(numField("strength", () => e.sun.strength, (v) => (e.sun.strength = v), touch, 0.05));

  host.append(el("div", "insp-group", "Texture palette (slot → folder)"));
  const tex = (map.textures ??= {});
  for (const slot of MATS) {
    host.append(textField(slot, () => (tex as Record<string, string>)[slot] ?? "", (v) => {
      if (v) (tex as Record<string, string>)[slot] = v; else delete (tex as Record<string, string>)[slot];
    }, touch));
  }
}

function brushInspector(host: HTMLElement, map: MapDef, i: number, touch: () => void): void {
  const b = map.brushes[i]; if (!b) return;
  head(host, `Brush · ${b.k}`);
  host.append(vec3Field("at", b.at, touch));
  if (b.k === "box") {
    const box = b as BoxBrush;
    host.append(vec3Field("size", box.size, touch));
    host.append(selectField("material", MATS, () => box.mat, (v) => (box.mat = v as BoxBrush["mat"]), touch));
    if (!box.tile) box.tile = [1, 1];
    host.append(vec3Field("tile (u,v)", box.tile as unknown as number[], touch, 0.1));
    host.append(checkField("solid", () => box.solid !== false, (v) => (box.solid = v), touch));
  } else if (b.k === "water") {
    const w = b as WaterBrush;
    host.append(numField("size", () => w.s, (v) => (w.s = v), touch));
  } else if (b.k === "stairs") {
    const s = b as StairBrush;
    host.append(selectField("axis", AXES, () => s.axis, (v) => (s.axis = v as StairBrush["axis"]), touch));
    host.append(numField("rise", () => s.rise, (v) => (s.rise = v), touch));
    host.append(numField("run", () => s.run, (v) => (s.run = v), touch));
    host.append(numField("width", () => s.width, (v) => (s.width = v), touch));
    host.append(numField("steps", () => s.steps ?? 8, (v) => (s.steps = Math.max(1, Math.round(v))), touch, 1));
    host.append(selectField("material", MATS, () => s.mat ?? "dark", (v) => (s.mat = v as StairBrush["mat"]), touch));
  }
}

function objectInspector(host: HTMLElement, map: MapDef, i: number, touch: () => void): void {
  const o = map.objects[i]; if (!o) return;
  head(host, `Object · ${o.type}`);
  host.append(vec3Field("at", o.at, touch));
  host.append(numField("yaw°", () => o.rot ?? 0, (v) => (o.rot = v), touch, 1));

  // generic params from the type's declared defaults (the property schema)
  const schema = objectDefaults(o.type);
  const params = (o.params ??= {});
  host.append(el("div", "insp-group", "Params"));
  const keys = Object.keys(schema);
  if (keys.length === 0) { host.append(el("div", "empty", "no params")); return; }
  for (const key of keys) {
    const dflt = schema[key];
    const cur = (): unknown => (key in params ? (params as Record<string, unknown>)[key] : dflt);
    if (typeof dflt === "number") {
      host.append(numField(key, () => cur() as number, (v) => ((params as Record<string, unknown>)[key] = v), touch, 0.05));
    } else if (typeof dflt === "boolean") {
      host.append(checkField(key, () => cur() as boolean, (v) => ((params as Record<string, unknown>)[key] = v), touch));
    } else {
      host.append(textField(key, () => String(cur() ?? ""), (v) => ((params as Record<string, unknown>)[key] = v), touch));
    }
  }
}

function spawnInspector(host: HTMLElement, map: MapDef, i: number, touch: () => void): void {
  const s = map.spawns[i]; if (!s) return;
  head(host, `Spawn ${i}`);
  host.append(vec3Field("at (x,z)", s.at as unknown as number[], touch));
  host.append(numField("yaw°", () => s.yaw, (v) => (s.yaw = v), touch, 5));
}

function pointInspector(host: HTMLElement, p: number[] | undefined, title: string, touch: () => void): void {
  if (!p) return;
  head(host, title);
  host.append(vec3Field("at", p, touch));
}
