// ─── Asset browser (bottom dock) — tabbed ────────────────────────────────────
// One tab per asset class (Objects · Models · Materials · Textures · Skyboxes ·
// Audio · Maps) instead of one long scroll. The active tab shows a search box + a
// context action: Import (models/textures/skyboxes/audio bring files into the
// project), or Create (materials are *created* not imported; maps too). Cards are
// draggable onto the viewport / inspector slots. Double-clicking a model/material/
// texture opens its preview/editor tab (or a map loads it); a texture card shows the
// PBR maps its set holds as an auto-fitting grid. Right-clicking any card opens
// Unity-style context actions (Open / Delete…).
import type { AssetCatalog, MapCatalogEntry } from "@slopwars/shared";
import { objectCatalog, objectIcon } from "@game/objects";
import { clear, el, contextMenu, confirmDelete, type MenuItem } from "./ui";
import { icon, type IconName } from "./icons";
import { ThumbRenderer } from "./preview";
import { openImport, type ImportKind } from "./importer";
import { audioPreview } from "./audiopreview";

export interface PanelCtx {
  catalog: AssetCatalog;
  thumbs: ThumbRenderer;
  reloadCatalog: () => Promise<AssetCatalog>;
  listMaps: () => Promise<MapCatalogEntry[]>;
  onOpenMaterial: (name: string) => void;
  onOpenModel: (name: string) => void;
  onOpenTexture: (name: string) => void;
  onCreateMaterial: () => void;
  onCreateTexture: () => void;
  onLoadMap: (file: string) => void;
  onCreateMap: () => void;
  // right-click deletes (Unity-style context actions; delete is no longer an
  // inspector button). Each returns once the catalog has been refreshed.
  onDeleteModel: (name: string) => void;
  onDeleteMaterial: (name: string) => void;
  onDeleteTexture: (name: string) => void;
  onDeleteHdri: (file: string) => void;
  onDeleteAudio: (file: string) => void;
  onDeleteMap: (file: string) => void;
}

const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;

/** attach a right-click context menu (Unity-style) to an asset card */
function ctxMenu(card: HTMLElement, items: () => MenuItem[]): void {
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); contextMenu(e.clientX, e.clientY, items()); });
}

type Tab = "Objects" | "Models" | "Materials" | "Textures" | "Skyboxes" | "Audio" | "Maps";
const TABS: Tab[] = ["Objects", "Models", "Materials", "Textures", "Skyboxes", "Audio", "Maps"];
/** which tabs import files vs create in-place vs neither. Textures are CREATED (an
 *  empty group you then fill map-by-map in the editor), not imported via a dialog. */
const IMPORT_KIND: Partial<Record<Tab, ImportKind>> = { Models: "model", Skyboxes: "hdri", Audio: "audio" };

export interface BrowserControl { reload: () => Promise<void>; refreshMaps: () => void; showMaterials: () => void }

