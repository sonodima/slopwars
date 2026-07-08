// ─── Editor state: the map being edited + selection + groups + undo history ──
// Everything in a map is an object placement. Selection is held by *reference*
// (not raw indices) so it survives reordering/insertion/deletion, and supports
// multi-select (for group operations). Objects can belong to a nestable GroupDef
// (organizational only — the game ignores groups); the editor moves/scales/rotates
// a group's members together. A snapshot-based history records one entry per
// committed action so Ctrl/Cmd+Z / +Y step cleanly through them.
import type { GroupDef, MapDef, Placement } from "@slopwars/shared";

type Listener = () => void;

interface Snapshot { map: MapDef; sel: number[] }
const HISTORY_CAP = 200;

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
  /** when a material is being edited (picked in the asset browser), its name —
   *  drives the material inspector. An asset, not part of the map; cleared by any
   *  object/group selection. */
  selMaterial: string | null = null;
  /** where the last selection came from — lets the viewport reframe (outliner
   *  clicks) and the outliner scroll (viewport clicks). */
  selectSource: "outliner" | "viewport" | "" = "";

  private history: Snapshot[] = [];
  private hi = -1;

  private changeListeners = new Set<Listener>();   // map data changed → rebuild + trees
  private selListeners = new Set<Listener>();       // selection changed → inspector

  onChange(fn: Listener): void { this.changeListeners.add(fn); }
  onSelect(fn: Listener): void { this.selListeners.add(fn); }

  /** index of the primary selected placement in the current map (-1 if none) */
  get selIndex(): number {
    return this.map && this.selObj ? this.map.objects.indexOf(this.selObj) : -1;
  }

  setMap(map: MapDef, fileId: string): void {
    this.map = map;
    this.fileId = fileId;
    this.dirty = false;
    this.selObj = null;
    this.selection = [];
    this.selGroup = null;
    this.selMaterial = null;
    this.history = [this.snapshot()];
    this.hi = 0;
    this.emitChange();
    this.emitSelect();
  }

  // ── selection ──────────────────────────────────────────────────────────────
  /** select by index. `additive` toggles membership in a multi-selection. */
  select(index: number, source: "outliner" | "viewport" | "" = "", additive = false): void {
    this.selGroup = null;
    this.selMaterial = null;
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
    this.selMaterial = null;
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
    this.selMaterial = null;
    this.selectSource = source;
    this.emitSelect();
  }

  /** pick a material to edit (asset browser) — clears the map selection so the
   *  inspector shows the material editor. */
  selectMaterial(name: string | null): void {
    this.selMaterial = name;
    this.selGroup = null;
    this.selection = [];
    this.selObj = null;
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
  groups(): GroupDef[] { return this.map?.groups ?? []; }
  private ensureGroups(): GroupDef[] { if (!this.map) return []; return (this.map.groups ??= []); }
  groupById(id: string | undefined): GroupDef | undefined { return id ? this.groups().find((g) => g.id === id) : undefined; }
  /** child groups of a parent (undefined parent = top level) */
  childGroups(parent: string | undefined): GroupDef[] { return this.groups().filter((g) => (g.parent ?? undefined) === (parent ?? undefined)); }
  /** objects directly in a group */
  membersDirect(groupId: string): Placement[] { return (this.map?.objects ?? []).filter((o) => o.group === groupId); }
  /** objects in a group and all its descendant groups */
  membersOf(groupId: string, recursive: boolean): Placement[] {
    const out = this.membersDirect(groupId);
    if (recursive) for (const g of this.childGroups(groupId)) out.push(...this.membersOf(g.id, true));
    return out;
  }

  /** create a group from the current selection; nests under a shared parent group
   *  if every selected object already belongs to the same one. Returns its id. */
  createGroup(name?: string): string | null {
    if (!this.map) return null;
    const sel = this.selectedObjects();
    if (!sel.length) return null;
    const parents = new Set(sel.map((o) => o.group ?? ""));
    const parent = parents.size === 1 ? ([...parents][0] || undefined) : undefined;
    const id = `grp-${Math.random().toString(36).slice(2, 8)}`;
    this.ensureGroups().push({ id, name: name || `Group ${this.groups().length + 1}`, parent });
    for (const o of sel) o.group = id;
    this.commit(true);
    return id;
  }

  /** dissolve a group: its objects and child groups move up to its parent */
  ungroup(groupId: string): void {
    if (!this.map) return;
    const g = this.groupById(groupId);
    if (!g) return;
    const parent = g.parent;
    for (const o of this.membersDirect(groupId)) o.group = parent;
    for (const child of this.childGroups(groupId)) child.parent = parent;
    this.map.groups = this.groups().filter((x) => x.id !== groupId);
    this.commit(true);
  }

  /** move an object into a group (or to top level with undefined) */
  setObjectGroup(o: Placement, groupId: string | undefined): void {
    o.group = groupId;
    this.commit(true);
  }
  /** reparent a group (guards against cycles); undefined = top level */
  setGroupParent(groupId: string, parent: string | undefined): void {
    const g = this.groupById(groupId);
    if (!g || groupId === parent) return;
    // reject if `parent` is a descendant of groupId (would create a cycle)
    let p = parent;
    while (p) { if (p === groupId) return; p = this.groupById(p)?.parent; }
    g.parent = parent;
    this.commit(true);
  }
  renameGroup(groupId: string, name: string): void {
    const g = this.groupById(groupId); if (!g) return;
    g.name = name; this.commit(true);
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
    this.selMaterial = null;
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
    this.selMaterial = null;
    this.selectSource = "viewport";
    this.commit(true);
  }

  /** translate every member of a group (recursively) by a world delta — the
   *  group inspector's Location field edits the group's centroid this way. */
  moveGroup(groupId: string, dx: number, dy: number, dz: number): void {
    if (!dx && !dy && !dz) return;
    for (const o of this.membersOf(groupId, true)) {
      o.at = [o.at[0] + dx, o.at[1] + dy, o.at[2] + dz];
    }
    this.commit();
  }

  /** rotate a group's members about its centroid by a euler-degree delta (members
   *  orbit the pivot and spin in place) — the inspector's group Rotation field. */
  rotateGroup(groupId: string, dx: number, dy: number, dz: number): void {
    if (!dx && !dy && !dz) return;
    const c = this.groupCentroid(groupId); if (!c) return;
    const members = this.membersOf(groupId, true);
    for (const o of members) {
      let rel: [number, number, number] = [o.at[0] - c[0], o.at[1] - c[1], o.at[2] - c[2]];
      const rot = (o.rot ?? [0, 0, 0]).slice() as [number, number, number];
      const D = Math.PI / 180;
      if (dx) { rel = rotAxis(rel, 0, dx * D); rot[0] += dx; }
      if (dy) { rel = rotAxis(rel, 1, dy * D); rot[1] += dy; }
      if (dz) { rel = rotAxis(rel, 2, dz * D); rot[2] += dz; }
      o.at = [r2(c[0] + rel[0]), r2(c[1] + rel[1]), r2(c[2] + rel[2])];
      o.rot = [r2(rot[0]), r2(rot[1]), r2(rot[2])];
    }
    this.commit();
  }

  /** scale a group's members about its centroid by a per-axis factor — the
   *  inspector's group Scale field. */
  scaleGroup(groupId: string, fx: number, fy: number, fz: number): void {
    if (fx === 1 && fy === 1 && fz === 1) return;
    const c = this.groupCentroid(groupId); if (!c) return;
    for (const o of this.membersOf(groupId, true)) {
      const s = (o.scale ?? [1, 1, 1]).slice() as [number, number, number];
      o.scale = [r2(Math.max(0.02, s[0] * fx)), r2(Math.max(0.02, s[1] * fy)), r2(Math.max(0.02, s[2] * fz))];
      o.at = [r2(c[0] + (o.at[0] - c[0]) * fx), r2(c[1] + (o.at[1] - c[1]) * fy), r2(c[2] + (o.at[2] - c[2]) * fz)];
    }
    this.commit();
  }

  /** centroid of a group's members (world) — undefined if the group is empty */
  groupCentroid(groupId: string): [number, number, number] | undefined {
    const m = this.membersOf(groupId, true);
    if (!m.length) return undefined;
    let x = 0, y = 0, z = 0;
    for (const o of m) { x += o.at[0]; y += o.at[1]; z += o.at[2]; }
    return [x / m.length, y / m.length, z / m.length];
  }

  /** remove a set of placements (and drop them from the selection) */
  removeObjects(objs: Placement[]): void {
    if (!this.map || !objs.length) return;
    const set = new Set(objs);
    this.map.objects = this.map.objects.filter((o) => !set.has(o));
    this.selection = this.selection.filter((o) => !set.has(o));
    this.selObj = this.selection[this.selection.length - 1] ?? null;
    this.selGroup = null;
    this.selMaterial = null;
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
    this.selMaterial = null;
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
    const objs = this.map?.objects ?? [];
    return { map: this.clone(this.map!), sel: this.selection.map((o) => objs.indexOf(o)).filter((i) => i >= 0) };
  }
  private clone(m: MapDef): MapDef { return JSON.parse(JSON.stringify(m)); }

  emitChange(): void { for (const fn of this.changeListeners) fn(); }
  emitSelect(): void { for (const fn of this.selListeners) fn(); }
}

/** round to 2 decimals (matches the viewport's transform rounding) */
function r2(n: number): number { return Math.round(n * 100) / 100; }
/** rotate a vector about world axis idx (0=x,1=y,2=z) by rad (right-handed) */
function rotAxis(v: [number, number, number], idx: number, rad: number): [number, number, number] {
  const c = Math.cos(rad), s = Math.sin(rad);
  if (idx === 0) return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  if (idx === 1) return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

export const state = new EditorState();
