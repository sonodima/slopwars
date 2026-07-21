// ─── Inspector: edit the selected object/group/asset, or the world ───────────
// Object params get a generic UI derived from the type's declared defaults, with
// smart widgets for well-known keys: model/clip/tex/mat become drag-droppable asset
// fields with an inline preview. Assets picked in the browser (material / model /
// texture) get their own editors here — a material's shading model + params, a
// model's calibration meta, a texture's preview — each with a Delete action. The
// "World" row edits the map's sky / lighting / effects. A group is a first-class
// parent, so its inspector edits the group's own transform.
import type { AssetCatalog, CollisionMode, CollisionShape, FogFalloff, MapDef, MaterialDef, MaterialType, ModelAnchor, ModelMeta, PhysicsProps, Placement, ShadowQuality, TextureMaps, ToneMode, Tuple3 } from "@slopwars/shared";
import { ANCHOR_KINDS, MATERIAL_TYPES, PHYSICS_DEFAULTS, anchorLabel, defaultMaterialDef, envPost, envShadows, envWeather } from "@slopwars/shared";
import { objectDefaults, placementDetail } from "@game/objects";
import { behaviourCatalog, behaviourDefaults, behaviourLabel, type BehaviourSpec } from "@game/behaviours";
import type { ThumbRenderer } from "./preview";
import { state } from "./state";
import { tabs } from "./tabs";
import { assetField } from "./assetfield";
import type { Bounds } from "./ui";
import { clear, el, numField, vecField, scaleField, selectField, checkField, textField, colorField, renamable } from "./ui";
import { icon } from "./icons";

