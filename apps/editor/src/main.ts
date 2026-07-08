// ─── SlopWars Map Editor — shell + wiring ────────────────────────────────────
// Toolbar (New/Load/Save · transform tools · graphics preset · map name) · left
// scene graph (World + objects) · center 3D viewport with fly camera + gizmos ·
// right inspector · bottom asset browser. Panels are resizable. Everything placed
// is an object; edits mutate an in-memory MapDef saved to maps/<id>.json via the
// dev API. Editor opens on a blank map; Load pulls an existing one.
import type { AssetCatalog, Placement, Tuple3 } from "@slopwars/shared";
import { emptyMap } from "@slopwars/shared";
import { Viewport, Tool, PerfStats } from "./viewport";
import { ThumbRenderer } from "./preview";
import { state } from "./state";
import { mountSceneGraph } from "./scenegraph";
import { renderInspector, setInspectorCatalog, setInspectorThumbs, setInspectorMaterialHooks, setInspectorModelHooks, setInspectorTextureHooks } from "./inspector";
import type { MaterialDef, ModelMeta } from "@slopwars/shared";
import { renderBrowser, Payload, type BrowserControl } from "./panels";
import { mountResizers } from "./layout";
import { objectDropScale } from "@game/objects";
import { startMcpBridge } from "./mcpbridge";
import { api } from "./api";
import { el, button, toast } from "./ui";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const viewport = new Viewport();
const thumbs = new ThumbRenderer();
let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
let browser: BrowserControl | null = null;
let rebuildTimer = 0;

const TOOLS: { t: Tool; label: string }[] = [
  { t: "move", label: "Move" },
  { t: "rotate", label: "Rotate" },
  { t: "scale", label: "Scale" },
];
const GRAPHICS = ["low", "medium", "high"] as const;

async function loadCatalog(): Promise<AssetCatalog> {
  return api.catalog();
}

/** re-fetch the catalog and push it everywhere that caches material defs (the
 *  inspector + the viewport's live shader). `reshade` rebuilds the viewport so a
 *  material change is visible. */
async function refreshCatalog(reshade = false): Promise<void> {
  catalog = await loadCatalog();
  setInspectorCatalog(catalog);
  viewport.setMaterials(catalog.materials, false);
  viewport.setModelMetas(catalog.models, reshade);
}

// debounced material-file writes (a colour drag mutates the def many times/sec;
// we re-shade live every change but only persist to disk after it settles)
let matSaveTimer = 0;
function saveMaterialSoon(name: string, def: MaterialDef): void {
  window.clearTimeout(matSaveTimer);
  matSaveTimer = window.setTimeout(() => { void api.saveMaterial(name, def).catch((e) => toast("material save failed: " + e, true)); }, 250);
}

// debounced model-meta writes (base/scale drags), same pattern as materials
let metaSaveTimer = 0;
function saveModelMetaSoon(name: string, meta: ModelMeta): void {
  window.clearTimeout(metaSaveTimer);
  metaSaveTimer = window.setTimeout(() => { void api.saveModelMeta(name, meta).catch((e) => toast("model save failed: " + e, true)); }, 250);
}