export function renderBrowser(host: HTMLElement, ctx: PanelCtx): BrowserControl {
  clear(host);
  let active: Tab = "Objects";
  let query = "";
  let maps: MapCatalogEntry[] = [];

  const bar = el("div", "browser-bar");
  const tabs = el("div", "browser-tabs");
  for (const t of TABS) {
    const b = el("button", "browser-tab", t); b.dataset.tab = t;
    b.addEventListener("click", () => { active = t; query = ""; search.value = ""; syncTabs(); draw(); });
    tabs.append(b);
  }
  const search = el("input", "browser-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); draw(); });
  const action = el("button", "btn mini imp-btn");
  bar.append(tabs, search, action);

  const body = el("div", "browser-body");
  host.append(bar, body);

  const match = (s: string): boolean => !query || s.toLowerCase().includes(query);
  const syncTabs = (): void => {
    for (const b of Array.from(tabs.querySelectorAll<HTMLElement>(".browser-tab"))) b.classList.toggle("on", b.dataset.tab === active);
  };

  const reload = async (): Promise<void> => { ctx.catalog = await ctx.reloadCatalog(); draw(); };

  const grid = el("div", "asset-grid");
  const draw = (): void => {
    // context action button (Import files / Create in place / hidden)
    const setAction = (ic: IconName, label: string, fn: () => void): void => {
      clear(action); action.append(icon(ic), el("span", "btn-label", label));
      action.style.display = ""; action.onclick = fn;
    };
    const imp = IMPORT_KIND[active];
    if (imp) setAction("download", "Import", () => openImport(imp, () => void reload()));
    else if (active === "Materials") setAction("plus", "New", ctx.onCreateMaterial);
    else if (active === "Textures") setAction("plus", "New", ctx.onCreateTexture);
    else if (active === "Maps") setAction("plus", "New", ctx.onCreateMap);
    else { action.style.display = "none"; action.onclick = null; }

    clear(grid);
    if (active === "Objects") drawObjects();
    else if (active === "Models") drawModels();
    else if (active === "Materials") drawMaterials();
    else if (active === "Textures") drawTextures();
    else if (active === "Skyboxes") drawSkyboxes();
    else if (active === "Audio") drawAudio();
    else if (active === "Maps") drawMaps();
    if (!grid.childElementCount) grid.append(el("div", "empty", query ? "No matches" : "Nothing here"));
  };

  // categories whose real built geometry makes a meaningful thumbnail. Everything else
  // (markers, sounds, lights, particle emitters, the bare prop) keeps its icon — a
  // rendered ball/blob for those says nothing, its icon says what it is.
  const THUMB_CATS = new Set(["geometry", "structure"]);
  const drawObjects = (): void => {
    for (const o of objectCatalog()) {
      if (!match(o.name)) continue;
      const c = card(o.name, objectIcon(o.name) as IconName, () => ({ kind: "object", name: o.name }));
      c.title = "drag into the viewport to place";
      if (THUMB_CATS.has(o.category)) fillThumb(c, ctx.thumbs.objectThumb(o.name, o.category));
      grid.append(c);
    }
  };
  const drawModels = (): void => {
    for (const m of ctx.catalog.models) {
      if (!match(m.name) && !match(m.folder)) continue;
      const c = card(m.name, "box", () => ({ kind: "model", name: m.name, id: m.id }), m.folder);
      c.title = "double-click to open · drag into the viewport to place · right-click for actions";
      c.addEventListener("dblclick", () => ctx.onOpenModel(m.name));
      ctxMenu(c, () => [
        { label: "Open", icon: "eye", onClick: () => ctx.onOpenModel(m.name) },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`model "${m.name}"`, () => ctx.onDeleteModel(m.name)) },
      ]);
      fillThumb(c, ctx.thumbs.modelThumb(m.gltf));
      grid.append(c);
    }
  };
  const drawMaterials = (): void => {
    for (const mt of ctx.catalog.materials) {
      if (!match(mt.name) && !match(mt.folder)) continue;
      const c = card(mt.name, "material", () => ({ kind: "material", name: mt.name, id: mt.id }), mt.folder);
      c.title = "double-click to open · right-click for actions";
      c.addEventListener("dblclick", () => ctx.onOpenMaterial(mt.name));
      ctxMenu(c, () => [
        { label: "Open", icon: "eye", onClick: () => ctx.onOpenMaterial(mt.name) },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`material "${mt.name}"`, () => ctx.onDeleteMaterial(mt.name)) },
      ]);
      fillThumb(c, ctx.thumbs.materialThumb(mt.id, mt.def, ctx.catalog));
      grid.append(c);
    }
  };
  // A texture is a *set* of PBR maps (a texture group). The card shows the maps it
  // holds as an auto-fitting grid of flat bitmaps — you're looking at raw image data;
  // materials are what turn a set into a surface. Double-click opens the set editor.
  const drawTextures = (): void => {
    for (const t of ctx.catalog.textures) {
      if (!match(t.name) && !match(t.folder)) continue;
      const c = card(t.name, "image", () => ({ kind: "texture", name: t.name, id: t.id }), t.folder);
      c.title = "double-click to open · drag onto a material's texture slot · right-click for actions";
      c.addEventListener("dblclick", () => ctx.onOpenTexture(t.name));
      ctxMenu(c, () => [
        { label: "Open", icon: "eye", onClick: () => ctx.onOpenTexture(t.name) },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`texture "${t.name}"`, () => ctx.onDeleteTexture(t.name)) },
      ]);
      fillTexGrid(c, t.maps);
      grid.append(c);
    }
  };
  const drawSkyboxes = (): void => {
    for (const h of ctx.catalog.hdri) {
      if (!match(h.name) && !match(h.folder)) continue;
      const c = card(h.name, "mountain", () => ({ kind: "hdri", name: h.name, id: h.id }), h.folder);
      c.title = "drag onto the world's sky slot · right-click for actions";
      ctxMenu(c, () => [
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`skybox "${h.name}"`, () => ctx.onDeleteHdri(h.file)) },
      ]);
      fillThumb(c, ctx.thumbs.hdriThumb(h.file));
      grid.append(c);
    }
  };
  const drawAudio = (): void => {
    for (const a of ctx.catalog.audio) {
      if (!match(a.name) && !match(a.folder)) continue;
      const c = card(a.name, "volume", () => ({ kind: "audio", name: a.name, id: a.id }), a.folder);
      c.title = "drag into the viewport to place a sound · click ▶ to preview · right-click for actions";
      ctxMenu(c, () => [
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`audio "${a.name}"`, () => ctx.onDeleteAudio(a.file)) },
      ]);
      // the thumbnail slot becomes the waveform preview (play/stop + scrubbing built in)
      const thumb = c.querySelector(".asset-thumb");
      if (thumb) { thumb.classList.add("audio-thumb"); clear(thumb as HTMLElement); thumb.append(audioPreview(ASSET(a.file))); }
      grid.append(c);
    }
  };
  const drawMaps = (): void => {
    for (const m of maps) {
      if (!match(m.name) && !match(m.id)) continue;
      const c = el("div", "asset-card map-card");
      const thumb = el("div", "asset-thumb"); thumb.append(icon("map", "asset-icon-svg"));
      c.append(thumb, el("div", "asset-name", m.name), el("div", "asset-sub", m.id));
      c.title = "double-click to load · right-click for actions";
      c.addEventListener("dblclick", () => ctx.onLoadMap(m.file));
      ctxMenu(c, () => [
        { label: "Load", icon: "map", onClick: () => ctx.onLoadMap(m.file) },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => confirmDelete(`map "${m.name}"`, () => ctx.onDeleteMap(m.file)) },
      ]);
      grid.append(c);
    }
  };

  body.append(grid);
  syncTabs();
  draw();
  const refreshMaps = (): void => void ctx.listMaps().then((m) => { maps = m; if (active === "Maps") draw(); });
  refreshMaps();

  return {
    reload,
    refreshMaps,
    showMaterials: () => { active = "Materials"; query = ""; search.value = ""; syncTabs(); draw(); },
  };
}

