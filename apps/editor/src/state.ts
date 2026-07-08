// ─── Editor state: the map being edited + selection + groups + undo history ──
// Everything in a map is an object placement. Selection is held by *reference*
// (not raw indices) so it survives reordering/insertion/deletion, and supports
// multi-select (for group operations). Objects can belong to a nestable GroupDef
// which is a first-class parent with its own transform: members are stored in the
// group's local space, so transforming the group moves them as one (the game +
// editor compose world transforms up the group chain). A snapshot-based history
// records one entry per committed action so Ctrl/Cmd+Z / +Y step cleanly.
import type { GroupDef, MapDef, Placement, Tuple3, WorldTf } from "@slopwars/shared";
import { groupWorldTf, invComposeTf, resolveWorld } from "@slopwars/shared";

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
  /** when a model is being inspected (clicked in the asset browser), its name —
   *  drives the model inspector (meta.json editing). An asset, not part of the map. */
  selModel: string | null = null;
  /** when a texture is being inspected (clicked in the asset browser), its name —
   *  drives the texture inspector (preview + delete). An asset, not part of the map. */
  selTexture: string | null = null;
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
    migrateGroups(map);   // give legacy (transform-less) groups a pivot + local children
    this.map = map;
    this.fileId = fileId;
    this.dirty = false;
    this.selObj = null;
    this.selection = [];
    this.selGroup = null;
    this.selMaterial = null;
    this.selModel = null;
    this.selTexture = null;
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
    this.selModel = null;
    this.selTexture = null;
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
    this.selModel = null;
    this.selTexture = null;
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
    this.selModel = null;
    this.selTexture = null;
    this.selectSource = source;
    this.emitSelect();
  }

  /** pick a material to edit (asset browser) — clears the map selection so the
   *  inspector shows the material editor. */
  selectMaterial(name: string | null): void {
    this.selMaterial = name;
    this.selModel = null;
    this.selTexture = null;
    this.selGroup = null;
    this.selection = [];
    this.selObj = null;
    this.emitSelect();
  }

  /** pick a model to inspect (asset browser) — clears the map selection so the
   *  inspector shows the model editor (meta.json). */
  selectModel(name: string | null): void {
    this.selModel = name;
    this.selMaterial = null;
    this.selTexture = null;
    this.selGroup = null;
    this.selection = [];
    this.selObj = null;
    this.emitSelect();
  }

  /** pick a texture to inspect (asset browser) — clears the map selection so the
   *  inspector shows the texture editor (preview + delete). */
  selectTexture(name: string | null): void {
    this.selTexture = name;
    this.selMaterial = null;
    this.selModel = null;
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
    this.selModel = null;
    this.selTexture = null;
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
    this.selModel = null;
    this.selTexture = null;
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
    this.selMaterial = null;
    this.selModel = null;
    this.selTexture = null;
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
    this.selModel = null;
    this.selTexture = null;
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

/** round a tuple to 2 decimals (matches the viewport's transform rounding) */
function round3(t: Tuple3): Tuple3 { return [r2(t[0]), r2(t[1]), r2(t[2])]; }
function r2(n: number): number { return Math.round(n * 100) / 100; }

/** One-time upgrade of legacy (transform-less) groups to first-class parents: give
 *  each group a pivot at its members' world centroid and rebase every member (and
 *  nested group) into that group's local space. A legacy map stores members in
 *  absolute coordinates with no group transform; after this they compose back to
 *  the exact same world positions, so nothing moves — but the group can now be
 *  transformed as a unit. Idempotent: skips maps whose groups already have a pivot. */
function migrateGroups(map: MapDef): void {
  const groups = map.groups ?? [];
  if (!groups.length || groups.every((g) => g.at !== undefined)) return;

  // world centroid of each group from the (still absolute) member positions
  const centroid = new Map<string, Tuple3>();
  const membersRec = (gid: string): Placement[] => {
    const out = map.objects.filter((o) => o.group === gid);
    for (const g of groups.filter((x) => x.parent === gid)) out.push(...membersRec(g.id));
    return out;
  };
  for (const g of groups) {
    const m = membersRec(g.id);
    if (!m.length) { centroid.set(g.id, [0, 0, 0]); continue; }
    let x = 0, y = 0, z = 0;
    for (const o of m) { x += o.at[0]; y += o.at[1]; z += o.at[2]; }
    centroid.set(g.id, [x / m.length, y / m.length, z / m.length]);
  }
  // rebase members to their immediate group's local space (pure translation, since
  // migrated group transforms are identity-rotation/scale)
  for (const o of map.objects) {
    if (!o.group) continue;
    const c = centroid.get(o.group); if (!c) continue;
    o.at = [r2(o.at[0] - c[0]), r2(o.at[1] - c[1]), r2(o.at[2] - c[2])];
  }
  // give each group its pivot (relative to its parent's pivot)
  for (const g of groups) {
    const c = centroid.get(g.id) ?? [0, 0, 0];
    const pc = g.parent ? (centroid.get(g.parent) ?? [0, 0, 0]) : [0, 0, 0];
    g.at = [r2(c[0] - pc[0]), r2(c[1] - pc[1]), r2(c[2] - pc[2])];
    g.rot = [0, 0, 0];
    g.scale = [1, 1, 1];
  }
}

export const state = new EditorState();
