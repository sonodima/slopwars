// ─── Editor state: the map being edited + current selection, with listeners ──
// Everything in a map is an object placement now, so selection is just an index
// into `map.objects` (-1 = nothing selected).
import type { MapDef, Placement } from "@slopwars/shared";

type Listener = () => void;

class EditorState {
  map: MapDef | null = null;
  /** the map's file id (maps/<id>.json); may differ from meta.id until saved */
  fileId = "";
  dirty = false;
  sel = { index: -1 };

  private changeListeners = new Set<Listener>();   // map data changed → rebuild + trees
  private selListeners = new Set<Listener>();       // selection changed → inspector

  onChange(fn: Listener): void { this.changeListeners.add(fn); }
  onSelect(fn: Listener): void { this.selListeners.add(fn); }

  setMap(map: MapDef, fileId: string): void {
    this.map = map;
    this.fileId = fileId;
    this.dirty = false;
    this.sel = { index: -1 };
    this.emitChange();
    this.emitSelect();
  }

  select(index: number): void {
    this.sel = { index };
    this.emitSelect();
  }

  selected(): Placement | null {
    return this.map && this.sel.index >= 0 ? this.map.objects[this.sel.index] ?? null : null;
  }

  /** append a placement and select it */
  add(o: Placement): number {
    if (!this.map) return -1;
    this.map.objects.push(o);
    const i = this.map.objects.length - 1;
    this.touch();
    this.select(i);
    return i;
  }

  /** remove a placement by index (fixes up selection) */
  remove(index: number): void {
    if (!this.map) return;
    this.map.objects.splice(index, 1);
    if (this.sel.index === index) this.select(-1);
    else if (this.sel.index > index) this.sel.index--;
    this.touch();
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

  /** mark the map mutated: rebuild the viewport + refresh trees */
  touch(): void { this.dirty = true; this.emitChange(); }

  emitChange(): void { for (const fn of this.changeListeners) fn(); }
  emitSelect(): void { for (const fn of this.selListeners) fn(); }
}

export const state = new EditorState();
