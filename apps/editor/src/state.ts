// ─── Editor state: the map being edited + current selection, with listeners ──
import type { Brush, MapDef, Placement } from "@slopwars/shared";

export type SelKind = "none" | "env" | "brush" | "object" | "spawn" | "pickup" | "powerup";
export interface Selection { kind: SelKind; index: number }

type Listener = () => void;

class EditorState {
  map: MapDef | null = null;
  /** the map's file id (maps/<id>.json); may differ from meta.id until saved */
  fileId = "";
  dirty = false;
  sel: Selection = { kind: "none", index: -1 };

  private changeListeners = new Set<Listener>();   // map data changed → rebuild + trees
  private selListeners = new Set<Listener>();       // selection changed → inspector

  onChange(fn: Listener): void { this.changeListeners.add(fn); }
  onSelect(fn: Listener): void { this.selListeners.add(fn); }

  /** load a fresh map into the editor (clears selection + dirty flag) */
  setMap(map: MapDef, fileId: string): void {
    this.map = map;
    this.fileId = fileId;
    this.dirty = false;
    this.sel = { kind: "none", index: -1 };
    this.emitChange();
    this.emitSelect();
  }

  select(kind: SelKind, index: number): void {
    this.sel = { kind, index };
    this.emitSelect();
  }

  /** the currently-selected brush/object (or null) */
  selectedBrush(): Brush | null {
    return this.map && this.sel.kind === "brush" ? this.map.brushes[this.sel.index] ?? null : null;
  }
  selectedObject(): Placement | null {
    return this.map && this.sel.kind === "object" ? this.map.objects[this.sel.index] ?? null : null;
  }

  /** mark the map mutated: rebuild the viewport + refresh trees */
  touch(): void { this.dirty = true; this.emitChange(); }

  emitChange(): void { for (const fn of this.changeListeners) fn(); }
  emitSelect(): void { for (const fn of this.selListeners) fn(); }
}

export const state = new EditorState();