// hooks the shell wires up so asset editors can persist edits + re-shade. Model
// editing shares one live working `meta` object with the shell (so the left-panel
// collision authoring and this inspector mutate the same state).
// Asset deletion no longer lives in the inspector — it's a right-click action in the
// asset browser (Unity-style), so these hooks only carry edit/rename operations.
interface MaterialHooks {
  changed: (name: string, def: MaterialDef) => void;
  /** live re-shade during a colour drag — applies the def everywhere WITHOUT recording
   *  a history entry (the commit on release records one). */
  live: (name: string, def: MaterialDef) => void;
  renamed: (from: string, to: string) => void;
}
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
  /** the name of the currently-selected anchor (Model view), or null */
  anchorSel: () => string | null;
  /** select an anchor by name (null to deselect) — shows its gizmo + highlights its card */
  anchorSelect: (name: string | null) => void;
  /** add an anchor of the given kind at the model centre and select it */
  anchorAdd: (kind: string) => void;
  /** remove the anchor of the given kind */
  anchorRemove: (kind: string) => void;
}
/** the three PBR maps a texture set can hold, in editor display order */
type TexSlot = "color" | "normal" | "arm";
interface TextureHooks {
  /** current maps of a texture set (from the catalog) */
  maps: (name: string) => TextureMaps;
  /** set/replace one PBR map from a picked image file (uploads + refreshes) */
  setMap: (name: string, slot: TexSlot, file: File) => void;
  /** clear one PBR map, leaving the set + its other maps intact */
  clearMap: (name: string, slot: TexSlot) => void;
  /** names of the materials that reference this texture set (for "used by") */
  usedBy: (name: string) => string[];
  /** rename the texture set (folder) — repoints referencing materials */
  renamed: (from: string, to: string) => void;
}
let matHooks: MaterialHooks | null = null;
let modelHooks: ModelHooks | null = null;
let texHooks: TextureHooks | null = null;
export function setInspectorMaterialHooks(h: MaterialHooks): void { matHooks = h; }
export function setInspectorModelHooks(h: ModelHooks): void { modelHooks = h; }
export function setInspectorTextureHooks(h: TextureHooks): void { texHooks = h; }

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
  if (tab?.kind === "texture" && tab.texture) return textureInspector(host, tab.texture);

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
  const liveEdit = (): void => matHooks?.live(name, def);

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
    host.append(colorField("color", (d.color ??= [0.7, 0.7, 0.72]), edited, liveEdit));
    host.append(numField("roughness", () => d.roughness ?? 0.85, (v) => (d.roughness = v), edited, 0.02, UNIT));
    host.append(numField("metallic", () => d.metallic ?? 0, (v) => (d.metallic = v), edited, 0.02, UNIT));
    host.append(colorField("emissive", (d.emissive ??= [0, 0, 0]), edited, liveEdit));
  } else if (def.type === "water") {
    const d = def; const w = defaultMaterialDef("water") as typeof def;
    group(host, "Water");
    host.append(colorField("color", (d.color ??= w.color!), edited, liveEdit));
    host.append(colorField("depthColor", (d.depthColor ??= w.depthColor!), edited, liveEdit));
    host.append(numField("opacity", () => d.opacity ?? w.opacity!, (v) => (d.opacity = v), edited, 0.02, UNIT));
    host.append(numField("clarity", () => d.clarity ?? w.clarity!, (v) => (d.clarity = v), edited, 0.02, UNIT));
    host.append(numField("depth", () => d.depth ?? w.depth!, (v) => (d.depth = v), edited, 0.1, { min: 0.1 }));
    host.append(numField("roughness", () => d.roughness ?? w.roughness!, (v) => (d.roughness = v), edited, 0.02, UNIT));
    host.append(numField("waves", () => d.waves ?? w.waves!, (v) => (d.waves = v), edited, 0.05, { min: 0 }));
    host.append(numField("flow", () => d.flow ?? w.flow!, (v) => (d.flow = v), edited, 0.01, { min: 0 }));
    host.append(numField("ior", () => d.ior ?? w.ior!, (v) => (d.ior = v), edited, 0.01, { min: 1 }));
  } else {
    const d = def; const g = defaultMaterialDef("glass") as typeof def;
    group(host, "Glass");
    host.append(colorField("color", (d.color ??= g.color!), edited, liveEdit));
    host.append(colorField("tint", (d.tint ??= g.tint!), edited, liveEdit));
    host.append(numField("opacity", () => d.opacity ?? g.opacity!, (v) => (d.opacity = v), edited, 0.02, UNIT));
    host.append(numField("roughness", () => d.roughness ?? g.roughness!, (v) => (d.roughness = v), edited, 0.01, UNIT));
    host.append(numField("thickness", () => d.thickness ?? g.thickness!, (v) => (d.thickness = v), edited, 0.05, { min: 0 }));
    host.append(numField("ior", () => d.ior ?? g.ior!, (v) => (d.ior = v), edited, 0.01, { min: 1 }));
  }
}

/** the ubiquitous 0..1 range (roughness / metallic / opacity / …) */
const UNIT: Bounds = { min: 0, max: 1 };

// ── texture set (a PBR group: color / normal / arm maps) ──────────────────────
// A "texture" here is a *set* of maps (the folder public/assets/textures/<name>/),
// exactly like a texture group in Unreal/Unity. This editor exposes each PBR map as
// its own slot so you can add a normal/arm to a bare color set (or swap one) after
// import; materials then reference the whole set by name. The 3D preview shows the
// maps shading a lit sphere.
const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;
const TEX_SLOTS: { slot: TexSlot; label: string; hint: string }[] = [
  { slot: "color", label: "Color", hint: "base colour / albedo" },
  { slot: "normal", label: "Normal", hint: "tangent-space normal map" },
  { slot: "arm", label: "AO · Rough · Metal", hint: "packed occlusion / roughness / metallic" },
];

function textureInspector(host: HTMLElement, name: string): void {
  const title = el("h3", "insp-title", name);
  if (texHooks) renamable(title, () => name, (v) => { if (v && v !== name) texHooks!.renamed(name, v); }, () => { /* rename persists */ });
  host.append(title);
  host.append(el("div", "insp-sub", "texture set"));
  if (!texHooks) { host.append(el("div", "empty", "texture editing unavailable")); return; }
  const maps = texHooks.maps(name);

  group(host, "Maps");
  for (const { slot, label, hint } of TEX_SLOTS) host.append(textureMapSlot(name, slot, label, hint, maps[slot]));

  group(host, "Used by");
  const users = texHooks.usedBy(name);
  if (!users.length) host.append(el("div", "side-note", "No material uses this set yet — create a material and drop this texture on its slot."));
  else {
    const list = el("div", "tex-users");
    for (const u of users) {
      const row = el("button", "tex-user");
      row.append(icon("material", "tex-user-ico"), el("span", undefined, u));
      row.addEventListener("click", () => tabs.openMaterial(u));
      list.append(row);
    }
    host.append(list);
  }
}

