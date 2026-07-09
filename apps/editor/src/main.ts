// ─── SlopWars Map Editor — shell + wiring ────────────────────────────────────
// A tabbed editor: the centre viewport hosts one tab per open document — several
// maps, plus interactive material / model / texture previews. A map tab shows the
// scene outliner (left) + object inspector (right) + 3D viewport; a preview tab
// shows an orbitable sphere/model with the asset's controls in the inspector and a
// context panel on the left (environment picker, or collision authoring). Double-
// clicking an asset in the bottom browser opens (or focuses) its tab; New/Load open
// map tabs. Everything placed in a map is an object saved to maps/<id>.json.
import type { AssetCatalog, MaterialDef, ModelMeta, Placement, Tuple3 } from "@slopwars/shared";
import { Viewport, Tool, PerfStats } from "./viewport";
import { PreviewScene } from "./previewscene";
import { ThumbRenderer } from "./preview";
import { state } from "./state";
import { tabs, type Tab } from "./tabs";
import { mountSceneGraph } from "./scenegraph";
import { renderInspector, refreshInspector, setInspectorCatalog, setInspectorThumbs, setInspectorMaterialHooks, setInspectorModelHooks } from "./inspector";
import { renderBrowser, Payload, type BrowserControl } from "./panels";
import { mountResizers } from "./layout";
import { objectDropScale } from "@game/objects";
import { startMcpBridge } from "./mcpbridge";
import { api } from "./api";
import { el, clear, button, iconButton, toast, modal, confirmUnsaved } from "./ui";
import { icon, type IconName } from "./icons";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const viewport = new Viewport();
const preview = new PreviewScene();
const thumbs = new ThumbRenderer();
let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
let browser: BrowserControl | null = null;
let rebuildTimer = 0;

// live working copies of model calibration metas, keyed by model name. Shared by
// the inspector (base/scale/material/collision-mode) and the left-panel collision
// authoring so both mutate the same object. Seeded from the catalog on first use.
const modelEdits = new Map<string, ModelMeta>();
// which collision solid is selected in the active model tab (drives highlight +
// the per-solid fields in the left panel)
let selBox = -1;
// content key currently loaded into the preview scene (avoids reloading on unrelated
// state changes; a live material/model edit rebuilds explicitly)
let previewKey = "";

const TOOLS: { t: Tool; label: string }[] = [
  { t: "move", label: "Move" },
  { t: "rotate", label: "Rotate" },
  { t: "scale", label: "Scale" },
];
const GRAPHICS = ["low", "medium", "high"] as const;

async function loadCatalog(): Promise<AssetCatalog> { return api.catalog(); }

async function refreshCatalog(reshade = false): Promise<void> {
  catalog = await loadCatalog();
  setInspectorCatalog(catalog);
  preview.setCatalog(catalog);
  viewport.setMaterials(catalog.materials, false);
  viewport.setModelMetas(catalog.models, reshade);
}

// ── unsaved-changes tracking (maps + material/model assets) ───────────────────
// Asset edits are applied LIVE (the map re-shades immediately) but no longer written
// to disk automatically — instead the asset is marked dirty and the user saves it
// explicitly (Save / Save All), exactly like a map. A tab shows a dot while dirty;
// closing a dirty tab or leaving the editor with unsaved work prompts first.
const dirtyMaterials = new Set<string>();
const dirtyModels = new Set<string>();
function markMaterialDirty(name: string): void { dirtyMaterials.add(name); renderTabStrip(); renderSaveButtons(); }
function markModelDirty(name: string): void { dirtyModels.add(name); renderTabStrip(); renderSaveButtons(); }
/** is a given tab's document unsaved? (maps track their own dirty flag) */
function isTabDirty(t: Tab): boolean {
  if (t.kind === "map") return state.isDirty(t.id);
  if (t.kind === "material") return t.material ? dirtyMaterials.has(t.material) : false;
  if (t.kind === "model") return t.model ? dirtyModels.has(t.model) : false;
  return false;
}
function anyDirty(): boolean {
  return dirtyMaterials.size > 0 || dirtyModels.size > 0 || state.documentIds().some((id) => state.isDirty(id));
}

/** write a material's current def to disk and clear its dirty mark */
async function saveMaterialFile(name: string): Promise<void> {
  const def = catalog.materials.find((m) => m.name === name)?.def;
  if (!def) return;
  try { await api.saveMaterial(name, def); dirtyMaterials.delete(name); renderTabStrip(); renderSaveButtons(); }
  catch (e) { toast("material save failed: " + e, true); }
}
/** write a model's current meta to disk and clear its dirty mark */
async function saveModelFile(name: string): Promise<void> {
  try { await api.saveModelMeta(name, liveMeta(name)); dirtyModels.delete(name); renderTabStrip(); renderSaveButtons(); }
  catch (e) { toast("model save failed: " + e, true); }
}

