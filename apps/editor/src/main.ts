// ─── SlopWars Map Editor — shell + wiring ────────────────────────────────────
// Layout: toolbar (map management) · left scene graph · center 3D viewport ·
// right inspector · bottom asset dock. The viewport reuses the game's renderer,
// so the preview is faithful; edits mutate an in-memory MapDef that saves back
// to maps/<id>.json through the dev API (git-first workflow).
import type { AssetCatalog, Brush, MapCatalogEntry } from "@slopwars/shared";
import { emptyMap } from "@slopwars/shared";
import { Viewport } from "./viewport";
import { state } from "./state";
import { renderSceneGraph } from "./scenegraph";
import { renderInspector } from "./inspector";
import { renderPanels } from "./panels";
import { api } from "./api";
import { el, button, toast } from "./ui";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const viewport = new Viewport();
let catalog: AssetCatalog = { models: [], textures: [], materials: [], audio: [], hdri: [] };
let rebuildTimer = 0;

async function main(): Promise<void> {
  // build the whole UI first so it appears instantly and data editing works even
  // if WebGL is unavailable; the 3D viewport initializes in the background.
  try { catalog = await api.catalog(); } catch (e) { toast("catalog load failed: " + e, true); }

  buildToolbar();
  buildDock();

  // wire state → views
  state.onChange(() => { renderSceneGraph($("scene-graph")); scheduleRebuild(); });
  state.onSelect(() => { renderInspector($("inspector"), () => { /* onEdit handled via onChange */ }); focusSelection(); });

  await loadMapList();

  viewport.init("editor-canvas")
    .then(() => { if (state.map) return viewport.render(state.map); })
    .catch((e) => { console.error("viewport init failed (data editing still works):", e); toast("3D viewport unavailable", true); });
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function buildToolbar(): void {
  const bar = $("toolbar");
  const picker = el("select", "map-picker") as HTMLSelectElement;
  picker.id = "map-picker";
  picker.addEventListener("change", () => openMap(picker.value));
  bar.append(el("span", "brand", "SlopWars Editor"), picker);

  bar.append(
    button("New", newMap),
    button("Save", saveMap, "primary"),
    button("Save As…", saveMapAs),
    el("span", "bar-sep"),
    el("span", "bar-label", "Add brush:"),
    button("Box", () => addBrush({ k: "box", at: [0, 1, 0], size: [4, 2, 4], mat: "wall", tile: [1, 1] })),
    button("Water", () => addBrush({ k: "water", at: [0, 0.4, 0], s: 4 })),
    button("Stairs", () => addBrush({ k: "stairs", at: [0, 0, 0], axis: "x+", rise: 3, run: 5, width: 2 })),
    el("span", "bar-sep"),
    button("Spawn", addSpawn),
    button("Pickup", () => addPoint("pickups")),
    button("Power-up", () => addPoint("powerups")),
  );

  const status = el("span", "status"); status.id = "status";
  bar.append(status);
}

function buildDock(): void {
  renderPanels($("dock-tabs"), $("dock-body"), {
    catalog,
    placeObject,
    reloadCatalog: async () => { catalog = await api.catalog(); return catalog; },
  });
}

// ── map management ────────────────────────────────────────────────────────────
async function loadMapList(): Promise<void> {
  let list: MapCatalogEntry[] = [];
  try { list = await api.maps(); } catch (e) { toast("maps list failed: " + e, true); }
  const picker = document.getElementById("map-picker") as HTMLSelectElement;
  picker.replaceChildren();
  for (const m of list) { const o = el("option", undefined, `${m.name} (${m.id})`); o.value = m.file; picker.append(o); }
  if (list.length) { picker.value = list[0].file; await openMap(list[0].file); }
  else newMap();
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
  const id = uniqueId("untitled");
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
  const id = prompt("Save as map id (letters, digits, - and _):", map.meta.id);
  if (!id) return;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "");
  map.meta.id = clean;
  state.fileId = clean;
  await saveMap();
  await refreshPickerKeepSelection(clean);
}

async function refreshPickerKeepSelection(id: string): Promise<void> {
  const list = await api.maps().catch(() => [] as MapCatalogEntry[]);
  const picker = document.getElementById("map-picker") as HTMLSelectElement;
  picker.replaceChildren();
  for (const m of list) { const o = el("option", undefined, `${m.name} (${m.id})`); o.value = m.file; picker.append(o); }
  const match = list.find((m) => m.id === id);
  if (match) picker.value = match.file;
}

// ── mutations ─────────────────────────────────────────────────────────────────
function addBrush(b: Brush): void {
  const map = state.map; if (!map) return;
  map.brushes.push(b);
  state.touch();
  state.select("brush", map.brushes.length - 1);
}
function placeObject(type: string): void {
  const map = state.map; if (!map) return;
  map.objects.push({ type, at: [0, 0, 0] });
  state.touch();
  state.select("object", map.objects.length - 1);
}
function addSpawn(): void {
  const map = state.map; if (!map) return;
  map.spawns.push({ at: [0, 0], yaw: 0 });
  state.touch();
  state.select("spawn", map.spawns.length - 1);
}
function addPoint(which: "pickups" | "powerups"): void {
  const map = state.map; if (!map) return;
  map[which].push([0, 1, 0]);
  state.touch();
  state.select(which === "pickups" ? "pickup" : "powerup", map[which].length - 1);
}

// ── viewport sync ─────────────────────────────────────────────────────────────
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => { if (state.map) void viewport.render(state.map); }, 120);
}

function focusSelection(): void {
  const map = state.map; if (!map) return;
  const s = state.sel;
  if (s.kind === "brush") { const b = map.brushes[s.index]; if (b) viewport.focus(b.at[0], b.at[1], b.at[2]); }
  else if (s.kind === "object") { const o = map.objects[s.index]; if (o) viewport.focus(o.at[0], o.at[1], o.at[2]); }
  else if (s.kind === "spawn") { const sp = map.spawns[s.index]; if (sp) viewport.focus(sp.at[0], 1, sp.at[1]); }
  else if (s.kind === "pickup") { const p = map.pickups[s.index]; if (p) viewport.focus(p[0], p[1], p[2]); }
  else if (s.kind === "powerup") { const p = map.powerups[s.index]; if (p) viewport.focus(p[0], p[1], p[2]); }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function uniqueId(base: string): string { return `${base}-${Math.random().toString(36).slice(2, 6)}`; }
function setStatus(s: string): void { const n = document.getElementById("status"); if (n) n.textContent = s; }

void main();