/** one PBR-map slot: an image preview (or an empty drop target), a browse/replace
 *  file picker, and a clear button. Dropping or picking an image uploads it into the
 *  set's <slot> file; clearing removes just that map. */
function textureMapSlot(name: string, slot: TexSlot, label: string, hint: string, current?: string): HTMLElement {
  const row = el("div", "tex-slot");
  const head = el("div", "tex-slot-head");
  head.append(el("span", "tex-slot-label", label));
  if (current) {
    const clr = el("button", "btn mini"); clr.title = "clear this map"; clr.append(icon("x"));
    clr.addEventListener("click", (e) => { e.stopPropagation(); texHooks?.clearMap(name, slot); });
    head.append(clr);
  }
  row.append(head);

  const drop = el("div", "tex-slot-drop" + (current ? " has" : ""));
  drop.title = current ? "click or drop an image to replace" : `click or drop an image to add the ${hint}`;
  if (current) { const img = el("img", "tex-slot-img"); img.src = ASSET(current); img.loading = "lazy"; drop.append(img); }
  else { const ph = el("div", "tex-slot-empty"); ph.append(icon("image"), el("span", undefined, "Add map")); drop.append(ph); }

  const input = el("input") as HTMLInputElement;
  input.type = "file"; input.accept = "image/*"; input.style.display = "none";
  input.addEventListener("change", () => { const f = input.files?.[0]; if (f) texHooks?.setMap(name, slot, f); });
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drop"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove("drop");
    const f = Array.from(e.dataTransfer?.files ?? []).find((x) => x.type.startsWith("image/"));
    if (f) texHooks?.setMap(name, slot, f);
  });
  row.append(drop, input);
  return row;
}

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
  host.append(numField("scale", () => meta.scale ?? 1, (v) => (meta.scale = v), save, 0.02, { min: 0.01 }));
  // base orientation: a per-axis euler baked into the model so it faces the right
  // way once (composed under every placement's own rotation). Cleared to undefined
  // when back at zero so a neutral model carries no baseRot.
  const baseRot = (meta.baseRot ?? [0, 0, 0]).slice() as number[];
  host.append(vecField("base rot", baseRot, () => {
    meta.baseRot = (baseRot[0] || baseRot[1] || baseRot[2]) ? [baseRot[0], baseRot[1], baseRot[2]] as Tuple3 : undefined;
    save();
  }, 1));

  // Materials — one slot per glTF material (the model's MAIN materials). Assigning a
  // material shades that surface with it; clearing a slot falls back to the glTF's own
  // material (e.g. keep a transparent glass part). A model with no named slots (a .glb —
  // binary, so its materials aren't scanned) gets one "all surfaces" slot.
  group(host, "Materials");
  const slots = asset.slots ?? [];
  if (slots.length) {
    for (const slot of slots) {
      host.append(assetField({
        label: prettySlot(slot, name), kind: "material", catalog, thumbs,
        get: () => (meta.materials ?? {})[slot] ?? "",
        set: (v) => setSlotMaterial(meta, slot, v),
        onChange: save,
      }));
    }
  } else {
    host.append(assetField({
      label: "all surfaces", kind: "material", catalog, thumbs,
      get: () => meta.material ?? "", set: (v) => { meta.material = v || undefined; }, onChange: save,
    }));
  }

  group(host, "Collision");
  host.append(selectField("mode", ["auto", "manual"], () => meta.collision ?? "auto",
    (v) => { meta.collision = v as CollisionMode; if (v === "manual" && !meta.collisionBoxes) meta.collisionBoxes = []; },
    () => { save(); refreshInspector(); }));
  if ((meta.collision ?? "auto") !== "auto") collisionList(host, meta, modelHooks, save);

  // Hold anchor — where the model sits in a hand when it's a held item (a weapon, a
  // pickup). Authored like a behaviour/collision entry: an icon in the Model view you
  // click to select, then move/rotate with the standard gizmo. Extensible: the schema
  // keys anchors by name, so more (muzzle, sight, …) can be added later.
  anchorSection(host, meta, modelHooks, save);

  // Prop Hunt: opt this model into the pool a hider can be disguised as. Off by default;
  // when no model opts in the game falls back to the built-in crate disguise.
  group(host, "Prop Hunt");
  host.append(checkField("usable as prop", () => !!meta.propHunt, (v) => { meta.propHunt = v || undefined; }, save));
  host.append(el("div", "side-note", "When on, a Prop-Hunt hider may be disguised as this model (chosen at random from every prop-hunt model)."));
}

