// ─── Asset browser (bottom dock) — sectioned + importable ────────────────────
// Everything the pipeline discovered, grouped into collapsible sections: placeable
// Objects, Models (drag → "prop"), Textures, Skyboxes (HDRIs, drag → World sky),
// and Audio (drag → "sound"). Models, textures and skyboxes render an inline 3D
// thumbnail right inside their card. Each asset
// section has an Import button that brings new files into the project (written
// under public/assets/ by the dev server) and reloads the catalog. Cards are
// draggable onto the viewport. Payloads: {kind:"object"|"model"|"audio"|"texture", name}.
import type { AssetCatalog } from "@slopwars/shared";
import { objectCatalog } from "@game/objects";
import { clear, el } from "./ui";
import { ThumbRenderer } from "./preview";
import { openImport, type ImportKind } from "./importer";

export interface PanelCtx {
  catalog: AssetCatalog;
  thumbs: ThumbRenderer;
  reloadCatalog: () => Promise<AssetCatalog>;
}

const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;

/** per-category glyph for object cards (markers/structures/etc. dragged in) */
const CAT_ICON: Record<string, string> = {
  geometry: "◼", marker: "⚑", sound: "♪", light: "💡", entity: "◈", structure: "▤", prop: "◆",
};

export function renderBrowser(host: HTMLElement, ctx: PanelCtx): void {
  clear(host);
  let query = "";

  const bar = el("div", "browser-bar");
  bar.append(el("span", "browser-title", "Assets"));
  const search = el("input", "browser-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search assets…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); draw(); });
  bar.append(search);

  const body = el("div", "browser-body");
  host.append(bar, body);

  const match = (s: string): boolean => !query || s.toLowerCase().includes(query);

  // a titled section with an optional Import action + a card grid
  const section = (title: string, importKind: ImportKind | null): { grid: HTMLElement; wrap: HTMLElement } => {
    const wrap = el("div", "asset-section");
    const head = el("div", "section-head");
    head.append(el("span", "section-title", title));
    if (importKind) {
      const btn = el("button", "btn mini imp-btn", "＋ Import");
      btn.title = `Import ${importKind}`;
      btn.addEventListener("click", () => openImport(importKind, () => { void reload(); }));
      head.append(btn);
    }
    const grid = el("div", "asset-grid");
    wrap.append(head, grid);
    return { grid, wrap };
  };

  const draw = (): void => {
    clear(body);

    const objs = section("Objects", null);
    for (const o of objectCatalog()) {
      if (!match(o.name)) continue;
      const c = card(o.name, CAT_ICON[o.category] ?? "◆", () => ({ kind: "object", name: o.name }));
      fillThumb(c, ctx.thumbs.objectThumb(o.name, o.category));
      objs.grid.append(c);
    }
    appendSection(body, objs, objs.grid.childElementCount);

    const models = section("Models", "model");
    for (const m of ctx.catalog.models) {
      if (!match(m.name)) continue;
      const c = card(m.name, "▣", () => ({ kind: "model", name: m.name }));
      fillThumb(c, ctx.thumbs.modelThumb(m.gltf));
      models.grid.append(c);
    }
    appendSection(body, models, models.grid.childElementCount);

    const textures = section("Textures", "texture");
    for (const t of ctx.catalog.textures) {
      if (!match(t.name)) continue;
      const c = card(t.name, "▦", () => ({ kind: "texture", name: t.name }));
      fillThumb(c, ctx.thumbs.textureThumb(t.name, t.maps));
      textures.grid.append(c);
    }
    appendSection(body, textures, textures.grid.childElementCount);

    // Skyboxes: HDRIs (drag → World › Sky › hdri). Cards preview the real sky.
    const skyboxes = section("Skyboxes", "hdri");
    for (const h of ctx.catalog.hdri) {
      if (!match(h.name)) continue;
      const c = card(h.name, "🌅", () => ({ kind: "hdri", name: h.name }));
      fillThumb(c, ctx.thumbs.hdriThumb(h.file));
      skyboxes.grid.append(c);
    }
    appendSection(body, skyboxes, skyboxes.grid.childElementCount);

    const audio = section("Audio", "audio");
    for (const a of ctx.catalog.audio) {
      if (!match(a.name)) continue;
      const c = card(a.name, "♪", () => ({ kind: "audio", name: a.name }));
      c.append(audioControls(ASSET(a.file)));
      audio.grid.append(c);
    }
    appendSection(body, audio, audio.grid.childElementCount);

    if (!body.childElementCount) body.append(el("div", "empty", "Nothing here"));
  };

  // reload the catalog (after an import) and redraw
  const reload = async (): Promise<void> => {
    try { ctx.catalog = await ctx.reloadCatalog(); } catch { /* keep old */ }
    draw();
  };

  draw();
}

/** show a section only when it has matching cards (keeps a search tidy) */
function appendSection(body: HTMLElement, s: { grid: HTMLElement; wrap: HTMLElement }, count: number): void {
  if (count > 0) body.append(s.wrap);
}

/** a draggable asset card carrying a placement payload; icon slot doubles as the
 *  thumbnail target so a rendered preview can replace the glyph in place. */
function card(name: string, icon: string, payload: () => Payload): HTMLElement {
  const c = el("div", "asset-card grab");
  const thumb = el("div", "asset-thumb"); thumb.append(el("div", "asset-icon", icon));
  c.append(thumb, el("div", "asset-name", name));
  c.draggable = true;
  c.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("application/x-slop", JSON.stringify(payload())); });
  return c;
}

/** compact Play / Stop transport for an audio clip card */
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

export interface Payload { kind: "object" | "model" | "audio" | "texture" | "hdri"; name: string }