/** the live working meta for a model (seeded from the catalog on first access) */
function liveMeta(name: string): ModelMeta {
  const hit = modelEdits.get(name);
  if (hit) return hit;
  const seed: ModelMeta = JSON.parse(JSON.stringify(catalog.models.find((x) => x.name === name)?.meta ?? {}));
  modelEdits.set(name, seed);
  return seed;
}

async function main(): Promise<void> {
  try { catalog = await loadCatalog(); } catch (e) { toast("catalog load failed: " + e, true); }
  setInspectorCatalog(catalog);
  setInspectorThumbs(thumbs);
  setInspectorMaterialHooks({
    changed: (name, def) => onMaterialChanged(name, def),
    live: (name, def) => applyMaterialEffects(name, def),   // re-shade live, no history entry
    renamed: (from, to) => { void renameMaterial(from, to); },
  });
  setInspectorModelHooks({
    meta: (name) => liveMeta(name),
    changed: (name) => onModelMetaChanged(name),
    collSel: () => selBox,
    collSelect: (i) => collSelect(i),
    collAdd: () => collAdd(),
    collDelete: (i) => collDelete(i),
  });

  buildToolbar();
  // the floating preview-environment button (static in the HTML) gets its icon here
  const envBtn = $("vp-envbtn"); clear(envBtn); envBtn.append(icon("mountain"), el("span", "btn-label", "Environment"));
  mountSceneGraph($("scene-graph"));
  buildDock();
  bindUndoRedo();
  bindSaveShortcuts();
  mountResizers();

  // map data / selection → viewport + trees + inspector + tab strip
  state.onChange(() => { scheduleRebuild(); refreshMapName(); renderTabStrip(); });
  state.onSelect(() => renderInspector($("inspector")));
  // selecting in the outliner reframes the camera on the object (map tabs only)
  state.onSelect(() => {
    if (state.selectSource === "outliner" && (state.selIndex >= 0 || state.selectedObjects().length)) {
      viewport.focusSelected();
      state.selectSource = "";
    }
  });
  // tab list / active tab → viewport mode + left panel + inspector + strip
  tabs.onChange(() => { renderTabStrip(); syncViewport(); renderLeftPanel(); renderInspector($("inspector")); renderSaveButtons(); });

  viewport.onToolChange((t) => { highlightTool(t); preview.setGizmoTool(t); });
  viewport.onEditCommit = () => state.commit(true);
  viewport.onPerf = showPerf;

  // clicking a collision solid in the preview selects it → reflect in the inspector list
  preview.onCollisionSelect = (i) => { selBox = i; refreshInspector(); };
  // a gizmo drag in the preview mutated the selected solid → persist + re-shade +
  // refresh the inspector so its numeric transform fields show the new values.
  preview.onCollisionChange = () => { const t = tabs.active(); if (t?.kind === "model" && t.model) { onModelMetaChanged(t.model); refreshInspector(); } };

  tabs.newMap();     // start on a blank map tab (Load opens existing ones)
  setupDrop();
  trackCursor();

  viewport.init("editor-canvas")
    .then(() => { viewport.setGraphics("high"); viewport.setMaterials(catalog.materials); viewport.setModelMetas(catalog.models); if (state.map) return viewport.render(state.map); })
    .catch((e) => { console.error("viewport init failed (data editing still works):", e); toast("3D viewport unavailable", true); });
  preview.init("preview-canvas").then(() => { preview.setCatalog(catalog); syncViewport(); }).catch((e) => console.warn("preview scene unavailable", e));
  thumbs.init().catch(() => { /* thumbnails optional */ });

  startMcpBridge({
    viewport,
    getCatalog: () => catalog,
    reloadCatalog: async () => { await refreshCatalog(); browser?.reload(); renderTabStrip(); return catalog; },
    saveMap,
    loadMap: openMap,
    newMap: () => { tabs.newMap(); },
  });
}

// ── preview orchestration ─────────────────────────────────────────────────────
/** show/hide the preview canvas + load its content when the active tab changes */
function syncViewport(): void {
  const tab = tabs.active();
  const kind = tab?.kind ?? null;
  const isPreview = !!kind && kind !== "map";
  const isEmpty = kind === null;   // no tab open at all → blank grey stage (no 3D)
  const stage = $("vp-stage");
  stage.classList.toggle("preview", isPreview);
  stage.classList.toggle("empty", isEmpty);
  preview.show(isPreview);
  // leaving a map tab: silence its looping ambience/music (a returning map re-adopts
  // the still-alive elements, so it resumes rather than restarts).
  if (viewport.ready) viewport.setAudioPlaying(kind === "map");
  renderModes();
  renderEnvButton();

  const key = tab ? `${tab.kind}:${tab.material ?? tab.model ?? ""}:${tab.view ?? ""}` : "";
  if (isPreview && key !== previewKey && preview.ready) {
    if (tab!.kind === "material") {
      const m = catalog.materials.find((x) => x.name === tab!.material);
      if (m) { ensureMatHist(m.name); void preview.showMaterial(m.name, m.def); }
    } else if (tab!.kind === "model") {
      selBox = -1;
      ensureMetaHist(tab!.model!);
      void preview.showModel(tab!.model!, tab!.view ?? "model", liveMeta(tab!.model!));
    }
  }
  previewKey = isPreview ? key : "";
  // switching back to a map tab: the map canvas was hidden (0-sized while a preview
  // was up), so resize it before re-rendering — otherwise the scene comes back black
  // with only the overlay markers showing.
  if (kind === "map" && viewport.ready && state.map) viewport.onShown();
}

