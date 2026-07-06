// ─── Inspector: edit the selected object's transform + params, or the world ──
// Object params get a generic UI derived from the type's declared defaults, with
// smart widgets for well-known keys: model/clip/tex become drag-droppable asset
// fields with an inline preview. The "World" row edits the map's sky / lighting
// / effects.
import type { AssetCatalog, MapDef, Placement, Tuple3 } from "@slopwars/shared";
import { placeRot, placeScale } from "@slopwars/shared";
import { objectDefaults } from "@game/objects";
import type { ThumbRenderer } from "./preview";
import { state } from "./state";
import { assetField } from "./assetfield";
import { clear, el, numField, vecField, selectField, checkField, textField, renamable } from "./ui";

const AXES = ["x+", "x-", "z+", "z-"];

let catalog: AssetCatalog = { models: [], textures: [], audio: [], hdri: [] };
let thumbs: ThumbRenderer | null = null;
export function setInspectorCatalog(c: AssetCatalog): void { catalog = c; }
export function setInspectorThumbs(t: ThumbRenderer): void { thumbs = t; }

export function renderInspector(host: HTMLElement): void {
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }
  // each inspector edit is a discrete, undoable action → commit (records history)
  const touch = (): void => state.commit();
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
  const title = el("h3", "insp-title", o.name || o.type);
  renamable(title, () => o.name ?? "", (v) => { o.name = v || undefined; }, () => state.commit(true));
  host.append(title);
  const sub = o.name ? o.type + (subLabel(o) ? " · " + subLabel(o) : "") : subLabel(o);
  if (sub) host.append(el("div", "insp-sub", sub));

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
  const asset = (kind: "model" | "audio" | "texture"): HTMLElement =>
    assetField({ label: key, kind, catalog, thumbs, get: () => String(get() ?? ""), set: (v) => set(v), onChange: touch });
  // drag-droppable asset references with an inline preview
  if (key === "model") return asset("model");
  if (key === "clip") return asset("audio");
  if (key === "tex") return asset("texture");
  if (key === "axis") return selectField(key, AXES, () => String(get()), (v) => set(v), touch);
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
  head(host, "World", "Sky · lighting · effects");
  const e = map.env;

  group(host, "Map");
  host.append(textField("name", () => map.meta.name, (v) => (map.meta.name = v), touch));
  host.append(textField("theme", () => map.meta.theme, (v) => (map.meta.theme = v), touch));
  host.append(checkField("in rotation", () => map.meta.rotate !== false, (v) => (map.meta.rotate = v), touch));

  group(host, "Sky");
  host.append(selectField("hdri", ["", ...catalog.hdri.map((h) => `hdri/${h.name}.hdr`)],
    () => e.sky.hdri ?? "", (v) => (e.sky.hdri = v || undefined), () => state.commit(true)));
  if (!e.sky.solid) e.sky.solid = [0.05, 0.06, 0.08];
  host.append(vecField("solid rgb", e.sky.solid, touch, 0.02));

  group(host, "Ambient");
  host.append(vecField("color", e.ambient.color, touch, 0.02));
  host.append(numField("intensity", () => e.ambient.intensity, (v) => (e.ambient.intensity = v), touch, 0.05));

  group(host, "Sun");
  host.append(vecField("rotation", e.sun.rot, touch, 1));
  host.append(vecField("color", e.sun.color, touch, 0.02));
  host.append(numField("strength", () => e.sun.strength, (v) => (e.sun.strength = v), touch, 0.05));

  group(host, "Effects");
  host.append(checkField("fog", () => !!e.fog, (v) => {
    if (v && !e.fog) e.fog = { color: [0.7, 0.72, 0.75], start: 40, end: 150 };
    else if (!v) e.fog = null;
  }, () => state.commit(true)));
  if (e.fog) {
    host.append(vecField("fog color", e.fog.color, touch, 0.02));
    host.append(numField("fog start", () => e.fog!.start, (v) => (e.fog!.start = v), touch, 1));
    host.append(numField("fog end", () => e.fog!.end, (v) => (e.fog!.end = v), touch, 1));
  }
}
