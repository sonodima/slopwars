// ─── Inspector: edit the selected object/group/asset, or the world ───────────
// Object params get a generic UI derived from the type's declared defaults, with
// smart widgets for well-known keys: model/clip/tex/mat become drag-droppable asset
// fields with an inline preview. Assets picked in the browser (material / model /
// texture) get their own editors here — a material's shading model + params, a
// model's calibration meta, a texture's preview — each with a Delete action. The
// "World" row edits the map's sky / lighting / effects. A group is a first-class
// parent, so its inspector edits the group's own transform.
import type { AssetCatalog, CollisionMode, CollisionShape, FogFalloff, MapDef, MaterialDef, MaterialType, ModelMeta, Placement, ShadowQuality, ToneMode, Tuple3 } from "@slopwars/shared";
import { MATERIAL_TYPES, defaultMaterialDef, envPost, envShadows } from "@slopwars/shared";
import { objectDefaults } from "@game/objects";
import type { ThumbRenderer } from "./preview";
import { state } from "./state";
import { tabs } from "./tabs";
import { assetField } from "./assetfield";
import { clear, el, numField, vecField, selectField, checkField, textField, colorField, renamable } from "./ui";
import { icon } from "./icons";

// hooks the shell wires up so asset editors can persist edits + re-shade. Model
// editing shares one live working `meta` object with the shell (so the left-panel
// collision authoring and this inspector mutate the same state).
// Asset deletion no longer lives in the inspector — it's a right-click action in the
// asset browser (Unity-style), so these hooks only carry edit/rename operations.
interface MaterialHooks { changed: (name: string, def: MaterialDef) => void; renamed: (from: string, to: string) => void }
interface ModelHooks {
  meta: (name: string) => ModelMeta;
  changed: (name: string) => void;
  /** currently-selected collision solid index (−1 = none) */
  collSel: () => number;
  /** select a collision solid (highlights it + shows its gizmo in the view) */
  collSelect: (i: number) => void;
  /** append a new collision solid and select it */
  collAdd: () => void;
  /** delete collision solid `i` */
  collDelete: (i: number) => void;
}
let matHooks: MaterialHooks | null = null;
let modelHooks: ModelHooks | null = null;
export function setInspectorMaterialHooks(h: MaterialHooks): void { matHooks = h; }
export function setInspectorModelHooks(h: ModelHooks): void { modelHooks = h; }

const AXES = ["x+", "x-", "z+", "z-"];

let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
let thumbs: ThumbRenderer | null = null;
let inspectorHost: HTMLElement | null = null;
export function setInspectorCatalog(c: AssetCatalog): void { catalog = c; }
export function setInspectorThumbs(t: ThumbRenderer): void { thumbs = t; }
/** re-render the inspector in place (used by the shell after collision edits) */
export function refreshInspector(): void { if (inspectorHost) renderInspector(inspectorHost); }

/** The inspector is driven by the active viewport tab: a material/model/texture tab
 *  shows that asset's controls; a map tab shows the map selection (object / group /
 *  world). Asset editing is no longer coupled to the map selection. */
export function renderInspector(host: HTMLElement): void {
  inspectorHost = host;
  clear(host);
  const tab = tabs.active();
  if (tab?.kind === "material") {
    const m = catalog.materials.find((x) => x.name === tab.material);
    if (m) return materialInspector(host, m.name, m.def);
    host.append(el("div", "empty", "material not found")); return;
  }
  if (tab?.kind === "model" && tab.model) return modelInspector(host, tab.model);

  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map open")); return; }
  // each inspector edit is a discrete, undoable action → commit (records history)
  const touch = (): void => state.commit();
  if (state.selGroup) {
    const g = state.groupById(state.selGroup);
    if (g) return groupInspector(host, g);
  }
  const o = state.selected();
  if (!o) return worldInspector(host, map, touch);
  objectInspector(host, o, touch);
}

