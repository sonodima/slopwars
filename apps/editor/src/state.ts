// ─── Editor state: the map being edited + selection + groups + undo history ──
// Everything in a map is an object placement. Selection is held by *reference*
// (not raw indices) so it survives reordering/insertion/deletion, and supports
// multi-select (for group operations). Objects can belong to a nestable GroupDef
// which is a first-class parent with its own transform: members are stored in the
// group's local space, so transforming the group moves them as one (the game +
// editor compose world transforms up the group chain). A snapshot-based history
// records one entry per committed action so Ctrl/Cmd+Z / +Y step cleanly.
import type { GroupDef, MapDef, Placement, Tuple3, WorldTf } from "@slopwars/shared";
import { childGroups, groupById, groupMembers, groupMembersDirect, groupWorldTf, invComposeTf, resolveWorld } from "@slopwars/shared";

type Listener = () => void;

interface Snapshot { map: MapDef; sel: number[] }
const HISTORY_CAP = 200;

/** the per-map-document state the editor swaps in/out as you switch viewport tabs.
 *  Every open map is a self-contained document: its own MapDef, file id, dirty
 *  flag, selection and undo/redo history. The active document's fields are mirrored
 *  onto the EditorState instance (`map`, `selObj`, …) so all existing consumers keep
 *  reading `state.map`; switching tabs just saves the live fields back into the old
 *  document and loads the new one's. */
interface DocState {
  id: string;
  map: MapDef;
  fileId: string;
  dirty: boolean;
  selObj: Placement | null;
  selection: Placement[];
  selGroup: string | null;
  history: Snapshot[];
  hi: number;
}

class EditorState {
  map: MapDef | null = null;
  /** the map's file id (maps/<id>.json); may differ from meta.id until saved */
  fileId = "";
  dirty = false;
  /** primary selection (drives the inspector); last item added to the set */
  selObj: Placement | null = null;
  /** full selection set (references; includes selObj). Empty = nothing selected. */
  selection: Placement[] = [];
  /** when a group (not a bare object set) is the active selection, its id — drives
   *  the group inspector. Cleared by any object-level selection change. */
  selGroup: string | null = null;
  /** where the last selection came from — lets the viewport reframe (outliner
   *  clicks) and the outliner scroll (viewport clicks). */
  selectSource: "outliner" | "viewport" | "" = "";

  private history: Snapshot[] = [];
  private hi = -1;

  // ── open map documents (viewport tabs) ───────────────────────────────────────
  /** every open map document, keyed by its id (== its viewport tab id) */
  private docs = new Map<string, DocState>();
  /** the active document's id ("" when none open) */
  activeDocId = "";

  private changeListeners = new Set<Listener>();   // map data changed → rebuild + trees
  private selListeners = new Set<Listener>();       // selection changed → inspector

  onChange(fn: Listener): void { this.changeListeners.add(fn); }
  onSelect(fn: Listener): void { this.selListeners.add(fn); }

  /** index of the primary selected placement in the current map (-1 if none) */
  get selIndex(): number {
    return this.map && this.selObj ? this.map.objects.indexOf(this.selObj) : -1;
  }

  // ── document lifecycle ───────────────────────────────────────────────────────
  /** capture the live fields back into the active document (before a switch) */
  private stashActive(): void {
    const d = this.docs.get(this.activeDocId);
    if (!d || !this.map) return;
    d.map = this.map; d.fileId = this.fileId; d.dirty = this.dirty;
    d.selObj = this.selObj; d.selection = this.selection; d.selGroup = this.selGroup;
    d.history = this.history; d.hi = this.hi;
  }
  /** mirror a document's fields onto the live EditorState (after a switch) */
  private loadDoc(d: DocState): void {
    this.activeDocId = d.id;
    this.map = d.map; this.fileId = d.fileId; this.dirty = d.dirty;
    this.selObj = d.selObj; this.selection = d.selection; this.selGroup = d.selGroup;
    this.history = d.history; this.hi = d.hi;
  }