/** live material edit → rebuild the preview sphere (keeping the orbit) if its tab is active */
function previewMaterialEdit(name: string, def: MaterialDef): void {
  const tab = tabs.active();
  if (tab?.kind === "material" && tab.material === name) void preview.showMaterial(name, def, true);
}

/** a material edit → record history, apply everywhere (map, file, preview) */
function onMaterialChanged(name: string, def: MaterialDef): void {
  recordMatHistory(name);
  applyMaterialEffects(name, def);
}
function applyMaterialEffects(name: string, def: MaterialDef): void {
  viewport.setMaterials(catalog.materials, true);   // live re-shade the map (unsaved is fine)
  markMaterialDirty(name);
  previewMaterialEdit(name, def);
}

// ── material undo/redo (preview tabs) — same snapshot scheme as model metas ───
const matHistory = new Map<string, MetaHist>();
function matDefOf(name: string): MaterialDef | null { return catalog.materials.find((m) => m.name === name)?.def ?? null; }
function ensureMatHist(name: string): MetaHist | null {
  const def = matDefOf(name); if (!def) return null;
  let h = matHistory.get(name);
  if (!h) { h = { undo: [], redo: [], baseline: JSON.stringify(def) }; matHistory.set(name, h); }
  return h;
}
function recordMatHistory(name: string): void {
  const h = ensureMatHist(name); const def = matDefOf(name); if (!h || !def) return;
  const now = JSON.stringify(def);
  if (now === h.baseline) return;
  h.undo.push(h.baseline);
  if (h.undo.length > META_HISTORY_CAP) h.undo.shift();
  h.redo.length = 0;
  h.baseline = now;
}
function restoreMat(name: string, json: string): void {
  const def = matDefOf(name); if (!def) return;
  for (const k of Object.keys(def)) delete (def as unknown as Record<string, unknown>)[k];
  Object.assign(def, JSON.parse(json));
  applyMaterialEffects(name, def);
  refreshInspector();
}
function matUndo(name: string): void {
  const h = ensureMatHist(name); if (!h) return;
  const prev = h.undo.pop(); if (prev === undefined) return;
  h.redo.push(h.baseline); h.baseline = prev; restoreMat(name, prev);
}
function matRedo(name: string): void {
  const h = ensureMatHist(name); if (!h) return;
  const next = h.redo.pop(); if (next === undefined) return;
  h.undo.push(h.baseline); h.baseline = next; restoreMat(name, next);
}

/** a model meta edit (calibration / material / collision) → record history, persist,
 *  and re-preview. Live gizmo drags call this once at drag-end. */
function onModelMetaChanged(name: string): void {
  recordMetaHistory(name);
  applyModelMetaEffects(name);
}

/** apply a model meta's current state everywhere (map viewport, file, preview)
 *  WITHOUT touching history — shared by edits and undo/redo. */
function applyModelMetaEffects(name: string): void {
  const meta = liveMeta(name);
  applyLiveModelMeta(name, meta);
  viewport.setModelMetas(catalog.models, true);   // re-pose/reskin map placements live (unsaved is fine)
  markModelDirty(name);
  const tab = tabs.active();
  if (tab?.kind === "model" && tab.model === name) {
    // the collision-mode toggle (top-left) only shows in manual mode, so re-evaluate
    // it whenever the meta changes (auto⇄manual flips its visibility + can snap the view)
    renderModes();
    const view = tabs.active()?.kind === "model" ? (tabs.active() as Tab).view ?? "model" : "model";
    if (view === "collision") preview.refreshCollision(meta);
    else void preview.showModel(name, "model", meta, true);
  }
}

// ── model-meta undo/redo (preview tabs) ──────────────────────────────────────
// Model/collision edits mutate a live working meta object, so history is a stack of
// JSON snapshots per model. `baseline` is the last recorded state; recording an edit
// pushes the baseline onto undo and re-baselines to the (already-mutated) current.
interface MetaHist { undo: string[]; redo: string[]; baseline: string }
const metaHistory = new Map<string, MetaHist>();
const META_HISTORY_CAP = 200;

/** capture the model's current meta as the history baseline the first time its tab
 *  is shown, so the first edit has a state to undo back to. */
