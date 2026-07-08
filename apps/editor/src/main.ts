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
import { renderInspector, refreshInspector, setInspectorCatalog, setInspectorThumbs, setInspectorMaterialHooks, setInspectorModelHooks, setInspectorTextureHooks } from "./inspector";
import { renderBrowser, Payload, type BrowserControl } from "./panels";
import { mountResizers } from "./layout";
import { objectDropScale } from "@game/objects";
import { startMcpBridge } from "./mcpbridge";
import { api } from "./api";
import { el, clear, button, toast, modal } from "./ui";

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

// debounced material/model-meta writes (a drag mutates the def many times/sec)
let matSaveTimer = 0;
function saveMaterialSoon(name: string, def: MaterialDef): void {
  window.clearTimeout(matSaveTimer);
  matSaveTimer = window.setTimeout(() => { void api.saveMaterial(name, def).catch((e) => toast("material save failed: " + e, true)); }, 250);
}
let metaSaveTimer = 0;
function saveModelMetaSoon(name: string, meta: ModelMeta): void {
  window.clearTimeout(metaSaveTimer);
  metaSaveTimer = window.setTimeout(() => { void api.saveModelMeta(name, meta).catch((e) => toast("model save failed: " + e, true)); }, 250);
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
    changed: (name, def) => { viewport.setMaterials(catalog.materials, true); saveMaterialSoon(name, def); previewMaterialEdit(name, def); },
    renamed: (from, to) => { void renameMaterial(from, to); },
    deleted: (name) => { void deleteMaterialFlow(name); },
  });
  setInspectorModelHooks({
    meta: (name) => liveMeta(name),
    changed: (name) => onModelMetaChanged(name),
    deleted: (name) => { void deleteModelFlow(name); },
    collSel: () => selBox,
    collSelect: (i) => collSelect(i),
    collAdd: () => collAdd(),
    collDelete: (i) => collDelete(i),
  });
  setInspectorTextureHooks({ deleted: (name) => { void deleteTextureFlow(name); } });

  buildToolbar();
  mountSceneGraph($("scene-graph"));
  buildDock();
  bindUndoRedo();
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
  tabs.onChange(() => { renderTabStrip(); syncViewport(); renderLeftPanel(); renderInspector($("inspector")); });

  viewport.onToolChange((t) => { highlightTool(t); preview.setGizmoTool(t); });
  viewport.onEditCommit = () => state.commit(true);
  viewport.onPerf = showPerf;

  // clicking a collision solid in the preview selects it → reflect in the inspector list
  preview.onCollisionSelect = (i) => { selBox = i; refreshInspector(); };
  // a gizmo drag in the preview mutated the selected solid → persist + re-shade
  preview.onCollisionChange = () => { const t = tabs.active(); if (t?.kind === "model" && t.model) onModelMetaChanged(t.model); };

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
  $("vp-stage").classList.toggle("preview", isPreview);
  preview.show(isPreview);
  renderModes();
  renderEnvButton();

  const key = tab ? `${tab.kind}:${tab.material ?? tab.texture ?? tab.model ?? ""}:${tab.view ?? ""}` : "";
  if (isPreview && key !== previewKey && preview.ready) {
    if (tab!.kind === "material") {
      const m = catalog.materials.find((x) => x.name === tab!.material);
      if (m) void preview.showMaterial(m.name, m.def);
      ensureEnv();
    } else if (tab!.kind === "texture") {
      void preview.showTexture(tab!.texture!);
      ensureEnv();
    } else if (tab!.kind === "model") {
      selBox = -1;
      void preview.showModel(tab!.model!, tab!.view ?? "model", liveMeta(tab!.model!));
    }
  }
  previewKey = isPreview ? key : "";
  if (kind === "map" && viewport.ready && state.map) void viewport.render(state.map);
}

/** default the material/texture preview to an environment for nice reflections */
function ensureEnv(): void {
  if (preview.currentHdri() === null && catalog.hdri.length) void preview.setHdri(catalog.hdri[0].name);
}

/** live material edit → rebuild the preview sphere (keeping the orbit) if its tab is active */
function previewMaterialEdit(name: string, def: MaterialDef): void {
  const tab = tabs.active();
  if (tab?.kind === "material" && tab.material === name) void preview.showMaterial(name, def, true);
}