  documentIds(): string[] { return [...this.docs.keys()]; }
  hasDocument(id: string): boolean { return this.docs.has(id); }
  /** the open document whose map has this file id (for "focus if already open") */
  docIdForFile(fileId: string): string | null {
    for (const d of this.docs.values()) if (d.fileId && d.fileId === fileId) return d.id;
    return null;
  }
  mapName(id: string): string { return this.docs.get(id)?.map.meta.name ?? "Untitled"; }
  /** live dirty flag for a document — the active one reads the live field (which the
   *  doc record only mirrors on a tab switch), so its tab dot updates immediately. */
  isDirty(id: string): boolean { return id === this.activeDocId ? this.dirty : (this.docs.get(id)?.dirty ?? false); }
  /** a document's map / file id without activating it (for Save All of background tabs) */
  docMap(id: string): MapDef | null { return id === this.activeDocId ? this.map : (this.docs.get(id)?.map ?? null); }
  docFileId(id: string): string { return id === this.activeDocId ? this.fileId : (this.docs.get(id)?.fileId ?? ""); }
  /** mark a document saved (clears its dirty flag, live + stored) */
  markDocSaved(id: string): void {
    const d = this.docs.get(id); if (d) d.dirty = false;
    if (id === this.activeDocId) this.dirty = false;
  }

  /** open a map as a new document with the given id, and make it active. */
  openDocument(id: string, map: MapDef, fileId: string): void {
    this.stashActive();
    const d: DocState = {
      id, map, fileId, dirty: false,
      selObj: null, selection: [], selGroup: null,
      history: [snapshotOf(map, [])], hi: 0,
    };
    this.docs.set(id, d);
    this.loadDoc(d);
    this.selectSource = "";
    this.emitChange();
    this.emitSelect();
  }

  /** switch the active document (no-op if already active or unknown). */
  activateDocument(id: string): void {
    if (id === this.activeDocId || !this.docs.has(id)) return;
    this.stashActive();
    this.loadDoc(this.docs.get(id)!);
    this.selectSource = "";
    this.emitChange();
    this.emitSelect();
  }

  /** close a document. Returns the id that became active (or "" if none remain). */
  closeDocument(id: string): string {
    if (!this.docs.has(id)) return this.activeDocId;
    const wasActive = id === this.activeDocId;
    this.docs.delete(id);
    if (!wasActive) return this.activeDocId;
    const next = [...this.docs.keys()].pop() ?? "";
    if (next) { this.loadDoc(this.docs.get(next)!); }
    else {
      this.activeDocId = ""; this.map = null; this.fileId = ""; this.dirty = false;
      this.selObj = null; this.selection = []; this.selGroup = null;
      this.history = []; this.hi = -1;
    }
    this.selectSource = "";
    this.emitChange();
    this.emitSelect();
    return next;
  }

  // ── selection ──────────────────────────────────────────────────────────────
  /** select by index. `additive` toggles membership in a multi-selection. */
  select(index: number, source: "outliner" | "viewport" | "" = "", additive = false): void {
    this.selGroup = null;
    const o = this.map?.objects[index] ?? null;
    if (!o) { this.selection = []; this.selObj = null; }
    else if (additive) {
      const i = this.selection.indexOf(o);
      if (i >= 0) { this.selection.splice(i, 1); this.selObj = this.selection[this.selection.length - 1] ?? null; }
      else { this.selection.push(o); this.selObj = o; }
    } else { this.selection = [o]; this.selObj = o; }
    this.selectSource = source;
    this.emitSelect();
  }

  /** replace the selection with an explicit set (primary = last) */
  selectSet(objs: Placement[], source: "outliner" | "viewport" | "" = ""): void {
    this.selGroup = null;
    this.selection = objs.slice();
    this.selObj = objs[objs.length - 1] ?? null;
    this.selectSource = source;
    this.emitSelect();
  }

  /** select every object (recursively) in a group, and mark the group active so
   *  the inspector shows group properties (name / transform) instead of a member. */
  selectGroup(groupId: string, source: "outliner" | "viewport" | "" = ""): void {
    const objs = this.membersOf(groupId, true);
    this.selection = objs.slice();
    this.selObj = objs[objs.length - 1] ?? null;
    this.selGroup = groupId;
    this.selectSource = source;
    this.emitSelect();
  }

  selected(): Placement | null {
    return this.selIndex >= 0 ? this.selObj : null;
  }
  /** current selection, filtered to objects still present in the map */
  selectedObjects(): Placement[] {
    const objs = this.map?.objects ?? [];
    return this.selection.filter((o) => objs.includes(o));
  }
  isSelected(o: Placement): boolean { return this.selection.includes(o); }

