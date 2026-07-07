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
import { renderInspector, setInspectorCatalog, setInspectorThumbs } from "./inspector";
import { renderBrowser, Payload } from "./panels";
import { mountResizers } from "./layout";
import { api } from "./api";
import { el, button, toast, modal } from "./ui";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const viewport = new Viewport();
const thumbs = new ThumbRenderer();
let catalog: AssetCatalog = { models: [], textures: [], audio: [], hdri: [] };
let rebuildTimer = 0;

const TOOLS: { t: Tool; label: string }[] = [
  { t: "move", label: "Move" },
  { t: "rotate", label: "Rotate" },
  { t: "scale", label: "Scale" },
];
const GRAPHICS = ["low", "medium", "high"] as const;

async function main(): Promise<void> {
  try { catalog = await api.catalog(); } catch (e) { toast("catalog load failed: " + e, true); }
  setInspectorCatalog(catalog);
  setInspectorThumbs(thumbs);

  buildToolbar();
  mountSceneGraph($("scene-graph"));
  buildDock();
  bindUndoRedo();
  mountResizers();

  state.onChange(() => { scheduleRebuild(); refreshMapName(); });
  state.onSelect(() => renderInspector($("inspector")));
  // selecting in the outliner reframes the camera on the object (centres it)
  state.onSelect(() => { if (state.selectSource === "outliner" && state.selIndex >= 0) viewport.focusSelected(); });
  viewport.onToolChange(highlightTool);
  viewport.onEditCommit = () => state.commit(true);
  viewport.onPerf = showPerf;

  newMap();          // start on a blank map (Load opens an existing one)
  setupDrop();

  viewport.init("editor-canvas")
    .then(() => { viewport.setGraphics("high"); if (state.map) return viewport.render(state.map); })
    .catch((e) => { console.error("viewport init failed (data editing still works):", e); toast("3D viewport unavailable", true); });
  thumbs.init().catch(() => { /* thumbnails optional */ });
}

// ── undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z) ─────────────────
function bindUndoRedo(): void {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); state.undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); state.redo(); }
  });
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function buildToolbar(): void {
  const bar = $("toolbar");
  const logo = el("img", "brand-icon") as HTMLImageElement;
  logo.src = `${import.meta.env.BASE_URL}logo.png`; logo.alt = "SlopWars";
  bar.append(logo, el("span", "brand", "Editor"),
    button("New", newMap), button("Load…", openLoadDialog), button("Save", saveMap, "primary"), button("Save As…", saveMapAs),
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
  renderBrowser($("browser"), { catalog, thumbs, reloadCatalog: async () => { catalog = await api.catalog(); setInspectorCatalog(catalog); return catalog; } });
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

// ── map management ────────────────────────────────────────────────────────────
async function openLoadDialog(): Promise<void> {
  let list: { id: string; name: string; file: string }[] = [];
  try { list = await api.maps(); } catch (e) { toast("maps list failed: " + e, true); return; }
  const body = el("div", "map-list");
  if (!list.length) body.append(el("div", "empty", "No maps found"));
  const dlg = modal("Load map", body);
  for (const m of list) {
    const row = el("button", "map-row");
    row.append(el("span", "map-row-name", m.name), el("span", "map-row-id", m.id));
    row.addEventListener("click", () => { dlg.close(); void openMap(m.file); });
    body.append(row);
  }
}

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
  try { await api.saveMap(id, map); state.dirty = false; refreshMapName(); toast(`saved maps/${id}.json`); }
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
    else add(objectPlacement(p.name, at));
  });
}

/** sensible starting transform for an object type dropped onto the ground */
function objectPlacement(type: string, at: Tuple3): Placement {
  if (type === "box") return { type, at: [at[0], at[1] + 1, at[2]], scale: [4, 2, 4] };
  if (type === "water") return { type, at: [at[0], at[1] + 0.3, at[2]], scale: [6, 1, 6] };
  if (type === "pickup" || type === "powerup") return { type, at: [at[0], at[1] + 1, at[2]] };
  if (type === "sound") return { type, at: [at[0], at[1] + 2, at[2]] };
  return { type, at };
}

// ── viewport sync ─────────────────────────────────────────────────────────────
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => { if (state.map) void viewport.render(state.map); }, 140);
}

void main();
