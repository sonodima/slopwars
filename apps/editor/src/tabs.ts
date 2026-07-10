// ─── Viewport tabs: documents open in the editor ─────────────────────────────
// The viewport is tabbed, Unreal/Blender-style. Each tab is a *document*:
//   • map      — a map being edited (its own outliner + object inspector). Several
//                maps can be open at once; switching tabs swaps the active map
//                document in the editor state.
//   • material — an interactive lit sphere preview of a material (spin it, pick an
//                HDRI environment) with the material's controls in the inspector.
//   • model    — an interactive preview of a model with a Model/Collision sub-view
//                (author manual collision solids) and the model's controls.
//
// The tab manager owns the list + which is active, and drives the map documents in
// `state`. Double-clicking an asset in the browser opens (or focuses) its tab; the
// rest of the shell (viewport switch, left panel, inspector) reacts to onChange.
import { state } from "./state";
import { emptyMap, type MapDef } from "@slopwars/shared";

export type TabKind = "map" | "material" | "model" | "texture";
export type ModelView = "model" | "collision";

export interface Tab {
  id: string;
  kind: TabKind;
  /** material tabs: the material name */
  material?: string;
  /** model tabs: the model name */
  model?: string;
  /** texture tabs: the texture-set (folder) name */
  texture?: string;
  /** model tabs: model geometry vs. collision authoring */
  view?: ModelView;
}

type Listener = () => void;

class TabManager {
  tabs: Tab[] = [];
  activeId = "";
  private listeners = new Set<Listener>();
  private seq = 0;

  onChange(fn: Listener): void { this.listeners.add(fn); }
  private emit(): void { for (const fn of this.listeners) fn(); }
  private id(prefix: string): string { return `${prefix}-${(++this.seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

  active(): Tab | null { return this.tabs.find((t) => t.id === this.activeId) ?? null; }
  activeKind(): TabKind | null { return this.active()?.kind ?? null; }
  find(id: string): Tab | null { return this.tabs.find((t) => t.id === id) ?? null; }

  // ── map documents ────────────────────────────────────────────────────────────
  /** open a brand-new map document in its own tab (New Map). */
  newMap(): string {
    const fileId = `untitled-${Math.random().toString(36).slice(2, 6)}`;
    const def = emptyMap(fileId, "Untitled");
    return this.openMap(def, fileId);
  }

  /** open a loaded map in a tab. If a tab for this file id is already open, focus
   *  it instead of opening a duplicate. `def` is only used when opening fresh. */
  openMap(def: MapDef, fileId: string): string {
    const existing = state.docIdForFile(fileId);
    if (existing && this.find(existing)) { this.focus(existing); return existing; }
    const tab: Tab = { id: this.id("map"), kind: "map" };
    this.tabs.push(tab);
    state.openDocument(tab.id, def, fileId);
    this.activeId = tab.id;
    this.emit();
    return tab.id;
  }

  // ── asset preview documents ───────────────────────────────────────────────────
  /** open (or focus) a material preview tab. */
  openMaterial(name: string): string {
    const existing = this.tabs.find((t) => t.kind === "material" && t.material === name);
    if (existing) { this.focus(existing.id); return existing.id; }
    const tab: Tab = { id: this.id("mat"), kind: "material", material: name };
    this.tabs.push(tab);
    this.focus(tab.id);
    return tab.id;
  }

  /** open (or focus) a model preview tab. */
  openModel(name: string): string {
    const existing = this.tabs.find((t) => t.kind === "model" && t.model === name);
    if (existing) { this.focus(existing.id); return existing.id; }
    const tab: Tab = { id: this.id("mdl"), kind: "model", model: name, view: "model" };
    this.tabs.push(tab);
    this.focus(tab.id);
    return tab.id;
  }

  /** open (or focus) a texture-set editor tab. */
  openTexture(name: string): string {
    const existing = this.tabs.find((t) => t.kind === "texture" && t.texture === name);
    if (existing) { this.focus(existing.id); return existing.id; }
    const tab: Tab = { id: this.id("tex"), kind: "texture", texture: name };
    this.tabs.push(tab);
    this.focus(tab.id);
    return tab.id;
  }

  /** rename target of a material tab (after a material rename) so it stays open */
  retargetMaterial(from: string, to: string): void {
    let changed = false;
    for (const t of this.tabs) if (t.kind === "material" && t.material === from) { t.material = to; changed = true; }
    if (changed) this.emit();
  }

  /** rename target of a texture tab (after a texture-set rename) so it stays open */
  retargetTexture(from: string, to: string): void {
    let changed = false;
    for (const t of this.tabs) if (t.kind === "texture" && t.texture === from) { t.texture = to; changed = true; }
    if (changed) this.emit();
  }

  /** set a model tab's sub-view (model geometry vs. collision authoring) */
  setModelView(id: string, view: ModelView): void {
    const t = this.find(id);
    if (t && t.kind === "model" && t.view !== view) { t.view = view; this.emit(); }
  }

  // ── activation / close ─────────────────────────────────────────────────────────
  focus(id: string): void {
    const t = this.find(id);
    if (!t) return;
    this.activeId = id;
    if (t.kind === "map") state.activateDocument(id);
    this.emit();
  }

  /** focus the map tab that owns a document id (used when a selection/MCP op needs
   *  to bring the map back into view). Returns true if such a tab exists. */
  focusMapDoc(docId: string): boolean {
    const t = this.tabs.find((x) => x.kind === "map" && x.id === docId);
    if (!t) return false;
    this.focus(t.id);
    return true;
  }

  /** close any preview tab targeting a now-deleted asset */
  closeAsset(kind: "material" | "model" | "texture", name: string): void {
    const match = this.tabs.filter((t) => t.kind === kind && (t.material === name || t.model === name || t.texture === name));
    for (const t of match) this.close(t.id);
  }

  close(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const closing = this.tabs[idx];
    const wasActive = this.activeId === id;
    this.tabs.splice(idx, 1);
    if (closing.kind === "map") state.closeDocument(id);
    if (wasActive) {
      // prefer the neighbour to the left, else the new head
      const next = this.tabs[idx - 1] ?? this.tabs[idx] ?? this.tabs[0] ?? null;
      this.activeId = next?.id ?? "";
      if (next?.kind === "map") state.activateDocument(next.id);
    }
    this.emit();
  }
}

export const tabs = new TabManager();