  // ── groups ───────────────────────────────────────────────────────────────
  // The hierarchy queries are pure MapDef walks shared with the game loader (see
  // @slopwars/shared); these are thin, map-bound wrappers so editor callers keep a
  // convenient `state.childGroups(id)` API without duplicating the traversal.
  groups(): GroupDef[] { return this.map?.groups ?? []; }
  private ensureGroups(): GroupDef[] { if (!this.map) return []; return (this.map.groups ??= []); }
  groupById(id: string | undefined): GroupDef | undefined { return this.map ? groupById(this.map, id) : undefined; }
  /** child groups of a parent (undefined parent = top level) */
  childGroups(parent: string | undefined): GroupDef[] { return this.map ? childGroups(this.map, parent) : []; }
  /** objects directly in a group */
  membersDirect(groupId: string): Placement[] { return this.map ? groupMembersDirect(this.map, groupId) : []; }
  /** objects in a group and all its descendant groups */
  membersOf(groupId: string, recursive: boolean): Placement[] { return this.map ? groupMembers(this.map, groupId, recursive) : []; }

  /** create a group from the current selection; nests under a shared parent group
   *  if every selected object already belongs to the same one. The new group's
   *  origin is the selection's centroid and its members are rebased into the group's
   *  local space, so transforming the group moves them as one. Returns its id. */
  createGroup(name?: string): string | null {
    if (!this.map) return null;
    const sel = this.selectedObjects();
    if (!sel.length) return null;
    const parents = new Set(sel.map((o) => o.group ?? ""));
    const parent = parents.size === 1 ? ([...parents][0] || undefined) : undefined;
    // world transform of each member BEFORE reparenting, so we can rebase them
    const worlds = sel.map((o) => resolveWorld(this.map!, o));
    let cx = 0, cy = 0, cz = 0;
    for (const w of worlds) { cx += w.at[0]; cy += w.at[1]; cz += w.at[2]; }
    const pivot: Tuple3 = [cx / sel.length, cy / sel.length, cz / sel.length];
    const parentW = groupWorldTf(this.map, parent);
    const local = invComposeTf(parentW, { at: pivot, rot: parentW.rot, scale: parentW.scale });
    const id = `grp-${Math.random().toString(36).slice(2, 8)}`;
    this.ensureGroups().push({ id, name: name || `Group ${this.groups().length + 1}`, parent, at: round3(local.at), rot: [0, 0, 0], scale: [1, 1, 1] });
    const groupW: WorldTf = { at: pivot, rot: parentW.rot, scale: parentW.scale };
    sel.forEach((o, i) => {
      o.group = id;
      const lw = invComposeTf(groupW, worlds[i]);
      o.at = round3(lw.at); o.rot = round3(lw.rot); o.scale = round3(lw.scale);
    });
    this.commit(true);
    return id;
  }

