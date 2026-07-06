// ─── Unified asset browser (bottom dock) ─────────────────────────────────────
// One flat, searchable view of everything the pipeline discovered: placeable
// Objects, Models (drag → "prop"), Audio (drag → "sound") and Textures. Models
// and textures render an inline 3D thumbnail (turntable model / lit PBR sphere)
// right inside their card — no separate preview pane. Cards are draggable onto
// the viewport. Payloads: {kind:"object"|"model"|"audio", name}.
import type { AssetCatalog } from "@slopwars/shared";
import { objectCatalog } from "@game/objects";
import { clear, el } from "./ui";
import { ThumbRenderer } from "./preview";

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
  const search = el("input", "browser-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search assets…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); draw(); });
  bar.append(search);

  const body = el("div", "browser-body");
  const grid = el("div", "asset-grid");
  body.append(grid);
  host.append(bar, body);

  const match = (s: string): boolean => !query || s.toLowerCase().includes(query);

  const draw = (): void => {
    clear(grid);

    for (const o of objectCatalog()) {
      if (!match(o.name)) continue;
      grid.append(card(o.name, CAT_ICON[o.category] ?? "◆", () => ({ kind: "object", name: o.name })));
    }
    for (const m of ctx.catalog.models) {
      if (!match(m.name)) continue;
      const c = card(m.name, "▣", () => ({ kind: "model", name: m.name }));
      fillThumb(c, ctx.thumbs.modelThumb(m.gltf));
      grid.append(c);
    }
    for (const a of ctx.catalog.audio) {
      if (!match(a.name)) continue;
      const c = card(a.name, "♪", () => ({ kind: "audio", name: a.name }));
      const audio = el("audio"); audio.src = ASSET(a.file); audio.controls = true; audio.className = "asset-audio";
      c.append(audio);
      grid.append(c);
    }
    for (const t of ctx.catalog.textures) {
      if (!match(t.name)) continue;
      const c = el("div", "asset-card");
      const thumb = el("div", "asset-thumb"); thumb.append(el("div", "asset-icon", "▦"));
      c.append(thumb, el("div", "asset-name", t.name));
      fillThumb(c, ctx.thumbs.textureThumb(t.name, t.maps));
      grid.append(c);
    }

    if (grid.childElementCount === 0) grid.append(el("div", "empty", "Nothing here"));
  };

  draw();
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

export interface Payload { kind: "object" | "model" | "audio"; name: string }