async function main(): Promise<void> {
  try { catalog = await loadCatalog(); } catch (e) { toast("catalog load failed: " + e, true); }
  setInspectorCatalog(catalog);
  setInspectorThumbs(thumbs);
  setInspectorMaterialHooks({
    // editing a material: re-shade the viewport immediately, persist shortly after
    changed: (name, def) => { viewport.setMaterials(catalog.materials, true); saveMaterialSoon(name, def); },
    renamed: (from, to) => { void renameMaterial(from, to); },
    deleted: (name) => { void deleteMaterialFlow(name); },
  });
  setInspectorModelHooks({
    // editing a model's meta: update the live metas + re-pose in the viewport, then
    // persist. `meta` is a live object the inspector mutates, so re-read it on save.
    changed: (name, meta) => { applyLiveModelMeta(name, meta); viewport.setModelMetas(catalog.models, true); saveModelMetaSoon(name, meta); },
    deleted: (name) => { void deleteModelFlow(name); },
  });
  setInspectorTextureHooks({ deleted: (name) => { void deleteTextureFlow(name); } });

  buildToolbar();
  mountSceneGraph($("scene-graph"));
  buildDock();
  bindUndoRedo();
  mountResizers();

  state.onChange(() => { scheduleRebuild(); refreshMapName(); });
  state.onSelect(() => renderInspector($("inspector")));
  // selecting in the outliner reframes the camera on the object (centres it).
  // Consume the source afterwards so the *same* selection being re-emitted by a
  // later commit (e.g. finishing a gizmo move, an inspector edit) doesn't fly the
  // camera back onto the object — you'd lose your framing every time you nudge it.
  state.onSelect(() => {
    if (state.selectSource === "outliner" && (state.selIndex >= 0 || state.selectedObjects().length)) {
      viewport.focusSelected();
      state.selectSource = "";
    }
  });
  viewport.onToolChange(highlightTool);
  viewport.onEditCommit = () => state.commit(true);
  viewport.onPerf = showPerf;

  newMap();          // start on a blank map (Load opens an existing one)
  setupDrop();

  viewport.init("editor-canvas")
    .then(() => { viewport.setGraphics("high"); viewport.setMaterials(catalog.materials); viewport.setModelMetas(catalog.models); if (state.map) return viewport.render(state.map); })
    .catch((e) => { console.error("viewport init failed (data editing still works):", e); toast("3D viewport unavailable", true); });
  thumbs.init().catch(() => { /* thumbnails optional */ });

  // MCP bridge: lets external AI tools drive this editor while it's open
  startMcpBridge({
    viewport,
    getCatalog: () => catalog,
    reloadCatalog: async () => { catalog = await loadCatalog(); setInspectorCatalog(catalog); return catalog; },
    saveMap,
    loadMap: openMap,
    newMap,
  });
}

// ── keyboard: undo/redo · clipboard · delete · grouping ──────────────────────
let clipboard: Placement[] = [];
function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "SELECT" || n.tagName === "TEXTAREA" || n.isContentEditable);
}
function bindUndoRedo(): void {
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); state.undo(); return; }
    if (mod && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); state.redo(); return; }

    // clipboard (copy/cut/paste operate on the whole selection)
    if (mod && k === "c") { e.preventDefault(); copySelection(); return; }
    if (mod && k === "x") { e.preventDefault(); copySelection(); deleteSelection(); return; }
    if (mod && k === "v") { e.preventDefault(); pasteClipboard(); return; }

    // grouping
    if (mod && k === "g" && !e.shiftKey) { e.preventDefault(); const id = state.createGroup(); if (id) state.selectGroup(id, "outliner"); return; }
    if (mod && k === "g" && e.shiftKey) { e.preventDefault(); ungroupSelection(); return; }

    // delete
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
  for (const c of copies) { c.at = [c.at[0] + 2, c.at[1], c.at[2] + 2]; delete c.group; }  // paste at top level, offset
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
  // New/Load live in the Maps tab of the asset browser now; Save/Save As stay here
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
    onSelectMaterial: (name) => state.selectMaterial(name),
    onSelectModel: (name) => state.selectModel(name),
    onSelectTexture: (name) => state.selectTexture(name),
    onCreateMaterial: () => void createMaterialFlow(),
    onLoadMap: (file) => void openMap(file),
    onCreateMap: () => newMap(),
  });
}

/** create a plain gray material, refresh the browser, and open it for editing
 *  (its kind is then chosen via the inspector's type switcher — no up-front pick) */
async function createMaterialFlow(): Promise<void> {
  try {
    const r = await api.createMaterial();
    if (!r.name) { toast("create material failed: " + (r.error ?? ""), true); return; }
    await browser?.reload();
    browser?.showMaterials();
    state.selectMaterial(r.name);
  } catch (e) { toast("create material failed: " + e, true); }
}

/** patch the in-memory catalog with a live model-meta edit, so the viewport (which
 *  reads catalog metas) previews it before the debounced file write lands */
function applyLiveModelMeta(name: string, meta: ModelMeta): void {
  const m = catalog.models.find((x) => x.name === name);
  if (m) m.meta = { ...meta };
}

/** delete a material file, then refresh: objects that named it now render the
 *  default material (dangling ref), and the inspector flags the name in red. */