  // ── group transform (a group is a first-class parent with its own transform) ──
  /** a group's world transform (composed up its parent chain) */
  groupWorld(groupId: string): WorldTf {
    return this.map ? groupWorldTf(this.map, groupId) : { at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  }
  /** set a group's world transform (stored back into its parent-local space).
   *  `commit=false` during a live gizmo drag (redraw only); true finalizes it. */
  setGroupWorld(groupId: string, w: WorldTf, commit = true): void {
    const g = this.groupById(groupId); if (!g || !this.map) return;
    const local = invComposeTf(groupWorldTf(this.map, g.parent), w);
    g.at = round3(local.at); g.rot = round3(local.rot); g.scale = round3(local.scale);
    if (commit) this.commit(); else this.touch();
  }

  /** dissolve a group: its objects and child groups move up to its parent, keeping
   *  their world transforms (rebased into the parent's local space). */
  ungroup(groupId: string): void {
    if (!this.map) return;
    const g = this.groupById(groupId);
    if (!g) return;
    const parent = g.parent;
    const parentW = groupWorldTf(this.map, parent);
    for (const o of this.membersDirect(groupId)) {
      const w = resolveWorld(this.map, o);               // world under the doomed group
      o.group = parent;
      const lw = invComposeTf(parentW, w);
      o.at = round3(lw.at); o.rot = round3(lw.rot); o.scale = round3(lw.scale);
    }
    for (const child of this.childGroups(groupId)) {
      const cw = groupWorldTf(this.map, child.id);
      child.parent = parent;
      const lw = invComposeTf(parentW, cw);
      child.at = round3(lw.at); child.rot = round3(lw.rot); child.scale = round3(lw.scale);
    }
    this.map.groups = this.groups().filter((x) => x.id !== groupId);
    this.commit(true);
  }

  /** move an object into a group (or to top level), preserving its world transform */
  setObjectGroup(o: Placement, groupId: string | undefined): void {
    if (this.map) {
      const w = resolveWorld(this.map, o);
      o.group = groupId;
      const lw = invComposeTf(groupWorldTf(this.map, groupId), w);
      o.at = round3(lw.at); o.rot = round3(lw.rot); o.scale = round3(lw.scale);
    } else o.group = groupId;
    this.commit(true);
  }
  /** reparent a group (guards against cycles), preserving its world transform */
  setGroupParent(groupId: string, parent: string | undefined): void {
    const g = this.groupById(groupId);
    if (!g || groupId === parent || !this.map) return;
    // reject if `parent` is a descendant of groupId (would create a cycle)
    let p = parent;
    while (p) { if (p === groupId) return; p = this.groupById(p)?.parent; }
    const w = groupWorldTf(this.map, groupId);
    g.parent = parent;
    const lw = invComposeTf(groupWorldTf(this.map, parent), w);
    g.at = round3(lw.at); g.rot = round3(lw.rot); g.scale = round3(lw.scale);
    this.commit(true);
  }
  renameGroup(groupId: string, name: string): void {
    const g = this.groupById(groupId); if (!g) return;
    g.name = name; this.commit(true);
  }

  /** delete a group AND everything inside it: the group, its descendant groups,
   *  and every member object (recursively). This is the group-level analogue of
   *  deleting an object — "ungroup" keeps the contents, "delete" discards them. */
  deleteGroup(groupId: string): void {
    if (!this.map) return;
    if (!this.groupById(groupId)) return;
    const doomed = new Set<string>();
    const collect = (id: string): void => { doomed.add(id); for (const c of this.childGroups(id)) collect(c.id); };
    collect(groupId);
    this.map.objects = this.map.objects.filter((o) => !(o.group && doomed.has(o.group)));
    this.map.groups = this.groups().filter((x) => !doomed.has(x.id));
    this.selection = this.selection.filter((o) => this.map!.objects.includes(o));
    this.selObj = this.selection[this.selection.length - 1] ?? null;
    if (this.selGroup && doomed.has(this.selGroup)) this.selGroup = null;
    this.commit(true);
  }

  /** duplicate a group subtree (its nested groups + member objects) with fresh ids,
   *  offset a little, and select the copy — the group-level analogue of duplicating
   *  an object. */
  duplicateGroup(groupId: string): string | null {
    if (!this.map || !this.groupById(groupId)) return null;
    // gather the subtree ids (this group + all descendants) and map each to a new id
    const subtree = [groupId];
    for (let i = 0; i < subtree.length; i++) for (const c of this.childGroups(subtree[i])) subtree.push(c.id);
    const idMap = new Map(subtree.map((id) => [id, `grp-${Math.random().toString(36).slice(2, 8)}`]));
    const groups = this.ensureGroups();
    for (const id of subtree) {
      const copy: GroupDef = JSON.parse(JSON.stringify(this.groupById(id)));
      copy.id = idMap.get(id)!;
      if (copy.parent && idMap.has(copy.parent)) copy.parent = idMap.get(copy.parent);
      groups.push(copy);
    }
    const top = this.groupById(idMap.get(groupId)!)!;
    const a = top.at ?? [0, 0, 0];
    top.at = [a[0] + 2, a[1], a[2] + 2];
    for (const o of this.membersDirectSubtree(subtree)) {
      const c: Placement = JSON.parse(JSON.stringify(o));
      c.group = idMap.get(o.group!);
      this.map.objects.push(c);
    }
    const newId = idMap.get(groupId)!;
    this.selectGroup(newId, "outliner");
    this.commit(true);
    return newId;
  }
  /** objects whose group is any id in `ids` (helper for group duplication) */
  private membersDirectSubtree(ids: string[]): Placement[] {
    const set = new Set(ids);
    return (this.map?.objects ?? []).filter((o) => o.group && set.has(o.group));
  }
  toggleGroupCollapsed(groupId: string): void {
    const g = this.groupById(groupId); if (!g) return;
    g.collapsed = !g.collapsed; this.emitChange();
  }

  // ── object CRUD ────────────────────────────────────────────────────────────
  /** append a placement and select it */
  add(o: Placement): number {
    if (!this.map) return -1;
    this.map.objects.push(o);
    const i = this.map.objects.length - 1;
    this.selection = [o];
    this.selObj = o;
    this.selGroup = null;
    // a freshly placed/dropped object is not an outliner pick — don't let the
    // camera reframe onto it (dropping should place where you dropped, not fly).
    this.selectSource = "viewport";
    this.commit(true);
    return i;
  }

  /** append several placements at once and select them all (one history entry) */
  addMany(objs: Placement[]): void {
    if (!this.map || !objs.length) return;
    for (const o of objs) this.map.objects.push(o);
    this.selection = objs.slice();
    this.selObj = objs[objs.length - 1] ?? null;
    this.selGroup = null;
    this.selectSource = "viewport";
    this.commit(true);
  }

  /** remove a set of placements (and drop them from the selection) */
  removeObjects(objs: Placement[]): void {
    if (!this.map || !objs.length) return;
    const set = new Set(objs);
    this.map.objects = this.map.objects.filter((o) => !set.has(o));
    this.selection = this.selection.filter((o) => !set.has(o));
    this.selObj = this.selection[this.selection.length - 1] ?? null;
    this.selGroup = null;
    this.commit(true);
  }

  /** remove a placement by index (clears it from the selection) */
  remove(index: number): void {
    if (!this.map) return;
    const removed = this.map.objects[index];
    this.map.objects.splice(index, 1);
    const si = this.selection.indexOf(removed);
    if (si >= 0) this.selection.splice(si, 1);
    if (this.selObj === removed) this.selObj = this.selection[this.selection.length - 1] ?? null;
    this.commit(true);
  }

  /** duplicate a placement (offset slightly) and select the copy */
  duplicate(index: number): void {
    if (!this.map) return;
    const src = this.map.objects[index];
    if (!src) return;
    const copy: Placement = JSON.parse(JSON.stringify(src));
    copy.at = [copy.at[0] + 2, copy.at[1], copy.at[2] + 2];
    this.add(copy);
  }

  /** live mutation during a drag: redraw only, no history entry */
  touch(): void { this.dirty = true; this.emitChange(); }

  /** finalize a discrete action: record history + redraw (+ optional inspector refresh) */
  commit(refreshSel = false): void {
    this.dirty = true;
    this.pushHistory();
    this.emitChange();
    if (refreshSel) this.emitSelect();
  }

  // ── undo / redo ──────────────────────────────────────────────────────────
  undo(): void {
    if (this.hi <= 0) return;
    this.hi--;
    this.restore(this.history[this.hi]);
  }
  redo(): void {
    if (this.hi >= this.history.length - 1) return;
    this.hi++;
    this.restore(this.history[this.hi]);
  }
  canUndo(): boolean { return this.hi > 0; }
  canRedo(): boolean { return this.hi < this.history.length - 1; }

  private restore(snap: Snapshot): void {
    this.map = this.clone(snap.map);
    const objs = this.map.objects;
    this.selGroup = null;
    this.selection = snap.sel.map((i) => objs[i]).filter((o): o is Placement => !!o);
    this.selObj = this.selection[this.selection.length - 1] ?? null;
    this.dirty = true;
    this.emitChange();
    this.emitSelect();
  }

  private pushHistory(): void {
    this.history.length = this.hi + 1;         // drop any redo branch
    this.history.push(this.snapshot());
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.hi = this.history.length - 1;
  }

  private snapshot(): Snapshot {
    return snapshotOf(this.map!, this.selection);
  }
  private clone(m: MapDef): MapDef { return JSON.parse(JSON.stringify(m)); }

  emitChange(): void { for (const fn of this.changeListeners) fn(); }
  emitSelect(): void { for (const fn of this.selListeners) fn(); }
}

/** a history snapshot: a deep clone of the map + the selection as indices */
function snapshotOf(map: MapDef, selection: Placement[]): Snapshot {
  const objs = map.objects;
  return { map: JSON.parse(JSON.stringify(map)), sel: selection.map((o) => objs.indexOf(o)).filter((i) => i >= 0) };
}

/** round a tuple to 2 decimals (matches the viewport's transform rounding) */
function round3(t: Tuple3): Tuple3 { return [r2(t[0]), r2(t[1]), r2(t[2])]; }
function r2(n: number): number { return Math.round(n * 100) / 100; }

export const state = new EditorState();
