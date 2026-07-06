// ─── Inspector: edit the selected object's transform + params, or the world ──
// Object params get a generic UI derived from the type's declared defaults, with
// smart widgets for well-known keys (mat/model/clip/axis). With nothing selected
// it edits the map's world settings (sky / lighting / texture palette).
import type { AssetCatalog, MapDef, Placement, Tuple3 } from "@slopwars/shared";
import { placeRot, placeScale } from "@slopwars/shared";
import { objectDefaults } from "@game/objects";
import { state } from "./state";
import { clear, el, numField, vecField, selectField, checkField, textField } from "./ui";

const MATS = ["wall", "floor", "crate", "metal", "stone", "dark"];
const AXES = ["x+", "x-", "z+", "z-"];

let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
export function setInspectorCatalog(c: AssetCatalog): void { catalog = c; }

export function renderInspector(host: HTMLElement): void {
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }
  const touch = (): void => state.touch();
  const o = state.selected();
  if (!o) return worldInspector(host, map, touch);
  objectInspector(host, o, touch);
}

function head(host: HTMLElement, title: string, sub?: string): void {
  host.append(el("h3", "insp-title", title));
  if (sub) host.append(el("div", "insp-sub", sub));
}
function group(host: HTMLElement, name: string): void { host.append(el("div", "insp-group", name)); }

// ── object ────────────────────────────────────────────────────────────────────
function objectInspector(host: HTMLElement, o: Placement, touch: () => void): void {
  head(host, o.type, subLabel(o));

  group(host, "Transform");
  host.append(vecField("Location", o.at, touch, 0.1));
  if (!o.rot) o.rot = placeRot(o).slice() as Tuple3;
  host.append(vecField("Rotation", o.rot, touch, 1));
  if (!o.scale) o.scale = placeScale(o).slice() as Tuple3;
  host.append(vecField("Scale", o.scale, touch, 0.05));

  const schema = objectDefaults(o.type);
  const keys = Object.keys(schema);
  if (keys.length) {
    group(host, "Details");
    const params = (o.params ??= {});
    for (const key of keys) host.append(paramField(key, schema[key], params, touch));
  }
}

function paramField(key: string, dflt: unknown, params: Record<string, unknown>, touch: () => void): HTMLElement {
  const get = (): unknown => (key in params ? params[key] : dflt);
  const set = (v: unknown): void => { params[key] = v; };
  // smart widgets for well-known keys
  if (key === "mat") return selectField(key, MATS, () => String(get()), (v) => set(v), touch);
  if (key === "axis") return selectField(key, AXES, () => String(get()), (v) => set(v), touch);
  if (key === "model") return selectField(key, ["", ...catalog.models.map((m) => m.name)], () => String(get() ?? ""), (v) => set(v), touch);
  if (key === "clip") return selectField(key, ["", ...catalog.audio.map((a) => a.name)], () => String(get() ?? ""), (v) => set(v), touch);
  if (Array.isArray(dflt)) { const arr = (get() as number[]).slice(); params[key] = arr; return vecField(key, arr, touch, 0.1); }
  if (typeof dflt === "number") return numField(key, () => get() as number, (v) => set(v), touch, 0.05);
  if (typeof dflt === "boolean") return checkField(key, () => get() as boolean, (v) => set(v), touch);
  return textField(key, () => String(get() ?? ""), (v) => set(v), touch);
}

function subLabel(o: Placement): string {
  if (o.type === "prop" && o.params?.model) return String(o.params.model);
  if (o.type === "sound" && o.params?.clip) return String(o.params.clip);
  return "";
}

// ── world / environment ─────────────────────────────────────────────────────
function worldInspector(host: HTMLElement, map: MapDef, touch: () => void): void {
  head(host, "World", "Select an object to edit it");
  const e = map.env;

  group(host, "Map");
  host.append(textField("name", () => map.meta.name, (v) => (map.meta.name = v), touch));
  host.append(textField("theme", () => map.meta.theme, (v) => (map.meta.theme = v), touch));

  group(host, "Sky");
  host.append(selectField("hdri", ["", ...catalog.hdri.map((h) => `hdri/${h.name}.hdr`)], () => e.sky.hdri ?? "", (v) => (e.sky.hdri = v || undefined), touch));
  if (!e.sky.solid) e.sky.solid = [0.05, 0.06, 0.08];
  host.append(vecField("solid rgb", e.sky.solid, touch, 0.02));

  group(host, "Ambient");
  host.append(vecField("color", e.ambient.color, touch, 0.02));
  host.append(numField("intensity", () => e.ambient.intensity, (v) => (e.ambient.intensity = v), touch, 0.05));

  group(host, "Sun");
  host.append(vecField("rotation", e.sun.rot, touch, 1));
  host.append(vecField("color", e.sun.color, touch, 0.02));
  host.append(numField("strength", () => e.sun.strength, (v) => (e.sun.strength = v), touch, 0.05));

  group(host, "Texture palette");
  const tex = (map.textures ??= {});
  const names = ["", ...catalog.textures.map((t) => t.name)];
  for (const slot of MATS) {
    host.append(selectField(slot, names, () => (tex as Record<string, string>)[slot] ?? "", (v) => {
      if (v) (tex as Record<string, string>)[slot] = v; else delete (tex as Record<string, string>)[slot];
    }, touch));
  }
}
