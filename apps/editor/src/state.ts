// ─── Editor state: the map being edited + current selection + undo history ───
// Everything in a map is an object placement. Selection is held by *reference*
// to the placement (not a raw index) so it survives reordering, insertion and
// deletion — the index is derived on demand. A snapshot-based history records
// one entry per committed action (add/remove/transform/field edit) so Ctrl/Cmd
// +Z / +Y step cleanly through them. Live drags call touch() (redraw only); the
// finalizing commit() is what records history.
import type { MapDef, Placement } from "@slopwars/shared";

type Listener = () => void;

interface Snapshot { map: MapDef; sel: number }
const HISTORY_CAP = 200;

class EditorState {
  map: MapDef | null = null;
  /** the map's file id (maps/<id>.json); may differ from meta.id until saved */
  fileId = "";
  dirty = false;
  /** the selected placement, by reference (null = nothing selected) */
  selObj: Placement | null = null;
  /** where the last selection came from — lets the viewport decide to reframe
   *  (outliner clicks) and the outliner decide to scroll (viewport clicks). */
  selectSource: "outliner" | "viewport" | "" = "";

  private history: Snapshot[] = [];
  private hi = -1;

  private changeListeners = new Set<Listener>();   // map data changed → rebuild + trees
  private selListeners = new Set<Listener>();       // selection changed → inspector

  onChange(fn: Listener): void { this.changeListeners.add(fn); }
  onSelect(fn: Listener): void { this.selListeners.add(fn); }

  /** index of the selected placement in the current map (-1 if none/stale) */
  get selIndex(): number {
    return this.map && this.selObj ? this.map.objects.indexOf(this.selObj) : -1;
  }

  setMap(map: MapDef, fileId: string): void {
    this.map = map;
    this.fileId = fileId;
    this.dirty = false;
    this.selObj = null;
    this.history = [this.snapshot()];
    this.hi = 0;
    this.emitChange();
    this.emitSelect();
  }

  select(index: number, source: "outliner" | "viewport" | "" = ""): void {
    this.selObj = this.map?.objects[index] ?? null;
    this.selectSource = source;
    this.emitSelect();
  }

  selected(): Placement | null {
    return this.selIndex >= 0 ? this.selObj : null;
  }

  /** append a placement and select it */
  add(o: Placement): number {
    if (!this.map) return -1;
    this.map.objects.push(o);
    const i = this.map.objects.length - 1;
    this.selObj = o;
    this.commit(true);
    return i;
  }

  /** remove a placement by index (clears selection if it was the target) */
  remove(index: number): void {
    if (!this.map) return;
    const removed = this.map.objects[index];
    this.map.objects.splice(index, 1);
    if (this.selObj === removed) this.selObj = null;
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
    this.selObj = this.map.objects[snap.sel] ?? null;
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
    return { map: this.clone(this.map!), sel: this.selIndex };
  }
  private clone(m: MapDef): MapDef { return JSON.parse(JSON.stringify(m)); }

  emitChange(): void { for (const fn of this.changeListeners) fn(); }
  emitSelect(): void { for (const fn of this.selListeners) fn(); }
}

export const state = new EditorState();