/** a readable label for a glTF material slot — drop a redundant model-name prefix
 *  (a slot literally named after the model reads as "surface"). */
function prettySlot(slot: string, model: string): string {
  if (slot === model) return "surface";
  const stripped = slot.startsWith(model + "_") ? slot.slice(model.length + 1) : slot;
  return stripped.replace(/[_-]+/g, " ").trim() || slot;
}

/** assign (or clear) the material for one glTF slot, pruning an emptied `materials`
 *  map so a model with no assignments carries none. */
function setSlotMaterial(meta: ModelMeta, slot: string, value: string): void {
  const map = meta.materials ?? {};
  if (value) map[slot] = value; else delete map[slot];
  meta.materials = Object.keys(map).length ? map : undefined;
}

/** the anchor list — deliberately built like the object Behaviours section: each anchor
 *  is a card (its label, a remove button, and its param fields inline, rendered the same
 *  way behaviour params are), with an "Add anchor…" picker at the bottom. Clicking a
 *  card's header selects it, showing its icon-gizmo in the Model view for direct drag.
 *  Extensible via ANCHOR_KINDS — currently muzzle (a weapon's flash/shot origin). */
function anchorSection(host: HTMLElement, meta: ModelMeta, hooks: ModelHooks, save: () => void): void {
  group(host, "Anchors");
  const anchors = meta.anchors ?? {};
  const present = ANCHOR_KINDS.filter((k) => anchors[k.key]);
  const sel = hooks.anchorSel();

  if (!present.length) host.append(el("div", "side-note", "No anchors — add a muzzle to mark where a weapon's flash + shots start. It shows as an icon in the Model view; drag it with the Move tool."));

  for (const kind of present) {
    const a = anchors[kind.key] as ModelAnchor;
    const selected = sel === kind.key;
    const card = el("div", "beh-card" + (selected ? " sel" : ""));
    const head = el("div", "beh-head");
    head.style.cursor = "pointer";
    head.title = "select — drag it in the Model view";
    head.append(icon(kind.key === "muzzle" ? "zap" : "anchor", "cbox-ico"), el("span", "beh-title", anchorLabel(kind.key)));
    const del = el("button", "btn mini"); del.title = "remove " + kind.label.toLowerCase(); del.append(icon("trash"));
    del.addEventListener("click", (e) => { e.stopPropagation(); hooks.anchorRemove(kind.key); });
    head.append(del);
    head.addEventListener("click", () => hooks.anchorSelect(selected ? null : kind.key));
    card.append(head);
    // params, backed by the live anchor object — shown inline exactly like a behaviour's
    const at = a.at.slice() as number[];
    card.append(vecField("Location", at, () => { a.at = [at[0], at[1], at[2]] as Tuple3; save(); }, 0.01));
    if (kind.rot) {
      const rot = (a.rot ?? [0, 0, 0]).slice() as number[];
      card.append(vecField("Rotation", rot, () => {
        a.rot = (rot[0] || rot[1] || rot[2]) ? [rot[0], rot[1], rot[2]] as Tuple3 : undefined;
        save();
      }, 1));
    }
    host.append(card);
  }

  // add picker: choose a kind not yet present → append it at the model centre + select
  const remaining = ANCHOR_KINDS.filter((k) => !anchors[k.key]);
  if (remaining.length) {
    const bar = el("div", "beh-add");
    const selEl = el("select", "beh-add-sel") as HTMLSelectElement;
    const ph = el("option", undefined, "Add anchor…") as HTMLOptionElement; ph.value = ""; selEl.append(ph);
    for (const k of remaining) { const op = el("option", undefined, k.label) as HTMLOptionElement; op.value = k.key; selEl.append(op); }
    selEl.addEventListener("change", () => { if (selEl.value) hooks.anchorAdd(selEl.value); });
    bar.append(selEl);
    host.append(bar);
  }
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
    host.append(vecField("Size", b.size, save, 0.05, { min: 0.01 }));
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
  // so editing these moves/rotates/scales the whole group as a unit. The fields are
  // the group's OWN (parent-relative) transform — a nested group reads relative to its
  // parent group, matching how a member object's transform is relative to this group.
  const def = state.groupById(g.id);
  if (def) {
    group(host, "Transform");
    if (!def.at) def.at = [0, 0, 0];
    if (!def.rot) def.rot = [0, 0, 0];
    if (!def.scale) def.scale = [1, 1, 1];
    const push = (): void => state.commit();
    host.append(vecField("Location", def.at, push, 0.1));
    host.append(vecField("Rotation", def.rot, push, 1));
    host.append(scaleField("Scale", def.scale, push, 0.05, { min: 0.01 }));

    // Physics: simulate the whole group as one movable rigid body (a lantern = mesh +
    // light, a crate stack…). Its members become one shovable body; toggling it on
    // seeds a default mass. Only meaningful in the game (the editor leaves it static).
    group(host, "Physics");
    host.append(checkField("dynamic body", () => !!def.physics, (v) => {
      def.physics = v || undefined;
      if (v && def.mass == null) def.mass = 8;
    }, () => { state.commit(true); }));
    if (def.physics) {
      host.append(numField("mass", () => def.mass ?? PHYSICS_DEFAULTS.mass, (v) => (def.mass = v), () => state.commit(), 0.5, { min: 0.1 }));
      physicsParamFields(host, def, () => state.commit());
      host.append(el("div", "side-note", "Members move & tumble together; their collision is one box."));
    }
  }
}

