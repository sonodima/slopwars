// ─── SlopWars Map Editor — shell + wiring ────────────────────────────────────
// Toolbar (map + transform tools + quick-add) · left scene graph · center 3D
// viewport with fly camera + gizmos · right inspector · bottom unified asset
// browser. Everything placed is an object; edits mutate an in-memory MapDef that
// saves back to maps/<id>.json through the dev API.
import type { AssetCatalog, Placement, Tuple3 } from "@slopwars/shared";
import { emptyMap } from "@slopwars/shared";
import { Viewport, Tool } from "./viewport";
import { ModelPreview } from "./preview";
import { state } from "./state";
import { renderSceneGraph } from "./scenegraph";
import { renderInspector, setInspectorCatalog } from "./inspector";
import { renderBrowser, Payload } from "./panels";
import { api } from "./api";
import { el, button, toast } from "./ui";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const viewport = new Viewport();
const preview = new ModelPreview();
let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
let rebuildTimer = 0;

const TOOLS: { t: Tool; label: string; key: string }[] = [
  { t: "select", label: "Select", key: "Q" },
  { t: "move", label: "Move", key: "W" },
  { t: "rotate", label: "Rotate", key: "E" },
  { t: "scale", label: "Scale", key: "R" },
];

async function main(): Promise<void> {
  try { catalog = await api.catalog(); } catch (e) { toast("catalog load failed: " + e, true); }
  setInspectorCatalog(catalog);

  buildToolbar();
  buildDock();

  state.onChange(() => { renderSceneGraph($("scene-graph")); scheduleRebuild(); });
  state.onSelect(() => renderInspector($("inspector")));
  viewport.onToolChange(highlightTool);
  viewport.onEditCommit = () => state.emitSelect();

  await loadMapList();
  setupDrop();

  viewport.init("editor-canvas")
    .then(() => { if (state.map) return viewport.render(state.map); })
    .catch((e) => { console.error("viewport init failed (data editing still works):", e); toast("3D viewport unavailable", true); });
  preview.init($("preview-canvas") as HTMLCanvasElement).catch(() => { /* preview optional */ });
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function buildToolbar(): void {
  const bar = $("toolbar");
  const picker = el("select", "map-picker") as HTMLSelectElement;
  picker.id = "map-picker";
  picker.addEventListener("change", () => openMap(picker.value));
  bar.append(el("span", "brand", "SlopWars"), picker,
    button("New", newMap), button("Save", saveMap, "primary"), button("Save As…", saveMapAs),
    el("span", "bar-sep"));

  const tools = el("div", "tool-group");
  for (const { t, label } of TOOLS) {
    const b = el("button", "btn tool", label); b.dataset.tool = t;
    b.addEventListener("click", () => selectTool(t));
    tools.append(b);
  }
  bar.append(tools, el("span", "bar-sep"), el("span", "bar-label", "Add:"),
    button("Box", () => add({ type: "box", at: [0, 1, 0], scale: [4, 2, 4] })),
    button("Water", () => add({ type: "water", at: [0, 0.3, 0], scale: [6, 1, 6] })),
    button("Stairs", () => add({ type: "stairs", at: [0, 0, 0] })),
    button("Spawn", () => add({ type: "spawn", at: [0, 0, 0] })),
    button("Pickup", () => add({ type: "pickup", at: [0, 1, 0] })),
    button("Power-up", () => add({ type: "powerup", at: [0, 1, 0] })),
    button("Sound", () => add({ type: "sound", at: [0, 2, 0] })),
  );
  const status = el("span", "status"); status.id = "status"; bar.append(status);
  highlightTool("select");
}

function buildDock(): void {
  renderBrowser($("browser"), { catalog, preview, reloadCatalog: async () => { catalog = await api.catalog(); setInspectorCatalog(catalog); return catalog; } });
}

function selectTool(t: Tool): void { viewport.setTool(t); highlightTool(t); }
function highlightTool(t: Tool): void {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>(".btn.tool"))) b.classList.toggle("on", b.dataset.tool === t);
}

// ── map management ────────────────────────────────────────────────────────────
async function loadMapList(): Promise<void> {
  let list: { id: string; name: string; file: string }[] = [];
  try { list = await api.maps(); } catch (e) { toast("maps list failed: " + e, true); }
  const picker = document.getElementById("map-picker") as HTMLSelectElement;
  picker.replaceChildren();
  for (const m of list) { const o = el("option", undefined, `${m.name} (${m.id})`); o.value = m.file; picker.append(o); }
  if (list.length) { picker.value = list[0].file; await openMap(list[0].file); } else newMap();
}

async function openMap(file: string): Promise<void> {
  try {
    const def = await api.loadMap(file);
    const id = file.replace(/^.*\//, "").replace(/\.json$/, "");
    state.setMap(def, id);
    setStatus(`loaded ${file}`);
  } catch (e) { toast("open failed: " + e, true); }
}

function newMap(): void {
  const id = `untitled-${Math.random().toString(36).slice(2, 6)}`;
  state.setMap(emptyMap(id, "Untitled"), id);
  setStatus("new map");
}

async function saveMap(): Promise<void> {
  const map = state.map; if (!map) return;
  const id = map.meta.id || state.fileId;
  try { await api.saveMap(id, map); state.dirty = false; setStatus(`saved maps/${id}.json`); toast(`saved maps/${id}.json`); }
  catch (e) { toast("save failed: " + e, true); }
}

async function saveMapAs(): Promise<void> {
  const map = state.map; if (!map) return;
  const id = prompt("Save as map id:", map.meta.id);
  if (!id) return;
  map.meta.id = id.replace(/[^a-zA-Z0-9_-]/g, "");
  state.fileId = map.meta.id;
  await saveMap();
  const list = await api.maps().catch(() => []);
  const picker = document.getElementById("map-picker") as HTMLSelectElement;
  picker.replaceChildren();
  for (const m of list) { const o = el("option", undefined, `${m.name} (${m.id})`); o.value = m.file; picker.append(o); }
  const match = list.find((m) => m.id === map.meta.id); if (match) picker.value = match.file;
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
    const at = viewport.dropGround(e.clientX, e.clientY) ?? [0, 0, 0] as Tuple3;
    if (p.kind === "model") add({ type: "prop", at, params: { model: p.name } });
    else if (p.kind === "audio") add({ type: "sound", at: [at[0], at[1] + 1.5, at[2]], params: { clip: p.name } });
    else add({ type: p.name, at, ...(p.name === "box" ? { scale: [2, 2, 2] as Tuple3 } : {}) });
  });
}

// ── viewport sync ─────────────────────────────────────────────────────────────
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => { if (state.map) void viewport.render(state.map); }, 140);
}

function setStatus(s: string): void { const n = document.getElementById("status"); if (n) n.textContent = s; }

void main();
