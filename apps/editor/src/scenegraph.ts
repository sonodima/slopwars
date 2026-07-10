// ─── Scene outliner: hierarchical groups + objects ───────────────────────────
// A searchable tree of every placed object, organised into nestable groups.
// Selection is by reference (see state.ts) and supports multi-select (Ctrl/Cmd or
// Shift click) so a set can be grouped. Groups move/scale/rotate their members
// together in the viewport; here you can collapse them, rename them, ungroup, and
// drag objects/groups between groups to reparent (nesting). The "Group" button
// groups the current selection.
import type { GroupDef, Placement } from "@slopwars/shared";
import { placementDetail } from "@game/objects";
import { state } from "./state";
import { clear, el, renamable, contextMenu, confirmDelete, type MenuItem } from "./ui";
import { icon } from "./icons";

let query = "";
let listHost: HTMLElement | null = null;
/** a rename requested from a context menu: applied on the next render once the
 *  row's (freshly rebuilt) label element exists. Selecting an item re-renders the
 *  list and detaches the old label, so a right-click "Rename" can't act on the
 *  captured node — it re-targets the live one by id/ref here instead. */
let renameTarget: { kind: "group"; id: string } | { kind: "obj"; o: Placement } | null = null;
/** what a row drag is currently carrying (object ref or group id) */
let dragItem: { kind: "obj"; o: Placement } | { kind: "group"; id: string } | null = null;

export function mountSceneGraph(host: HTMLElement): void {
  clear(host);
  const bar = el("div", "sg-search-bar");
  const search = el("input", "sg-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search objects…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); renderList(); });
  bar.append(search);
  const grp = el("button", "btn mini sg-groupbtn");
  grp.append(icon("group"), el("span", "btn-label", "Group"));
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
  if (state.selection.length === 0 && !state.selGroup) world.classList.add("sel");
  world.append(sgIcon("globe"), el("span", "sg-label", "World"));
  world.addEventListener("click", () => state.select(-1, "outliner"));
  // drop an object/group onto World → move it out of its group (to top level)
  world.addEventListener("dragover", (e) => { if (dragItem) { e.preventDefault(); world.classList.add("drop"); } });
  world.addEventListener("dragleave", () => world.classList.remove("drop"));
  world.addEventListener("drop", (e) => { if (!dragItem) return; e.preventDefault(); e.stopPropagation(); world.classList.remove("drop"); reparent(undefined); });
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

  const caret = el("span", "sg-caret");
  caret.append(icon(g.collapsed ? "chevronRight" : "chevronDown"));
  caret.addEventListener("click", (e) => { e.stopPropagation(); state.toggleGroupCollapsed(g.id); });
  const lbl = el("span", "sg-label", g.name);
  renamable(lbl, () => g.name, (v) => state.renameGroup(g.id, v || g.name), () => { /* renameGroup commits */ });
  r.append(caret, sgIcon("folder"), lbl);
  if (renameTarget?.kind === "group" && renameTarget.id === g.id) { renameTarget = null; queueMicrotask(() => startRename(lbl)); }

  // row actions mirror an object row's (duplicate · delete), plus ungroup
  const dup = el("button", "btn mini"); dup.append(icon("copy"));
  dup.title = "duplicate group";
  dup.addEventListener("click", (e) => { e.stopPropagation(); const id = state.duplicateGroup(g.id); if (id) state.selectGroup(id, "outliner"); });
  const ungr = el("button", "btn mini"); ungr.append(icon("ungroup"));
  ungr.title = "ungroup (keep contents)";
  ungr.addEventListener("click", (e) => { e.stopPropagation(); state.ungroup(g.id); });
  const del = el("button", "btn mini"); del.append(icon("trash"));
  del.title = "delete group + contents";
  del.addEventListener("click", (e) => { e.stopPropagation(); confirmDeleteGroup(g); });
  r.append(dup, ungr, del);

  r.addEventListener("click", () => state.selectGroup(g.id, "outliner"));
  r.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    state.selectGroup(g.id, "outliner");
    contextMenu(e.clientX, e.clientY, [
      { label: "Rename", icon: "pencil", onClick: () => { renameTarget = { kind: "group", id: g.id }; renderList(); } },
      { label: "Duplicate", icon: "copy", onClick: () => { const id = state.duplicateGroup(g.id); if (id) state.selectGroup(id, "outliner"); } },
      { sep: true },
      { label: "Ungroup", icon: "ungroup", onClick: () => state.ungroup(g.id) },
      { sep: true },
      { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDeleteGroup(g) },
    ]);
  });

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
  if (renameTarget?.kind === "obj" && renameTarget.o === o) { renameTarget = null; queueMicrotask(() => startRename(lbl)); }
  r.addEventListener("click", (e) => selectObj(o, e.ctrlKey || e.metaKey || e.shiftKey));

  const dup = el("button", "btn mini"); dup.append(icon("copy"));
  dup.title = "duplicate";
  dup.addEventListener("click", (ev) => { ev.stopPropagation(); const i = idxOf(o); if (i >= 0) state.duplicate(i); });
  const del = el("button", "btn mini"); del.append(icon("trash"));
  del.title = "delete";
  del.addEventListener("click", (ev) => { ev.stopPropagation(); const i = idxOf(o); if (i >= 0) state.remove(i); });
  r.append(dup, del);

  r.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!state.isSelected(o)) selectObj(o, false);
    const multi = state.selectedObjects().length > 1;
    const items: MenuItem[] = [
      { label: "Rename", icon: "pencil", onClick: () => { renameTarget = { kind: "obj", o }; renderList(); } },
      { label: "Duplicate", icon: "copy", onClick: () => { const i = idxOf(o); if (i >= 0) state.duplicate(i); } },
      { sep: true },
      { label: multi ? "Group selection" : "Group", icon: "group", onClick: () => { const id = state.createGroup(); if (id) state.selectGroup(id, "outliner"); } },
    ];
    if (o.group) items.push({ label: "Ungroup", icon: "ungroup", onClick: () => o.group && state.ungroup(o.group) });
    items.push({ sep: true }, { label: "Delete", icon: "trash", danger: true, onClick: () => { const sel = state.selectedObjects(); if (sel.length > 1) state.removeObjects(sel); else { const i = idxOf(o); if (i >= 0) state.remove(i); } } });
    contextMenu(e.clientX, e.clientY, items);
  });

  r.draggable = true;
  r.addEventListener("dragstart", (e) => { e.stopPropagation(); dragItem = { kind: "obj", o }; });
  return r;
}

/** an outliner row icon (span wrapper keeps the existing .sg-ico layout) */
function sgIcon(name: string): HTMLElement { const s = el("span", "sg-ico"); s.append(icon(name)); return s; }
/** trigger a renamable label's inline edit (used by the context menu) */
function startRename(span: HTMLElement): void { span.dispatchEvent(new MouseEvent("dblclick")); }

/** confirm + delete a group and everything inside it (objects + nested groups) */
function confirmDeleteGroup(g: GroupDef): void {
  const n = state.membersOf(g.id, true).length;
  const what = `group "${g.name}"` + (n ? ` and its ${n} object${n === 1 ? "" : "s"}` : "");
  confirmDelete(what, () => state.deleteGroup(g.id));
}

function idxOf(o: Placement): number { return state.map ? state.map.objects.indexOf(o) : -1; }

function selectObj(o: Placement, additive: boolean): void {
  const i = idxOf(o);
  if (i >= 0) state.select(i, "outliner", additive);
}

function label(o: Placement): string {
  if (o.name) return o.name;
  const detail = placementDetail(o);
  return detail ? `${o.type} · ${detail}` : o.type;
}