/** the shared per-body PhysX knobs (friction / bounce / damping) — rendered under both
 *  a physics group and a physics prop. Each writes straight onto the target's physics
 *  fields and clears back to undefined at the default so an untuned body stores nothing. */
function physicsParamFields(host: HTMLElement, t: PhysicsProps, commit: () => void): void {
  const num = (label: string, key: keyof PhysicsProps, dflt: number, step: number, bounds: Bounds): void => {
    host.append(numField(label, () => t[key] ?? dflt, (v) => { t[key] = v; }, commit, step, bounds));
  };
  num("friction", "friction", PHYSICS_DEFAULTS.friction, 0.05, { min: 0, max: 2 });
  num("bounciness", "restitution", PHYSICS_DEFAULTS.restitution, 0.02, UNIT);
  num("linear damping", "linearDamping", PHYSICS_DEFAULTS.linearDamping, 0.02, { min: 0, max: 5 });
  num("angular damping", "angularDamping", PHYSICS_DEFAULTS.angularDamping, 0.02, { min: 0, max: 5 });
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
  const detail = placementDetail(o);
  const sub = o.name ? o.type + (detail ? " · " + detail : "") : detail;
  if (sub) host.append(el("div", "insp-sub", sub));

  group(host, "Transform");
  host.append(vecField("Location", o.at, touch, 0.1));
  if (!o.rot) o.rot = [0, 0, 0];
  host.append(vecField("Rotation", o.rot, touch, 1));
  if (!o.scale) o.scale = [1, 1, 1];
  host.append(scaleField("Scale", o.scale, touch, 0.05, { min: 0.01 }));

  const schema = objectDefaults(o.type);
  const params = (o.params ??= {});
  // an object with a `physics` toggle gets a dedicated Physics section (mass + the PhysX
  // knobs) that only appears when physics is on — its keys are pulled out of Details.
  const hasPhysics = "physics" in schema && typeof schema.physics === "boolean";
  // `behaviours` gets its own composition section (a list of gameplay traits), so it's
  // pulled out of the generic Details list (which can't render an array of objects).
  const hasBehaviours = Array.isArray(schema.behaviours);
  const detailKeys = Object.keys(schema).filter((k) => !(hasPhysics && PHYSICS_KEYS.has(k)) && !(hasBehaviours && k === "behaviours"));
  if (detailKeys.length) {
    group(host, "Details");
    for (const key of detailKeys) host.append(paramField(key, schema[key], params, touch));
  }
  if (hasBehaviours) objectBehavioursSection(host, params, touch);
  if (hasPhysics) objectPhysicsSection(host, params, schema, touch);
}