function ensureMetaHist(name: string): MetaHist {
  let h = metaHistory.get(name);
  if (!h) { h = { undo: [], redo: [], baseline: JSON.stringify(liveMeta(name)) }; metaHistory.set(name, h); }
  return h;
}
function recordMetaHistory(name: string): void {
  const h = ensureMetaHist(name);
  const now = JSON.stringify(liveMeta(name));
  if (now === h.baseline) return;   // nothing actually changed
  h.undo.push(h.baseline);
  if (h.undo.length > META_HISTORY_CAP) h.undo.shift();
  h.redo.length = 0;
  h.baseline = now;
}
/** overwrite a live meta object in place (keeps its identity for open closures) */
function replaceMeta(target: ModelMeta, src: ModelMeta): void {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, JSON.parse(JSON.stringify(src)));
}
function restoreMeta(name: string, json: string): void {
  const meta = liveMeta(name);
  replaceMeta(meta, JSON.parse(json) as ModelMeta);
  // keep the collision selection valid against the restored solid count
  const n = (meta.collision === "manual" ? meta.collisionBoxes?.length : 0) ?? 0;
  if (selBox >= n) selBox = n - 1;
  applyModelMetaEffects(name);
  preview.selectBox(selBox);
  refreshInspector();
}
function metaUndo(name: string): void {
  const h = ensureMetaHist(name);
  const prev = h.undo.pop();
  if (prev === undefined) return;
  h.redo.push(h.baseline);
  h.baseline = prev;
  restoreMeta(name, prev);
}
function metaRedo(name: string): void {
  const h = ensureMetaHist(name);
  const next = h.redo.pop();
  if (next === undefined) return;
  h.undo.push(h.baseline);
  h.baseline = next;
  restoreMeta(name, next);
}

// ── viewport tab strip + view-mode control ───────────────────────────────────
const TAB_ICON: Record<Tab["kind"], IconName> = { map: "map", material: "material", model: "box" };
function tabTitle(t: Tab): string {
  if (t.kind === "map") return state.mapName(t.id);
  return t.material ?? t.model ?? t.kind;
}
function renderTabStrip(): void {
  const bar = $("vp-tabs");
  clear(bar);
  for (const t of tabs.tabs) {
    const b = el("button", "vp-tab" + (t.id === tabs.activeId ? " on" : ""));
    if (isTabDirty(t)) b.classList.add("dirty");   // unsaved (map, material or model)
    const ico = el("span", "vp-tab-ico"); ico.append(icon(TAB_ICON[t.kind]));
    b.append(ico, el("span", "vp-tab-name", tabTitle(t)));
    const x = el("button", "vp-tab-x"); x.append(icon("x"));
    x.title = "close tab";
    x.addEventListener("click", (e) => { e.stopPropagation(); void requestCloseTab(t.id); });
    b.append(x);
    b.addEventListener("click", () => tabs.focus(t.id));
    // middle-click a tab to close it (Unreal/browser convention); suppress the
    // browser's middle-click autoscroll on press.
    b.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); void requestCloseTab(t.id); } });
    bar.append(b);
  }
}

/** Model / Collision segmented control. Only shown on a model tab whose collision
 *  mode is "manual" — with automatic collision there are no solids to author, so
 *  the Collision view (and the whole toggle) would be empty. Switching a model back
 *  to auto in the inspector snaps its view to Model. */
function renderModes(): void {
  const box = $("vp-modes");
  clear(box);
  const tab = tabs.active();
  const manual = tab?.kind === "model" && !!tab.model && (liveMeta(tab.model).collision ?? "auto") === "manual";
  if (!manual) {
    box.style.display = "none";
    // never leave a model parked in the Collision view when it isn't manual
    if (tab?.kind === "model" && tab.view === "collision") tabs.setModelView(tab.id, "model");
    return;
  }
  box.style.display = "flex";
  for (const v of ["model", "collision"] as const) {
    const b = el("button", v === (tab!.view ?? "model") ? "on" : "", v === "model" ? "Model" : "Collision");
    b.addEventListener("click", () => tabs.setModelView(tab!.id, v));
    box.append(b);
  }
}

// ── left column visibility · preview environment picker · collision authoring ──
/** reflect save state in the toolbar: Save enabled when the active tab is dirty,
 *  Save As only for maps, Save All enabled when anything is unsaved. */
function renderSaveButtons(): void {
  const tab = tabs.active();
  const saveAs = document.getElementById("saveas-btn") as HTMLButtonElement | null;
  if (saveAs) saveAs.style.display = tabs.activeKind() === "map" ? "" : "none";
  const save = document.getElementById("save-btn") as HTMLButtonElement | null;
  if (save) { const d = !!tab && isTabDirty(tab); save.classList.toggle("on", d); save.disabled = !tab; }
  const all = document.getElementById("saveall-btn") as HTMLButtonElement | null;
  if (all) all.classList.toggle("on", anyDirty());
}