/** a model meta edit (calibration / material / collision) → persist + re-preview */
function onModelMetaChanged(name: string): void {
  const meta = liveMeta(name);
  applyLiveModelMeta(name, meta);
  viewport.setModelMetas(catalog.models, true);   // re-pose/reskin map placements live
  saveModelMetaSoon(name, meta);
  const tab = tabs.active();
  if (tab?.kind === "model" && tab.model === name) {
    if (tab.view === "collision") preview.refreshCollision(meta);
    else void preview.showModel(name, "model", meta, true);
  }
}

// ── viewport tab strip + view-mode control ───────────────────────────────────
const TAB_ICON: Record<Tab["kind"], string> = { map: "🗺", material: "◆", model: "▣", texture: "▦" };
function tabTitle(t: Tab): string {
  if (t.kind === "map") return state.mapName(t.id);
  return t.material ?? t.model ?? t.texture ?? t.kind;
}
function renderTabStrip(): void {
  const bar = $("vp-tabs");
  clear(bar);
  for (const t of tabs.tabs) {
    const b = el("button", "vp-tab" + (t.id === tabs.activeId ? " on" : ""));
    if (t.kind === "map" && state.isDirty(t.id)) b.classList.add("dirty");
    b.append(el("span", "vp-tab-ico", TAB_ICON[t.kind]), el("span", "vp-tab-name", tabTitle(t)));
    const x = el("button", "vp-tab-x", "✕");
    x.title = "close tab";
    x.addEventListener("click", (e) => { e.stopPropagation(); tabs.close(t.id); });
    b.append(x);
    b.addEventListener("click", () => tabs.focus(t.id));
    // middle-click a tab to close it (Unreal/browser convention); suppress the
    // browser's middle-click autoscroll on press.
    b.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); tabs.close(t.id); } });
    bar.append(b);
  }
}

/** Model / Collision segmented control (only for model tabs) */
function renderModes(): void {
  const box = $("vp-modes");
  clear(box);
  const tab = tabs.active();
  if (tab?.kind !== "model") { box.style.display = "none"; return; }
  box.style.display = "flex";
  for (const v of ["model", "collision"] as const) {
    const b = el("button", v === (tab.view ?? "model") ? "on" : "", v === "model" ? "Model" : "Collision");
    b.addEventListener("click", () => tabs.setModelView(tab.id, v));
    box.append(b);
  }
}

// ── left column visibility · preview environment picker · collision authoring ──
/** the left column (scene outliner) belongs to map tabs; preview tabs hide it
 *  entirely (their asset controls live in the inspector on the right). */
function renderLeftPanel(): void {
  const isMap = tabs.activeKind() === "map" || tabs.activeKind() === null;
  document.getElementById("main")!.classList.toggle("no-left", !isMap);
  if (isMap) $("left-head").textContent = "Scene Outliner";
}

/** show the small “Environment” button only on material/texture tabs; it opens the
 *  HDRI picker for the preview (replaces the old dedicated left environment section). */
function renderEnvButton(): void {
  const btn = $("vp-envbtn") as HTMLButtonElement;
  const kind = tabs.activeKind();
  const show = kind === "material" || kind === "texture";
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
      else thumb.append(el("div", "asset-icon", "∅"));
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
  (meta.collisionBoxes ??= []).push({ at: [0, 0, 0], size: [0.5, 0.5, 0.5] });
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
function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "SELECT" || n.tagName === "TEXTAREA" || n.isContentEditable);
}
function bindUndoRedo(): void {
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (tabs.activeKind() !== "map") return;   // history/clipboard apply to map tabs
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
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

// ── toolbar ─────────────────────────────────────────────────────────────────
function buildToolbar(): void {
  const bar = $("toolbar");
  const logo = el("img", "brand-icon") as HTMLImageElement;
  logo.src = `${import.meta.env.BASE_URL}logo.png`; logo.alt = "SlopWars";
  bar.append(logo, el("span", "brand", "Editor"),
    button("Save", saveMap, "primary"), button("Save As…", saveMapAs),
    el("span", "bar-sep"));

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
    onOpenTexture: (name) => tabs.openTexture(name),
    onCreateMaterial: () => void createMaterialFlow(),
    onLoadMap: (file) => void openMap(file),
    onCreateMap: () => { tabs.newMap(); },
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
    modelEdits.delete(name);
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
    tabs.closeAsset("texture", name);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted texture "${name}"`);
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
  try { await api.saveMap(id, map); state.dirty = false; refreshMapName(); renderTabStrip(); browser?.refreshMaps(); toast(`saved maps/${id}.json`); }
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
