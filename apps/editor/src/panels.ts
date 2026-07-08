// ─── Asset browser (bottom dock) — tabbed ────────────────────────────────────
// One tab per asset class (Objects · Models · Materials · Textures · Skyboxes ·
// Audio · Maps) instead of one long scroll. The active tab shows a search box + a
// context action: Import (models/textures/skyboxes/audio bring files into the
// project), or Create (materials are *created* not imported; maps too). Cards are
// draggable onto the viewport / inspector slots. Double-clicking an asset opens (or
// focuses) its viewport tab: a material/model/texture preview, or a loaded map.
import type { AssetCatalog, MapCatalogEntry } from "@slopwars/shared";
import { objectCatalog } from "@game/objects";
import { clear, el } from "./ui";
import { ThumbRenderer } from "./preview";
import { openImport, type ImportKind } from "./importer";

export interface PanelCtx {
  catalog: AssetCatalog;
  thumbs: ThumbRenderer;
  reloadCatalog: () => Promise<AssetCatalog>;
  listMaps: () => Promise<MapCatalogEntry[]>;
  onOpenMaterial: (name: string) => void;
  onOpenModel: (name: string) => void;
  onOpenTexture: (name: string) => void;
  onCreateMaterial: () => void;
  onLoadMap: (file: string) => void;
  onCreateMap: () => void;
}

const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;

const CAT_ICON: Record<string, string> = {
  geometry: "◼", marker: "⚑", sound: "♪", light: "💡", entity: "◈", structure: "▤", prop: "◆",
};

type Tab = "Objects" | "Models" | "Materials" | "Textures" | "Skyboxes" | "Audio" | "Maps";
const TABS: Tab[] = ["Objects", "Models", "Materials", "Textures", "Skyboxes", "Audio", "Maps"];
/** which tabs import files vs create in-place vs neither */
const IMPORT_KIND: Partial<Record<Tab, ImportKind>> = { Models: "model", Textures: "texture", Skyboxes: "hdri", Audio: "audio" };

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
    const imp = IMPORT_KIND[active];
    if (imp) { action.textContent = "＋ Import"; action.style.display = ""; action.onclick = () => openImport(imp, () => void reload()); }
    else if (active === "Materials") { action.textContent = "＋ New"; action.style.display = ""; action.onclick = ctx.onCreateMaterial; }
    else if (active === "Maps") { action.textContent = "＋ New"; action.style.display = ""; action.onclick = ctx.onCreateMap; }
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

  const drawObjects = (): void => {
    for (const o of objectCatalog()) {
      if (!match(o.name)) continue;
      const c = card(o.name, CAT_ICON[o.category] ?? "◆", () => ({ kind: "object", name: o.name }));
      fillThumb(c, ctx.thumbs.objectThumb(o.name, o.category));
      grid.append(c);
    }
  };
  const drawModels = (): void => {
    for (const m of ctx.catalog.models) {
      if (!match(m.name)) continue;
      const c = card(m.name, "▣", () => ({ kind: "model", name: m.name }));
      c.title = "double-click to open · drag into the viewport to place";
      c.addEventListener("dblclick", () => ctx.onOpenModel(m.name));
      fillThumb(c, ctx.thumbs.modelThumb(m.gltf));
      grid.append(c);
    }
  };
  const drawMaterials = (): void => {
    for (const mt of ctx.catalog.materials) {
      if (!match(mt.name)) continue;
      const c = card(mt.name, "◆", () => ({ kind: "material", name: mt.name }));
      c.title = "double-click to open";
      c.addEventListener("dblclick", () => ctx.onOpenMaterial(mt.name));
      fillThumb(c, ctx.thumbs.materialThumb(mt.name, mt.def, ctx.catalog));
      grid.append(c);
    }
  };
  // Textures render the flat image (the actual bitmap), not a lit sphere: you're
  // looking at raw image data here, and materials are what turn it into a surface.
  const drawTextures = (): void => {
    for (const t of ctx.catalog.textures) {
      if (!match(t.name)) continue;
      const c = card(t.name, "▦", () => ({ kind: "texture", name: t.name }));
      c.title = "double-click to open";
      c.addEventListener("dblclick", () => ctx.onOpenTexture(t.name));
      if (t.maps.color) fillImg(c, ASSET(t.maps.color));
      grid.append(c);
    }
  };
  const drawSkyboxes = (): void => {
    for (const h of ctx.catalog.hdri) {
      if (!match(h.name)) continue;
      const c = card(h.name, "🌅", () => ({ kind: "hdri", name: h.name }));
      fillThumb(c, ctx.thumbs.hdriThumb(h.file));
      grid.append(c);
    }
  };
  const drawAudio = (): void => {
    for (const a of ctx.catalog.audio) {
      if (!match(a.name)) continue;
      const c = card(a.name, "♪", () => ({ kind: "audio", name: a.name }));
      c.append(audioControls(ASSET(a.file)));
      grid.append(c);
    }
  };
  const drawMaps = (): void => {
    for (const m of maps) {
      if (!match(m.name) && !match(m.id)) continue;
      const c = el("div", "asset-card map-card");
      c.append(el("div", "asset-thumb", "🗺"), el("div", "asset-name", m.name), el("div", "asset-sub", m.id));
      c.title = "double-click to load";
      c.addEventListener("dblclick", () => ctx.onLoadMap(m.file));
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

/** a draggable asset card carrying a placement payload */
function card(name: string, icon: string, payload: () => Payload): HTMLElement {
  const c = el("div", "asset-card grab");
  const thumb = el("div", "asset-thumb"); thumb.append(el("div", "asset-icon", icon));
  c.append(thumb, el("div", "asset-name", name));
  c.draggable = true;
  c.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("application/x-slop", JSON.stringify(payload())); });
  return c;
}

function audioControls(src: string): HTMLElement {
  const audio = new Audio(src); audio.preload = "none";
  const box = el("div", "asset-audioctl");
  const play = el("button", "btn", "▶ Play");
  const stop = el("button", "btn", "■ Stop");
  play.addEventListener("click", (e) => { e.stopPropagation(); void audio.play().catch(() => { /* needs gesture */ }); });
  stop.addEventListener("click", (e) => { e.stopPropagation(); audio.pause(); audio.currentTime = 0; });
  box.append(play, stop);
  return box;
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

/** put a flat image straight into a card's thumbnail slot (textures) */
function fillImg(c: HTMLElement, src: string): void {
  const slot = c.querySelector(".asset-thumb");
  if (!slot) return;
  const img = el("img", "thumb-img"); img.src = src; img.loading = "lazy";
  slot.replaceChildren(img);
}

export interface Payload { kind: "object" | "model" | "audio" | "texture" | "material" | "hdri"; name: string }