/** save the active tab's document to disk (map → maps/<id>.json; material/model →
 *  its asset file). No-op for a clean or absent tab. */
async function saveActiveTab(): Promise<void> {
  const tab = tabs.active(); if (!tab) return;
  if (tab.kind === "map") return void saveMap();
  if (tab.kind === "material" && tab.material) return saveMaterialFile(tab.material);
  if (tab.kind === "model" && tab.model) return saveModelFile(tab.model);
}

/** flush every unsaved document (open maps + dirty material/model assets) */
async function saveAll(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const id of state.documentIds()) if (state.isDirty(id)) jobs.push(saveMapDoc(id));
  for (const name of [...dirtyMaterials]) jobs.push(saveMaterialFile(name));
  for (const name of [...dirtyModels]) jobs.push(saveModelFile(name));
  if (!jobs.length) { toast("nothing to save"); return; }
  await Promise.all(jobs);
  toast(`saved ${jobs.length} document${jobs.length === 1 ? "" : "s"}`);
}

/** close a tab, prompting first if it has unsaved changes (Save / Discard / Cancel).
 *  Saving a material/model here also persists it; a map saves via its own flow. */
async function requestCloseTab(id: string): Promise<void> {
  const t = tabs.find(id);
  if (t && isTabDirty(t)) {
    const what = t.kind === "map" ? `Map "${state.mapName(t.id)}"` : `${t.kind} "${t.material ?? t.model}"`;
    const choice = await confirmUnsaved(what);
    if (choice === "cancel") return;
    if (choice === "save") {
      if (t.kind === "map") await saveMapDoc(t.id);
      else if (t.kind === "material" && t.material) await saveMaterialFile(t.material);
      else if (t.kind === "model" && t.model) await saveModelFile(t.model);
    } else {   // discard → drop the dirty mark so nothing lingers
      if (t.kind === "material" && t.material) dirtyMaterials.delete(t.material);
      if (t.kind === "model" && t.model) dirtyModels.delete(t.model);
    }
  }
  tabs.close(id);
}

/** the left column (scene outliner) belongs to map tabs; preview tabs hide it
 *  entirely (their asset controls live in the inspector on the right). */
function renderLeftPanel(): void {
  const isMap = tabs.activeKind() === "map" || tabs.activeKind() === null;
  document.getElementById("main")!.classList.toggle("no-left", !isMap);
  if (isMap) $("left-head").textContent = "Scene Outliner";
}

/** show the small “Environment” button on any preview tab (material or model); it
 *  opens the HDRI picker for the preview, driving the skybox + the reflections on
 *  the previewed sphere/model. */
function renderEnvButton(): void {
  const btn = $("vp-envbtn") as HTMLButtonElement;
  const kind = tabs.activeKind();
  const show = kind === "material" || kind === "model";
  btn.classList.toggle("on", show);
  btn.onclick = show ? openEnvPicker : null;
}

/** modal HDRI picker for the material/texture preview environment (drives the
 *  visible skybox + the sphere's reflections). Stays open so you can compare. */
function openEnvPicker(): void {
  const body = el("div", "env-swatch");
  modal("Preview environment", body);
  const draw = (): void => {
    clear(body);
    const cur = preview.currentHdri();
    const card = (name: string | null, label: string): HTMLElement => {
      const c = el("div", "env-card" + ((name ?? null) === cur ? " on" : ""));
      const thumb = el("div", "asset-thumb");
      if (name) { const h = catalog.hdri.find((x) => x.name === name); if (h) void thumbs.hdriThumb(h.file).then((u) => { if (u) { const img = el("img", "thumb-img"); img.src = u; thumb.replaceChildren(img); } }); }
      else thumb.append(icon("x", "asset-icon-svg"));
      c.append(thumb, el("div", "env-name", label));
      c.addEventListener("click", () => { void preview.setHdri(name).then(draw); });
      return c;
    };
    body.append(card(null, "None"));
    for (const h of catalog.hdri) body.append(card(h.name, h.name));
  };
  draw();
}

// ── collision authoring (the list lives in the inspector; solids are gizmo-edited
// directly in the viewport, reusing the same move/scale tools as map objects) ──
function collSelect(i: number): void { selBox = i; preview.selectBox(i); refreshInspector(); }

function collAdd(): void {
  const tab = tabs.active(); if (tab?.kind !== "model" || !tab.model) return;
  const meta = liveMeta(tab.model);
  // author solids in the Collision view; drop the new one at the model centre so it's
  // visible immediately (not hidden at the origin), pre-selected for a straight drag.
  if (tab.view !== "collision") tabs.setModelView(tab.id, "collision");
  const at = preview.modelCenter();
  (meta.collisionBoxes ??= []).push({ at, size: [0.5, 0.5, 0.5] });
  selBox = meta.collisionBoxes.length - 1;
  onModelMetaChanged(tab.model);
  preview.selectBox(selBox);
  refreshInspector();
}