/** param keys owned by the Physics section (hidden from the generic Details list) */
const PHYSICS_KEYS = new Set(["physics", "mass", "friction", "restitution", "linearDamping", "angularDamping"]);

/** the Behaviours block: the composable gameplay traits attached to a model prop.
 *  Each behaviour is a card — its label, a remove button, and its own param fields
 *  (rendered by the same generic paramField as object params, so an `explode` gets
 *  hp/radius/height and a `light` gets a colour swatch + intensity). A picker at the
 *  bottom appends a new behaviour with its defaults. Add/remove/type edits rebuild
 *  the map and re-render the inspector; per-field edits just `touch` like any param. */
function objectBehavioursSection(host: HTMLElement, params: Record<string, unknown>, touch: () => void): void {
  group(host, "Behaviours");
  const list: BehaviourSpec[] = Array.isArray(params.behaviours) ? (params.behaviours as BehaviourSpec[]) : (params.behaviours = []);
  const catalog = behaviourCatalog();

  if (!list.length) host.append(el("div", "side-note", "No behaviours — add one below to make this prop explode, glow, …"));
  list.forEach((spec, i) => {
    const card = el("div", "beh-card");
    const head = el("div", "beh-head");
    head.append(el("span", "beh-title", behaviourLabel(spec.type)));
    const del = el("button", "btn mini"); del.title = "remove behaviour"; del.append(icon("trash"));
    del.addEventListener("click", () => { list.splice(i, 1); state.commit(true); });
    head.append(del);
    card.append(head);
    // each behaviour param is a normal param field, backed by the spec object itself
    const defs = behaviourDefaults(spec.type);
    for (const key of Object.keys(defs)) card.append(paramField(key, defs[key], spec as unknown as Record<string, unknown>, touch));
    host.append(card);
  });

  // add picker: choose a trait → append it with its defaults
  const bar = el("div", "beh-add");
  const sel = el("select", "beh-add-sel") as HTMLSelectElement;
  const ph = el("option", undefined, "Add behaviour…") as HTMLOptionElement; ph.value = ""; sel.append(ph);
  for (const b of catalog) { const op = el("option", undefined, b.label) as HTMLOptionElement; op.value = b.type; sel.append(op); }
  sel.addEventListener("change", () => {
    const type = sel.value;
    if (!type) return;
    list.push({ type, ...behaviourDefaults(type) });
    state.commit(true);
  });
  bar.append(sel);
  host.append(bar);
}

/** the Physics block for an object with a `physics` toggle: the on/off switch, and —
 *  only when it's on — mass plus the shared PhysX knobs, all backed by the object's
 *  params so the fields hide entirely for a non-physics prop. */