// ── material ──────────────────────────────────────────────────────────────────
function materialInspector(host: HTMLElement, name: string, def: MaterialDef): void {
  const title = el("h3", "insp-title", name);
  renamable(title, () => name, (v) => { if (v && v !== name) matHooks?.renamed(name, v); }, () => { /* rename persists */ });
  host.append(title);
  host.append(el("div", "insp-sub", "material"));
  const edited = (): void => matHooks?.changed(name, def);

  // shading model picker — switching a material's kind is non-destructive to its
  // file (the def is replaced with that kind's defaults and re-persisted), and the
  // param list below re-renders for the new kind.
  group(host, "Type");
  host.append(selectField("type", MATERIAL_TYPES, () => def.type, (v) => {
    if (v === def.type) return;
    const nd = defaultMaterialDef(v as MaterialType);
    for (const k of Object.keys(def)) delete (def as unknown as Record<string, unknown>)[k];
    Object.assign(def, nd);
  }, () => { edited(); state.emitSelect(); /* re-render with the new kind's params */ }));

  if (def.type === "standard") {
    const d = def;
    group(host, "Surface");
    // base color texture (a texture folder) — drop one, or clear for a solid colour
    host.append(assetField({
      label: "texture", kind: "texture", catalog, thumbs,
      get: () => d.texture ?? "", set: (v) => { d.texture = v || undefined; }, onChange: edited,
    }));
    host.append(colorField("color", (d.color ??= [0.7, 0.7, 0.72]), edited));
    host.append(numField("roughness", () => d.roughness ?? 0.85, (v) => (d.roughness = clampn(v)), edited, 0.02));
    host.append(numField("metallic", () => d.metallic ?? 0, (v) => (d.metallic = clampn(v)), edited, 0.02));
    host.append(colorField("emissive", (d.emissive ??= [0, 0, 0]), edited));
  } else if (def.type === "water") {
    const d = def; const w = defaultMaterialDef("water") as typeof def;
    group(host, "Water");
    host.append(colorField("color", (d.color ??= w.color!), edited));
    host.append(colorField("depthColor", (d.depthColor ??= w.depthColor!), edited));
    host.append(numField("opacity", () => d.opacity ?? w.opacity!, (v) => (d.opacity = clampn(v)), edited, 0.02));
    host.append(numField("clarity", () => d.clarity ?? w.clarity!, (v) => (d.clarity = clampn(v)), edited, 0.02));
    host.append(numField("depth", () => d.depth ?? w.depth!, (v) => (d.depth = Math.max(0.1, v)), edited, 0.1));
    host.append(numField("roughness", () => d.roughness ?? w.roughness!, (v) => (d.roughness = clampn(v)), edited, 0.02));
    host.append(numField("waves", () => d.waves ?? w.waves!, (v) => (d.waves = Math.max(0, v)), edited, 0.05));
    host.append(numField("flow", () => d.flow ?? w.flow!, (v) => (d.flow = Math.max(0, v)), edited, 0.01));
    host.append(numField("ior", () => d.ior ?? w.ior!, (v) => (d.ior = Math.max(1, v)), edited, 0.01));
  } else {
    const d = def; const g = defaultMaterialDef("glass") as typeof def;
    group(host, "Glass");
    host.append(colorField("color", (d.color ??= g.color!), edited));
    host.append(colorField("tint", (d.tint ??= g.tint!), edited));
    host.append(numField("opacity", () => d.opacity ?? g.opacity!, (v) => (d.opacity = clampn(v)), edited, 0.02));
    host.append(numField("roughness", () => d.roughness ?? g.roughness!, (v) => (d.roughness = clampn(v)), edited, 0.01));
    host.append(numField("thickness", () => d.thickness ?? g.thickness!, (v) => (d.thickness = Math.max(0, v)), edited, 0.05));
    host.append(numField("ior", () => d.ior ?? g.ior!, (v) => (d.ior = Math.max(1, v)), edited, 0.01));
  }
}