function collDelete(i: number): void {
  const tab = tabs.active(); if (tab?.kind !== "model" || !tab.model) return;
  const meta = liveMeta(tab.model);
  const boxes = meta.collisionBoxes ?? [];
  if (i < 0 || i >= boxes.length) return;
  boxes.splice(i, 1);
  if (selBox >= boxes.length) selBox = boxes.length - 1;
  onModelMetaChanged(tab.model);
  preview.selectBox(selBox);
  refreshInspector();
}

// ── keyboard: undo/redo · clipboard · delete · grouping ──────────────────────
let clipboard: Placement[] = [];
// last pointer position over the map viewport canvas — drives paste-at-cursor
const cursor: { x: number; y: number; inside: boolean } = { x: 0, y: 0, inside: false };
function trackCursor(): void {
  const canvas = $("editor-canvas");
  const update = (e: PointerEvent | MouseEvent): void => {
    const rc = canvas.getBoundingClientRect();
    cursor.x = e.clientX; cursor.y = e.clientY;
    cursor.inside = rc.width > 0 && e.clientX >= rc.left && e.clientX <= rc.right && e.clientY >= rc.top && e.clientY <= rc.bottom;
  };
  window.addEventListener("pointermove", update);
  canvas.addEventListener("pointerleave", () => { cursor.inside = false; });
}
/** whether a key event's target is a text-entry field we shouldn't hijack. Only
 *  TEXT-like inputs count: a focused colour swatch / checkbox has no native Ctrl+Z,
 *  so treating it as "typing" would swallow undo/redo after a colour pick — the exact
 *  reason Ctrl+Z did nothing on colour params. Those non-text inputs fall through so
 *  the shortcut reaches the map/asset history. */
function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n) return false;
  if (n.isContentEditable || n.tagName === "SELECT" || n.tagName === "TEXTAREA") return true;
  if (n.tagName === "INPUT") { const t = (n as HTMLInputElement).type; return t !== "color" && t !== "checkbox" && t !== "range"; }
  return false;
}
function bindUndoRedo(): void {
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const kind = tabs.activeKind();
    // preview tabs (material / model) have their own per-asset edit history
    if (kind === "model" || kind === "material") {
      const tab = tabs.active();
      const undo = mod && k === "z" && !e.shiftKey;
      const redo = mod && ((k === "z" && e.shiftKey) || k === "y");
      if (!undo && !redo) return;
      e.preventDefault();
      if (kind === "model" && tab?.model) { if (undo) metaUndo(tab.model); else metaRedo(tab.model); }
      else if (kind === "material" && tab?.material) { if (undo) matUndo(tab.material); else matRedo(tab.material); }
      return;
    }
    if (kind !== "map") return;   // history/clipboard apply to map tabs
    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); state.undo(); return; }
    if (mod && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); state.redo(); return; }
    if (mod && k === "c") { e.preventDefault(); copySelection(); return; }
    if (mod && k === "x") { e.preventDefault(); copySelection(); deleteSelection(); return; }
    if (mod && k === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (mod && k === "g" && !e.shiftKey) { e.preventDefault(); const id = state.createGroup(); if (id) state.selectGroup(id, "outliner"); return; }
    if (mod && k === "g" && e.shiftKey) { e.preventDefault(); ungroupSelection(); return; }
    if (!mod && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelection(); return; }
  });
}

function copySelection(): void {
  const sel = state.selectedObjects();
  if (sel.length) clipboard = JSON.parse(JSON.stringify(sel));
}
function pasteClipboard(): void {
  if (!clipboard.length) return;
  const copies: Placement[] = JSON.parse(JSON.stringify(clipboard));
  // paste under the cursor when it's over the map viewport (the first copied
  // object lands where the cursor is, the rest keep their relative layout);
  // otherwise offset from the originals so the paste doesn't hide behind them.
  let delta: Tuple3 = [2, 0, 2];
  if (cursor.inside) {
    const target = viewport.dropSurface(cursor.x, cursor.y);
    if (target) { const a = clipboard[0].at; delta = [target[0] - a[0], target[1] - a[1], target[2] - a[2]]; }
  }
  for (const c of copies) { c.at = [c.at[0] + delta[0], c.at[1] + delta[1], c.at[2] + delta[2]]; delete c.group; }
  state.addMany(copies);
}
function deleteSelection(): void {
  const sel = state.selectedObjects();
  if (sel.length) state.removeObjects(sel);
}
function ungroupSelection(): void {
  const o = state.selected() ?? state.selectedObjects()[0];
  if (o?.group) state.ungroup(o.group);
}

/** Ctrl/Cmd+S saves the active document; Ctrl/Cmd+Shift+S saves all. A native
 *  beforeunload prompt guards against leaving the editor with unsaved work. */
function bindSaveShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (e.shiftKey) void saveAll(); else void saveActiveTab();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = "";   // browsers show their standard "leave site?" prompt
  });
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function buildToolbar(): void {
  const bar = $("toolbar");
  const logo = el("img", "brand-icon") as HTMLImageElement;
  logo.src = `${import.meta.env.BASE_URL}logo.png`; logo.alt = "SlopWars";
  // Save acts on the active document — a map, or a material/model asset. Save As is
  // map-only (asset names are renamed in-place). Save All flushes every dirty doc.
  const saveGroup = el("span", "save-group"); saveGroup.id = "save-group";
  const saveBtn = iconButton("save", "Save", () => void saveActiveTab(), "primary"); saveBtn.id = "save-btn";
  const saveAsBtn = button("Save As…", () => void saveMapAs()); saveAsBtn.id = "saveas-btn";
  const saveAllBtn = button("Save All", () => void saveAll()); saveAllBtn.id = "saveall-btn";
  saveGroup.append(saveBtn, saveAsBtn, saveAllBtn, el("span", "bar-sep"));
  bar.append(logo, el("span", "brand", "Editor"), saveGroup);

  const tools = el("div", "tool-group");
  for (const { t, label } of TOOLS) {
    const b = el("button", "btn tool", label); b.dataset.tool = t;
    b.addEventListener("click", () => selectTool(t));
    tools.append(b);
  }
  bar.append(tools, el("span", "bar-sep"), el("span", "bar-label", "Graphics"), graphicsPicker());

  const name = el("span", "map-name"); name.id = "map-name"; bar.append(name);
  highlightTool("move");
}

function graphicsPicker(): HTMLElement {
  const sel = el("select", "map-picker") as HTMLSelectElement;
  for (const g of GRAPHICS) { const o = el("option", undefined, g); o.value = g; sel.append(o); }
  sel.value = "high";
  sel.addEventListener("change", () => viewport.setGraphics(sel.value as typeof GRAPHICS[number]));
  return sel;
}

function buildDock(): void {
  browser = renderBrowser($("browser"), {
    catalog, thumbs,
    reloadCatalog: async () => { await refreshCatalog(); return catalog; },
    listMaps: () => api.maps(),
    onOpenMaterial: (name) => tabs.openMaterial(name),
    onOpenModel: (name) => tabs.openModel(name),
    onCreateMaterial: () => void createMaterialFlow(),
    onLoadMap: (file) => void openMap(file),
    onCreateMap: () => { tabs.newMap(); },
    onDeleteModel: (name) => void deleteModelFlow(name),
    onDeleteMaterial: (name) => void deleteMaterialFlow(name),
    onDeleteTexture: (name) => void deleteTextureFlow(name),
    onDeleteHdri: (file) => void deleteAssetFlow(file, "skybox"),
    onDeleteAudio: (file) => void deleteAssetFlow(file, "audio"),
    onDeleteMap: (file) => void deleteMapFlow(file),
  });
}

/** create a plain gray material, refresh the browser, and open it in a tab */
async function createMaterialFlow(): Promise<void> {
  try {
    const r = await api.createMaterial();
    if (!r.name) { toast("create material failed: " + (r.error ?? ""), true); return; }
    await refreshCatalog();
    await browser?.reload();
    browser?.showMaterials();
    tabs.openMaterial(r.name);
  } catch (e) { toast("create material failed: " + e, true); }
}

/** patch the in-memory catalog with a live model-meta edit so the map viewport
 *  (which reads catalog metas) previews it before the debounced file write lands */
function applyLiveModelMeta(name: string, meta: ModelMeta): void {
  const m = catalog.models.find((x) => x.name === name);
  if (m) m.meta = JSON.parse(JSON.stringify(meta));
}