function objectPhysicsSection(host: HTMLElement, params: Record<string, unknown>, schema: Record<string, unknown>, touch: () => void): void {
  group(host, "Physics");
  const on = (): boolean => (params.physics as boolean | undefined) ?? (schema.physics as boolean ?? false);
  host.append(checkField("physics", on, (v) => { params.physics = v; }, () => { touch(); state.emitSelect(); }));
  if (!on()) { host.append(el("div", "side-note", "A physics prop is a movable rigid body — bullets, blasts and bumping shove it.")); return; }
  const massDflt = typeof schema.mass === "number" ? schema.mass : PHYSICS_DEFAULTS.mass;
  host.append(numField("mass", () => (params.mass as number | undefined) ?? massDflt, (v) => { params.mass = v; }, touch, 0.5, { min: 0.1 }));
  physicsParamFields(host, params as unknown as PhysicsProps, touch);
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
  // rgb-triple params (color, tint, depthColor, …) get a colour swatch. Live drags
  // only redraw (state.touch); the pick is committed to history once, on `change`.
  if (isColorKey(key) && Array.isArray(dflt) && dflt.length === 3) { const arr = (get() as number[]).slice(); params[key] = arr; return colorField(key, arr, touch, () => state.touch()); }
  if (Array.isArray(dflt)) { const arr = (get() as number[]).slice(); params[key] = arr; return vecField(key, arr, touch, 0.1); }
  if (typeof dflt === "number") return numField(key, () => get() as number, (v) => set(v), touch, 0.05);
  if (typeof dflt === "boolean") return checkField(key, () => get() as boolean, (v) => set(v), touch);
  return textField(key, () => String(get() ?? ""), (v) => set(v), touch);
}