/** a draggable asset card carrying a placement payload. `sub` is an optional second
 *  line (the asset's group folder), so a foldered library reads as grouped. */
function card(name: string, ic: IconName, payload: () => Payload, sub?: string): HTMLElement {
  const c = el("div", "asset-card grab");
  const thumb = el("div", "asset-thumb"); thumb.append(icon(ic, "asset-icon-svg"));
  c.append(thumb, el("div", "asset-name", name));
  if (sub) c.append(el("div", "asset-sub", sub));
  c.draggable = true;
  c.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("application/x-slop", JSON.stringify(payload())); });
  return c;
}

/** swap a card's thumbnail slot for a rendered image once it resolves */
function fillThumb(c: HTMLElement, p: Promise<string | null>): void {
  const slot = c.querySelector(".asset-thumb");
  if (!slot) return;
  void p.then((url) => {
    if (!url) return;
    const img = el("img", "thumb-img"); img.src = url; img.loading = "lazy";
    slot.replaceChildren(img);
  });
}

/** fill a texture card's thumb with the maps its set holds, as an auto-fitting grid
 *  (1 map → fills the slot; 2–3 → squares that shrink to fit). Keeps the icon
 *  fallback when the set has no maps at all. */
const TEX_ORDER = ["color", "normal", "arm"] as const;
function fillTexGrid(c: HTMLElement, maps: Record<string, string | undefined>): void {
  const slot = c.querySelector(".asset-thumb");
  if (!slot) return;
  const present = TEX_ORDER.map((k) => maps[k]).filter((p): p is string => !!p);
  if (!present.length) return;   // keep the placeholder icon
  const gridEl = el("div", "tex-grid");
  gridEl.style.gridTemplateColumns = `repeat(${Math.min(present.length, 2)}, 1fr)`;
  for (const p of present) { const img = el("img", "thumb-img"); img.src = ASSET(p); img.loading = "lazy"; gridEl.append(img); }
  slot.replaceChildren(gridEl);
}

export interface Payload { kind: "object" | "model" | "audio" | "texture" | "material" | "hdri"; name: string; id?: string }