async function deleteMaterialFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteMaterial(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    dirtyMaterials.delete(name); matHistory.delete(name);
    tabs.closeAsset("material", name);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted material "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

async function deleteModelFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteModel(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    modelEdits.delete(name); dirtyModels.delete(name); metaHistory.delete(name);
    tabs.closeAsset("model", name);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted model "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

async function deleteTextureFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteTexture(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted texture "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** delete a single-file asset (skybox / audio) by its catalog path, then refresh */
async function deleteAssetFlow(file: string, label: string): Promise<void> {
  try {
    const r = await api.deleteAsset(file);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted ${label}`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** delete a map file, then refresh the Maps list */
async function deleteMapFlow(file: string): Promise<void> {
  try {
    const r = await api.deleteMap(file);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    browser?.refreshMaps();
    toast(`deleted ${file}`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** rename a material file + repoint every open map's references, then retarget its tab */
async function renameMaterial(from: string, to: string): Promise<void> {
  try {
    const r = await api.renameMaterial(from, to);
    if (!r.name) { toast("rename failed: " + (r.error ?? ""), true); return; }
    // repoint references in the active map (other open maps repoint on next load)
    for (const o of state.map?.objects ?? []) {
      if ((o.params as { mat?: string } | undefined)?.mat === from) (o.params as { mat: string }).mat = r.name;
    }
    if (dirtyMaterials.delete(from)) dirtyMaterials.add(r.name);   // carry unsaved state to the new name
    const h = matHistory.get(from); if (h) { matHistory.delete(from); matHistory.set(r.name, h); }
    tabs.retargetMaterial(from, r.name);
    await refreshCatalog(true);
    await browser?.reload();
    renderTabStrip();
    refreshInspector();
  } catch (e) { toast("rename failed: " + e, true); }
}

function selectTool(t: Tool): void { viewport.setTool(t); highlightTool(t); preview.setGizmoTool(t); }
function highlightTool(t: Tool): void {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>(".btn.tool"))) b.classList.toggle("on", b.dataset.tool === t);
}

function showPerf(p: PerfStats): void {
  const n = document.getElementById("perf");
  if (n) n.textContent = `${p.fps} fps · ${p.objects} obj · ${p.draws} draws · ${(p.tris / 1000).toFixed(1)}k tris`;
}
function refreshMapName(): void {
  const n = document.getElementById("map-name");
  if (n) n.textContent = state.map ? state.map.meta.name + (state.dirty ? " *" : "") : "";
}

// ── map management ────────────────────────────────────────────────────────────
async function openMap(file: string): Promise<void> {
  try {
    const id = file.replace(/^.*\//, "").replace(/\.json$/, "");
    const existing = state.docIdForFile(id);
    if (existing) { tabs.focusMapDoc(existing); return; }
    const def = await api.loadMap(file);
    tabs.openMap(def, id);
    if (viewport.ready && state.map) await viewport.render(state.map);
    refreshMapName();
  } catch (e) { toast("open failed: " + e, true); }
}

async function saveMap(): Promise<void> {
  const map = state.map; if (!map) return;
  const id = map.meta.id || state.fileId;
  try { await api.saveMap(id, map); state.dirty = false; refreshMapName(); renderTabStrip(); renderSaveButtons(); browser?.refreshMaps(); toast(`saved maps/${id}.json`); }
  catch (e) { toast("save failed: " + e, true); }
}

/** save a specific map document (possibly a background tab) — used by Save All */
async function saveMapDoc(docId: string): Promise<void> {
  const map = state.docMap(docId); if (!map) return;
  const id = map.meta.id || state.docFileId(docId);
  try { await api.saveMap(id, map); state.markDocSaved(docId); renderTabStrip(); renderSaveButtons(); browser?.refreshMaps(); }
  catch (e) { toast("save failed: " + e, true); }
}

async function saveMapAs(): Promise<void> {
  const map = state.map; if (!map) return;
  const id = prompt("Save as map id:", map.meta.id);
  if (!id) return;
  map.meta.id = id.replace(/[^a-zA-Z0-9_-]/g, "");
  state.fileId = map.meta.id;
  await saveMap();
}

// ── placement ─────────────────────────────────────────────────────────────────
function add(o: Placement): void { state.add(o); }

function setupDrop(): void {
  const vp = $("viewport");
  vp.addEventListener("dragover", (e) => e.preventDefault());
  vp.addEventListener("drop", (e) => {
    e.preventDefault();
    if (tabs.activeKind() !== "map") return;   // only place into a map viewport
    const raw = e.dataTransfer?.getData("application/x-slop"); if (!raw) return;
    const p = JSON.parse(raw) as Payload;
    const at = viewport.dropSurface(e.clientX, e.clientY) ?? [0, 0, 0] as Tuple3;
    if (p.kind === "model") add({ type: "prop", at, params: { model: p.name } });
    else if (p.kind === "audio") add({ type: "sound", at: [at[0], at[1] + 1.5, at[2]], params: { clip: p.name } });
    else if (p.kind === "object") add(objectPlacement(p.name, at));
  });
}

function objectPlacement(type: string, at: Tuple3): Placement {
  if (type === "box") return { type, at: [at[0], at[1] + 1, at[2]], scale: [4, 2, 4] };
  if (type === "pickup" || type === "powerup") return { type, at: [at[0], at[1] + 1, at[2]] };
  if (type === "sound") return { type, at: [at[0], at[1] + 2, at[2]] };
  if (type === "particles" || type === "fire" || type === "smoke") return { type, at: [at[0], at[1] + 0.3, at[2]] };
  const s = objectDropScale(type);
  if (s !== 1) return { type, at, scale: [s, s, s] };
  return { type, at };
}

// ── viewport sync ─────────────────────────────────────────────────────────────
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => { if (tabs.activeKind() === "map" && state.map) void viewport.render(state.map); }, 140);
}

void main();