/** a param key that holds an rgb triple (gets a colour picker in the inspector) */
function isColorKey(key: string): boolean {
  return key === "color" || /colou?r$/i.test(key) || key === "tint";
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
  // colour swatches redraw live while dragging (no history) and commit one undo entry
  // on release — same split the object inspector uses.
  const live = (): void => state.touch();

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
  host.append(colorField("solid", e.sky.solid, touch, live));

  group(host, "Sun");
  host.append(vecField("direction", e.sun.rot, touch, 1));
  host.append(colorField("color", e.sun.color, touch, live));
  host.append(numField("brightness", () => e.sun.intensity ?? 1, (v) => (e.sun.intensity = v), touch, 0.05, { min: 0 }));

  group(host, "Ambient");
  host.append(colorField("color", e.ambient.color, touch, live));
  host.append(numField("intensity", () => e.ambient.intensity, (v) => (e.ambient.intensity = v), touch, 0.05, { min: 0 }));
  host.append(numField("reflections", () => e.ambient.specular ?? 0.85, (v) => (e.ambient.specular = v), touch, 0.05, { min: 0 }));

  group(host, "Shadows");
  const sh = envShadows(e);
  host.append(selectField("quality", ["off", "low", "medium", "high", "ultra"],
    () => sh.quality, (v) => { (e.shadows ??= {}).quality = v as ShadowQuality; }, () => state.commit(true)));
  if (sh.quality !== "off") {
    host.append(numField("strength", () => envShadows(e).strength, (v) => { (e.shadows ??= {}).strength = v; }, touch, 0.02, UNIT));
    host.append(numField("distance", () => envShadows(e).distance, (v) => { (e.shadows ??= {}).distance = v; }, touch, 5, { min: 1 }));
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
    host.append(colorField("color", fog.color, touch, live));
    if ((fog.falloff ?? "linear") === "linear") {
      host.append(numField("start", () => fog.start, (v) => (fog.start = v), touch, 1, { min: 0 }));
      host.append(numField("end", () => fog.end, (v) => (fog.end = v), touch, 1, { min: 0 }));
    } else {
      host.append(numField("density", () => fog.density ?? 0.015, (v) => (fog.density = v), touch, 0.002, { min: 0 }));
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
      (v) => { ((e.post ??= {}).bloom ??= {}).intensity = v; }, touch, 0.05, { min: 0 }));
    host.append(numField("bloom threshold", () => envPost(e).bloom.threshold,
      (v) => { ((e.post ??= {}).bloom ??= {}).threshold = v; }, touch, 0.05, { min: 0 }));
  }

  // ── weather: the volumetric atmosphere layers. A layer is ON when its block
  // exists; knobs read RESOLVED values (envWeather) so a freshly-enabled layer
  // shows its live defaults, while edits write into the raw env block (only
  // touched fields are saved — same contract as shadows/post above). Colour
  // swatches mutate a materialized array in place (the sky.solid pattern).
  group(host, "Clouds");
  host.append(checkField("volumetric clouds", () => !!e.weather?.clouds, (v) => {
    (e.weather ??= {}).clouds = v ? {} : null;
  }, () => state.commit(true)));
  if (e.weather?.clouds) {
    const c = e.weather.clouds;
    const rc = (): NonNullable<ReturnType<typeof envWeather>["clouds"]> => envWeather(e).clouds!;
    c.wind ??= [rc().wind[0], rc().wind[1]];
    c.tint ??= [rc().tint[0], rc().tint[1], rc().tint[2]];
    host.append(numField("coverage", () => rc().coverage, (v) => (c.coverage = v), touch, 0.02, UNIT));
    host.append(numField("density", () => rc().density, (v) => (c.density = v), touch, 0.05, { min: 0 }));
    host.append(numField("altitude", () => rc().base, (v) => (c.base = v), touch, 50, { min: 200 }));
    host.append(numField("thickness", () => rc().thickness, (v) => (c.thickness = v), touch, 50, { min: 100 }));
    host.append(numField("wind x", () => c.wind![0], (v) => (c.wind![0] = v), touch, 1));
    host.append(numField("wind z", () => c.wind![1], (v) => (c.wind![1] = v), touch, 1));
    host.append(colorField("tint", c.tint, touch, live));
  }

  group(host, "Mist");
  host.append(checkField("height fog + ground mist", () => !!e.weather?.mist, (v) => {
    (e.weather ??= {}).mist = v ? {} : null;
  }, () => state.commit(true)));
  if (e.weather?.mist) {
    const m = e.weather.mist;
    const rm = (): NonNullable<ReturnType<typeof envWeather>["mist"]> => envWeather(e).mist!;
    m.color ??= [rm().color[0], rm().color[1], rm().color[2]];
    host.append(colorField("color", m.color, touch, live));
    host.append(numField("density", () => rm().density, (v) => (m.density = v), touch, 0.02, { min: 0 }));
    host.append(numField("height", () => rm().height, (v) => (m.height = v), touch, 1, { min: 1 }));
    host.append(numField("ground density", () => rm().ground, (v) => (m.ground = v), touch, 0.05, { min: 0 }));
    host.append(numField("ground height", () => rm().groundHeight, (v) => (m.groundHeight = v), touch, 0.2, { min: 0.2 }));
    host.append(numField("ground level", () => rm().base, (v) => (m.base = v), touch, 0.5));
    host.append(numField("drift speed", () => rm().speed, (v) => (m.speed = v), touch, 0.1, { min: 0 }));
  }

  group(host, "Sun rays");
  host.append(checkField("god rays", () => !!e.weather?.rays, (v) => {
    (e.weather ??= {}).rays = v ? {} : null;
  }, () => state.commit(true)));
  if (e.weather?.rays) {
    const r = e.weather.rays;
    const rr = (): NonNullable<ReturnType<typeof envWeather>["rays"]> => envWeather(e).rays!;
    r.color ??= [rr().color[0], rr().color[1], rr().color[2]];
    host.append(numField("intensity", () => rr().intensity, (v) => (r.intensity = v), touch, 0.05, { min: 0 }));
    host.append(colorField("color", r.color, touch, live));
  }

  group(host, "Rain");
  host.append(checkField("rain", () => !!e.weather?.rain, (v) => {
    (e.weather ??= {}).rain = v ? {} : null;
  }, () => state.commit(true)));
  if (e.weather?.rain) {
    const p = e.weather.rain;
    const rp = (): NonNullable<ReturnType<typeof envWeather>["rain"]> => envWeather(e).rain!;
    p.wind ??= [rp().wind[0], rp().wind[1]];
    host.append(numField("intensity", () => rp().intensity, (v) => (p.intensity = v), touch, 0.05, UNIT));
    host.append(numField("wind x", () => p.wind![0], (v) => (p.wind![0] = v), touch, 0.5));
    host.append(numField("wind z", () => p.wind![1], (v) => (p.wind![1] = v), touch, 0.5));
  }
}