async function deleteMaterialFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteMaterial(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    state.selectMaterial(null);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted material "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** delete a model folder, then refresh: placements that named it render nothing
 *  (dangling ref), handled gracefully by the loader. */
async function deleteModelFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteModel(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    state.selectModel(null);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted model "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** delete a texture folder, then refresh: materials that used it fall back to the
 *  default texture folder. */
async function deleteTextureFlow(name: string): Promise<void> {
  try {
    const r = await api.deleteTexture(name);
    if (r.error) { toast("delete failed: " + r.error, true); return; }
    state.selectTexture(null);
    await refreshCatalog(true);
    await browser?.reload();
    toast(`deleted texture "${name}"`);
  } catch (e) { toast("delete failed: " + e, true); }
}

/** rename a material file + repoint the loaded map's references, then reselect */
async function renameMaterial(from: string, to: string): Promise<void> {
  try {
    const r = await api.renameMaterial(from, to);
    if (!r.name) { toast("rename failed: " + (r.error ?? ""), true); return; }
    for (const o of state.map?.objects ?? []) {
      if ((o.params as { mat?: string } | undefined)?.mat === from) (o.params as { mat: string }).mat = r.name;
    }
    await refreshCatalog(true);
    await browser?.reload();
    state.selectMaterial(r.name);
  } catch (e) { toast("rename failed: " + e, true); }
}

function selectTool(t: Tool): void { viewport.setTool(t); highlightTool(t); }
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

// ── map management (New/Load are the Maps tab of the asset browser) ──────────
async function openMap(file: string): Promise<void> {
  try {
    const def = await api.loadMap(file);
    const id = file.replace(/^.*\//, "").replace(/\.json$/, "");
    state.setMap(def, id);
    if (viewport.ready) await viewport.render(def);
    refreshMapName();
  } catch (e) { toast("open failed: " + e, true); }
}

function newMap(): void {
  const id = `untitled-${Math.random().toString(36).slice(2, 6)}`;
  state.setMap(emptyMap(id, "Untitled"), id);
  if (viewport.ready && state.map) void viewport.render(state.map);
  refreshMapName();
}

async function saveMap(): Promise<void> {
  const map = state.map; if (!map) return;
  const id = map.meta.id || state.fileId;
  try { await api.saveMap(id, map); state.dirty = false; refreshMapName(); browser?.refreshMaps(); toast(`saved maps/${id}.json`); }
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
    const raw = e.dataTransfer?.getData("application/x-slop"); if (!raw) return;
    const p = JSON.parse(raw) as Payload;
    const at = viewport.dropSurface(e.clientX, e.clientY) ?? [0, 0, 0] as Tuple3;
    if (p.kind === "model") add({ type: "prop", at, params: { model: p.name } });
    else if (p.kind === "audio") add({ type: "sound", at: [at[0], at[1] + 1.5, at[2]], params: { clip: p.name } });
    else if (p.kind === "object") add(objectPlacement(p.name, at));
    // textures / HDRIs aren't placeable here — a texture goes on a box's `tex`,
    // an HDRI onto the World sky (both via the inspector's asset slots).
  });
}

/** sensible starting transform for an object type dropped onto the ground */
function objectPlacement(type: string, at: Tuple3): Placement {
  if (type === "box") return { type, at: [at[0], at[1] + 1, at[2]], scale: [4, 2, 4] };
  if (type === "pickup" || type === "powerup") return { type, at: [at[0], at[1] + 1, at[2]] };
  if (type === "sound") return { type, at: [at[0], at[1] + 2, at[2]] };
  // emitters aim up their local +Y; drop them just above the ground
  if (type === "particles" || type === "fire" || type === "smoke") return { type, at: [at[0], at[1] + 0.3, at[2]] };
  // model props carry a tuned native size — drop them at it so the regular Scale
  // tool then resizes from a correct baseline (no per-object scale param).
  const s = objectDropScale(type);
  if (s !== 1) return { type, at, scale: [s, s, s] };
  return { type, at };
}

// ── viewport sync ─────────────────────────────────────────────────────────────
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => { if (state.map) void viewport.render(state.map); }, 140);
}

void main();