function clampn(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ── model (calibration meta persisted to models/<name>/meta.json) ─────────────
// Edits the live working meta the shell owns (so the Collision-view left panel and
// this inspector mutate the same object). Collision authoring (placing solids) lives
// in the left panel; here you choose the mode and calibrate the model.
function modelInspector(host: HTMLElement, name: string): void {
  const asset = catalog.models.find((x) => x.name === name);
  host.append(el("h3", "insp-title", name));
  host.append(el("div", "insp-sub", "model"));
  if (!asset || !modelHooks) { host.append(el("div", "empty", "model not found")); return; }

  const meta = modelHooks.meta(name);
  const save = (): void => modelHooks!.changed(name);

  group(host, "Placement");
  host.append(numField("base", () => meta.base ?? 0, (v) => (meta.base = v || undefined), save, 0.02));
  host.append(numField("scale", () => meta.scale ?? 1, (v) => (meta.scale = v > 0 ? v : undefined), save, 0.02));
  // base orientation: a per-axis euler baked into the model so it faces the right
  // way once (composed under every placement's own rotation). Cleared to undefined
  // when back at zero so a neutral model carries no baseRot.
  const baseRot = (meta.baseRot ?? [0, 0, 0]).slice() as number[];
  host.append(vecField("base rot", baseRot, () => {
    meta.baseRot = (baseRot[0] || baseRot[1] || baseRot[2]) ? [baseRot[0], baseRot[1], baseRot[2]] as Tuple3 : undefined;
    save();
  }, 1));

  group(host, "Material");
  host.append(assetField({
    label: "material", kind: "material", catalog, thumbs,
    get: () => meta.material ?? "", set: (v) => { meta.material = v || undefined; }, onChange: save,
  }));

  group(host, "Collision");
  host.append(selectField("mode", ["auto", "manual"], () => meta.collision ?? "auto",
    (v) => { meta.collision = v as CollisionMode; if (v === "manual" && !meta.collisionBoxes) meta.collisionBoxes = []; },
    () => { save(); refreshInspector(); }));
  if ((meta.collision ?? "auto") !== "auto") collisionList(host, meta, modelHooks, save);
}

/** the collision-primitive options a manual solid can take */
const COLL_SHAPES: CollisionShape[] = ["box", "cylinder", "sphere"];

/** the list of manual collision solids. Each solid can be authored directly in the
 *  Collision view with the Move / Rotate / Scale gizmo (same tools as map objects),
 *  or numerically here: the selected solid exposes Location / Rotation / Size fields
 *  below the list, just like an object's transform. */
function collisionList(host: HTMLElement, meta: ModelMeta, hooks: ModelHooks, save: () => void): void {
  const add = el("button", "btn primary insp-addbtn");
  add.append(icon("plus"), el("span", "btn-label", "Add solid"));
  add.addEventListener("click", () => hooks.collAdd());
  host.append(add);

  const boxes = meta.collisionBoxes ?? [];
  if (!boxes.length) { host.append(el("div", "side-note", "No solids yet — add one, then move/rotate/scale it in the Collision view.")); return; }
  const sel = hooks.collSel();
  boxes.forEach((b, i) => {
    const row = el("div", "cbox-row" + (i === sel ? " sel" : ""));
    row.append(el("span", "cbox-name", `Solid ${i + 1}`));
    // per-solid shape picker — box / cylinder / sphere, editable inline so a round
    // prop (barrel, ball) collides + tumbles roundly instead of as a blocky box.
    const shape = el("select", "cbox-shape") as HTMLSelectElement;
    for (const s of COLL_SHAPES) { const op = el("option", undefined, s); op.value = s; shape.append(op); }
    shape.value = b.shape ?? "box";
    shape.addEventListener("click", (e) => e.stopPropagation());
    shape.addEventListener("change", () => { b.shape = shape.value === "box" ? undefined : (shape.value as CollisionShape); save(); refreshInspector(); });
    row.append(shape);
    const del = el("button", "btn mini"); del.title = "delete solid"; del.append(icon("trash"));
    del.addEventListener("click", (e) => { e.stopPropagation(); hooks.collDelete(i); });
    row.append(del);
    row.addEventListener("click", () => hooks.collSelect(i));
    host.append(row);
  });

  // transform of the selected solid — position / rotation / size, mirroring an
  // object's Transform block. Fields write straight into the box and re-preview.
  if (sel >= 0 && sel < boxes.length) {
    const b = boxes[sel];
    group(host, `Solid ${sel + 1} Transform`);
    host.append(vecField("Location", b.at, save, 0.05));
    const rot = (b.rot ?? [0, 0, 0]).slice() as number[];
    host.append(vecField("Rotation", rot, () => {
      b.rot = (rot[0] || rot[1] || rot[2]) ? [rot[0], rot[1], rot[2]] as Tuple3 : undefined;
      save();
    }, 1));
    host.append(vecField("Size", b.size, save, 0.05));
  }
}

// ── group (a first-class parent — edit its own transform) ─────────────────────
function groupInspector(host: HTMLElement, g: { id: string; name: string }): void {
  const title = el("h3", "insp-title", g.name || "Group");
  renamable(title, () => g.name, (v) => state.renameGroup(g.id, v || g.name), () => { /* renameGroup commits */ });
  host.append(title);
  const members = state.membersOf(g.id, true);
  host.append(el("div", "insp-sub", `group · ${members.length} object${members.length === 1 ? "" : "s"}`));

  // A group owns a transform like any object; its members are stored relative to it,
  // so editing these moves/rotates/scales the whole group as a unit.
  group(host, "Transform");
  const w = state.groupWorld(g.id);
  const at = w.at.slice() as Tuple3, rot = w.rot.slice() as Tuple3, scl = w.scale.slice() as Tuple3;
  const push = (): void => state.setGroupWorld(g.id, { at, rot, scale: scl });
  host.append(vecField("Location", at, push, 0.1));
  host.append(vecField("Rotation", rot, push, 1));
  host.append(vecField("Scale", scl, push, 0.05));

  // Physics: simulate the whole group as one movable rigid body (a lantern = mesh +
  // light, a crate stack…). Its members become one shovable body; toggling it on
  // seeds a default mass. Only meaningful in the game (the editor leaves it static).
  const def = state.groupById(g.id);
  if (def) {
    group(host, "Physics");
    host.append(checkField("dynamic body", () => !!def.physics, (v) => {
      def.physics = v || undefined;
      if (v && def.mass == null) def.mass = 8;
    }, () => { state.commit(true); }));
    if (def.physics) {
      host.append(numField("mass", () => def.mass ?? 8, (v) => (def.mass = Math.max(0.1, v)), () => state.commit(), 0.5));
      host.append(el("div", "side-note", "Members move & tumble together; their collision is one box."));
    }
  }
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
  if (!o.rot) o.rot = [0, 0, 0];
  host.append(vecField("Rotation", o.rot, touch, 1));
  if (!o.scale) o.scale = [1, 1, 1];
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
  const asset = (kind: "model" | "audio" | "texture" | "material"): HTMLElement =>
    assetField({ label: key, kind, catalog, thumbs, get: () => String(get() ?? ""), set: (v) => set(v), onChange: touch });
  // drag-droppable asset references with an inline preview
  if (key === "model") return asset("model");
  if (key === "clip") return asset("audio");
  if (key === "mat") return asset("material");   // surface material (box, structures…)
  if (key === "tex") return asset("texture");    // particle sprite (raw texture)
  if (key === "axis") return selectField(key, AXES, () => String(get()), (v) => set(v), touch);
  // rgb-triple params (color, tint, depthColor, …) get a colour swatch
  if (isColorKey(key) && Array.isArray(dflt) && dflt.length === 3) { const arr = (get() as number[]).slice(); params[key] = arr; return colorField(key, arr, touch); }
  if (Array.isArray(dflt)) { const arr = (get() as number[]).slice(); params[key] = arr; return vecField(key, arr, touch, 0.1); }
  if (typeof dflt === "number") return numField(key, () => get() as number, (v) => set(v), touch, 0.05);
  if (typeof dflt === "boolean") return checkField(key, () => get() as boolean, (v) => set(v), touch);
  return textField(key, () => String(get() ?? ""), (v) => set(v), touch);
}

/** a param key that holds an rgb triple (gets a colour picker in the inspector) */
function isColorKey(key: string): boolean {
  return key === "color" || /colou?r$/i.test(key) || key === "tint";
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
  head(host, "World");
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
  host.append(colorField("solid", e.sky.solid, touch));

  group(host, "Sun");
  host.append(vecField("direction", e.sun.rot, touch, 1));
  host.append(colorField("color", e.sun.color, touch));
  host.append(numField("brightness", () => e.sun.intensity ?? 1, (v) => (e.sun.intensity = Math.max(0, v)), touch, 0.05));

  group(host, "Ambient");
  host.append(colorField("color", e.ambient.color, touch));
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
    host.append(colorField("color", fog.color, touch));
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
