// ─── Inspector: edit the selected object's transform + params, or the world ──
// Object params get a generic UI derived from the type's declared defaults, with
// smart widgets for well-known keys: model/clip/tex become drag-droppable asset
// fields with an inline preview. The "World" row edits the map's sky / lighting
// / effects.
import type { AssetCatalog, FogFalloff, MapDef, Placement, ShadowQuality, ToneMode, Tuple3 } from "@slopwars/shared";
import { envPost, envShadows, placeRot, placeScale } from "@slopwars/shared";
import { objectDefaults } from "@game/objects";
import type { ThumbRenderer } from "./preview";
import { state } from "./state";
import { assetField } from "./assetfield";
import { clear, el, numField, vecField, selectField, checkField, textField, colorField, renamable } from "./ui";

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
  if (key === "color") { const arr = (get() as number[]).slice(); params[key] = arr; return colorField(key, arr, touch); }
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
/** map a stored sky path ("hdri/sky.hdr") to its catalog asset name ("sky") */
function hdriName(path: string | undefined): string {
  if (!path) return "";
  const h = catalog.hdri.find((x) => x.file === path);
  return h ? h.name : path.replace(/^.*\//, "").replace(/\.(hdr|exr)$/i, "");
}
/** map a catalog asset name back to the path stored on the map's env */
function hdriPath(name: string): string {
  return catalog.hdri.find((x) => x.name === name)?.file ?? `hdri/${name}.hdr`;
}

function worldInspector(host: HTMLElement, map: MapDef, touch: () => void): void {
  head(host, "World", "Sky · lighting · shadows · fog · post");
  const e = map.env;

  group(host, "Map");
  host.append(textField("name", () => map.meta.name, (v) => (map.meta.name = v), touch));
  host.append(textField("theme", () => map.meta.theme, (v) => (map.meta.theme = v), touch));
  host.append(checkField("in rotation", () => map.meta.rotate !== false, (v) => (map.meta.rotate = v), touch));

  group(host, "Sky");
  // HDRI is a drag-droppable asset slot (drop from the Skyboxes browser, or click
  // to pick) with a live preview of the sky. Stored as a path; shown by name.
  host.append(assetField({
    label: "hdri", kind: "hdri", catalog, thumbs,
    get: () => hdriName(e.sky.hdri),
    set: (v) => { e.sky.hdri = v ? hdriPath(v) : undefined; },
    onChange: () => state.commit(true),
  }));
  if (!e.sky.solid) e.sky.solid = [0.05, 0.06, 0.08];
  host.append(vecField("solid rgb", e.sky.solid, touch, 0.02));

  group(host, "Sun");
  host.append(vecField("direction", e.sun.rot, touch, 1));
  host.append(vecField("color", e.sun.color, touch, 0.02));
  host.append(numField("brightness", () => e.sun.intensity ?? 1, (v) => (e.sun.intensity = Math.max(0, v)), touch, 0.05));

  group(host, "Ambient");
  host.append(vecField("color", e.ambient.color, touch, 0.02));
  host.append(numField("intensity", () => e.ambient.intensity, (v) => (e.ambient.intensity = Math.max(0, v)), touch, 0.05));
  host.append(numField("reflections", () => e.ambient.specular ?? 0.85, (v) => (e.ambient.specular = Math.max(0, v)), touch, 0.05));

  group(host, "Shadows");
  const sh = envShadows(e);
  host.append(selectField("quality", ["off", "low", "medium", "high", "ultra"],
    () => sh.quality, (v) => { (e.shadows ??= {}).quality = v as ShadowQuality; }, () => state.commit(true)));
  if (sh.quality !== "off") {
    host.append(numField("strength", () => envShadows(e).strength, (v) => { (e.shadows ??= {}).strength = clamp01(v); }, touch, 0.02));
    host.append(numField("distance", () => envShadows(e).distance, (v) => { (e.shadows ??= {}).distance = Math.max(1, v); }, touch, 5));
  }

  group(host, "Fog");
  host.append(checkField("enabled", () => !!e.fog, (v) => {
    if (v && !e.fog) e.fog = { color: [0.7, 0.72, 0.75], start: 40, end: 150 };
    else if (!v) e.fog = null;
  }, () => state.commit(true)));
  if (e.fog) {
    const fog = e.fog;
    host.append(selectField("falloff", ["linear", "exp", "exp2"], () => fog.falloff ?? "linear",
      (v) => (fog.falloff = v as FogFalloff), () => state.commit(true)));
    host.append(vecField("color", fog.color, touch, 0.02));
    if ((fog.falloff ?? "linear") === "linear") {
      host.append(numField("start", () => fog.start, (v) => (fog.start = v), touch, 1));
      host.append(numField("end", () => fog.end, (v) => (fog.end = v), touch, 1));
    } else {
      host.append(numField("density", () => fog.density ?? 0.015, (v) => (fog.density = Math.max(0, v)), touch, 0.002));
    }
  }

  group(host, "Post");
  const post = envPost(e);
  host.append(selectField("tonemapping", ["aces", "neutral", "none"], () => post.tonemapping,
    (v) => { (e.post ??= {}).tonemapping = v as ToneMode; }, touch));
  host.append(checkField("bloom", () => envPost(e).bloom.enabled,
    (v) => { ((e.post ??= {}).bloom ??= {}).enabled = v; }, () => state.commit(true)));
  if (post.bloom.enabled) {
    host.append(numField("bloom intensity", () => envPost(e).bloom.intensity,
      (v) => { ((e.post ??= {}).bloom ??= {}).intensity = Math.max(0, v); }, touch, 0.05));
    host.append(numField("bloom threshold", () => envPost(e).bloom.threshold,
      (v) => { ((e.post ??= {}).bloom ??= {}).threshold = Math.max(0, v); }, touch, 0.05));
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
