// ─── Scene outliner: hierarchical groups + objects ───────────────────────────
// A searchable tree of every placed object, organised into nestable groups.
// Selection is by reference (see state.ts) and supports multi-select (Ctrl/Cmd or
// Shift click) so a set can be grouped. Groups move/scale/rotate their members
// together in the viewport; here you can collapse them, rename them, ungroup, and
// drag objects/groups between groups to reparent (nesting). The "Group" button
// groups the current selection.
import type { GroupDef, Placement } from "@slopwars/shared";
import { state } from "./state";
import { clear, el, renamable } from "./ui";

let query = "";
let listHost: HTMLElement | null = null;
/** what a row drag is currently carrying (object ref or group id) */
let dragItem: { kind: "obj"; o: Placement } | { kind: "group"; id: string } | null = null;

export function mountSceneGraph(host: HTMLElement): void {
  clear(host);
  const bar = el("div", "sg-search-bar");
  const search = el("input", "sg-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search objects…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); renderList(); });
  bar.append(search);
  const grp = el("button", "btn mini sg-groupbtn", "⊞ Group");
  grp.title = "Group selection (Ctrl+G)";
  grp.addEventListener("click", () => { if (state.selectedObjects().length) { const id = state.createGroup(); if (id) state.selectGroup(id, "outliner"); } });
  bar.append(grp);

  const list = el("div", "sg-list");
  listHost = list;
  host.append(bar, list);

  // drop onto empty list area → move dragged item to top level
  list.addEventListener("dragover", (e) => { if (dragItem) e.preventDefault(); });
  list.addEventListener("drop", (e) => { if (!dragItem) return; e.preventDefault(); reparent(undefined); });

  state.onChange(renderList);
  state.onSelect(renderList);
  renderList();
}

function reparent(target: string | undefined): void {
  if (!dragItem) return;
  if (dragItem.kind === "obj") state.setObjectGroup(dragItem.o, target);
  else state.setGroupParent(dragItem.id, target);
  dragItem = null;
}

function matchObj(o: Placement): boolean { return !query || label(o).toLowerCase().includes(query); }

function renderList(): void {
  const host = listHost;
  if (!host) return;
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }

  // "World" is always first: selecting it (= nothing selected) shows the map's
  // sky / lighting / effects in the inspector.
  const world = el("div", "sg-row sg-world");
  if (state.selection.length === 0) world.classList.add("sel");
  world.append(el("span", "sg-ico", "🌍"), el("span", "sg-label", "World"));
  world.addEventListener("click", () => state.select(-1, "outliner"));
  host.append(world);

  let shown = 0;
  // top-level groups first, then ungrouped objects
  for (const g of state.childGroups(undefined)) shown += renderGroup(host, g, 0);
  map.objects.forEach((o) => {
    if (o.group) return;                 // rendered under its group
    if (!matchObj(o)) return;
    host.append(objectRow(o, 0));
    shown++;
  });
  if (shown === 0) host.append(el("div", "empty", query ? "No matches" : "No objects"));

  const selRow = host.querySelector(".sg-row.sel.primary");
  if (selRow && state.selectSource === "viewport") (selRow as HTMLElement).scrollIntoView({ block: "nearest" });
}

/** render a group subtree; returns how many rows were shown (respecting search) */
function renderGroup(host: HTMLElement, g: GroupDef, depth: number): number {
  const members = state.membersOf(g.id, true);
  const matchesQuery = !query || g.name.toLowerCase().includes(query) || members.some(matchObj);
  if (!matchesQuery) return 0;

  host.append(groupRow(g, depth));
  if (g.collapsed) return 1;

  let n = 1;
  for (const child of state.childGroups(g.id)) n += renderGroup(host, child, depth + 1);
  for (const o of state.membersDirect(g.id)) {
    if (!matchObj(o)) continue;
    host.append(objectRow(o, depth + 1));
    n++;
  }
  return n;
}

function groupRow(g: GroupDef, depth: number): HTMLElement {
  const r = el("div", "sg-row sg-group");
  r.style.paddingLeft = `${8 + depth * 14}px`;
  const allSel = state.membersOf(g.id, true);
  if (allSel.length && allSel.every((o) => state.isSelected(o))) r.classList.add("sel");

  const caret = el("span", "sg-caret", g.collapsed ? "▸" : "▾");
  caret.addEventListener("click", (e) => { e.stopPropagation(); state.toggleGroupCollapsed(g.id); });
  const lbl = el("span", "sg-label", g.name);
  renamable(lbl, () => g.name, (v) => state.renameGroup(g.id, v || g.name), () => { /* renameGroup commits */ });
  r.append(caret, el("span", "sg-ico", "📁"), lbl);

  const ungr = el("button", "btn mini", "⊟");
  ungr.title = "ungroup";
  ungr.addEventListener("click", (e) => { e.stopPropagation(); state.ungroup(g.id); });
  r.append(ungr);

  r.addEventListener("click", () => state.selectGroup(g.id, "outliner"));

  // drag to reparent this group; accept drops of objects/groups into it
  r.draggable = true;
  r.addEventListener("dragstart", (e) => { e.stopPropagation(); dragItem = { kind: "group", id: g.id }; });
  r.addEventListener("dragover", (e) => { if (dragItem) { e.preventDefault(); e.stopPropagation(); r.classList.add("drop"); } });
  r.addEventListener("dragleave", () => r.classList.remove("drop"));
  r.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); r.classList.remove("drop"); reparent(g.id); });
  return r;
}

function objectRow(o: Placement, depth: number): HTMLElement {
  const r = el("div", "sg-row");
  r.style.paddingLeft = `${10 + depth * 14}px`;
  const primary = state.selObj === o;
  if (state.isSelected(o)) { r.classList.add("sel"); if (primary) r.classList.add("primary"); }

  const lbl = el("span", "sg-label", label(o));
  renamable(lbl, () => o.name ?? "", (v) => { o.name = v || undefined; }, () => { selectObj(o, false); state.commit(true); });
  r.append(lbl);
  r.addEventListener("click", (e) => selectObj(o, e.ctrlKey || e.metaKey || e.shiftKey));

  const dup = el("button", "btn mini", "⧉");
  dup.title = "duplicate";
  dup.addEventListener("click", (ev) => { ev.stopPropagation(); const i = idxOf(o); if (i >= 0) state.duplicate(i); });
  const del = el("button", "btn mini", "✕");
  del.title = "delete";
  del.addEventListener("click", (ev) => { ev.stopPropagation(); const i = idxOf(o); if (i >= 0) state.remove(i); });
  r.append(dup, del);

  r.draggable = true;
  r.addEventListener("dragstart", (e) => { e.stopPropagation(); dragItem = { kind: "obj", o }; });
  return r;
}

function idxOf(o: Placement): number { return state.map ? state.map.objects.indexOf(o) : -1; }

function selectObj(o: Placement, additive: boolean): void {
  const i = idxOf(o);
  if (i >= 0) state.select(i, "outliner", additive);
}

function label(o: Placement): string {
  if (o.name) return o.name;
  if (o.type === "prop" && o.params?.model) return `prop · ${o.params.model}`;
  if (o.type === "sound" && o.params?.clip) return `sound · ${o.params.clip}`;
  return o.type;
}

/** kept as an alias so external callers referencing the old name still work */
export const renderSceneGraph = (): void => renderList();
