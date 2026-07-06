// ─── Unified asset browser (bottom dock) ─────────────────────────────────────
// One browser for everything the pipeline discovered: placeable Objects, Models
// (drag → creates a "prop"), Audio (drag → creates a "sound"), Textures, and
// Materials (create/delete). Items are draggable onto the viewport; a model
// turntable preview sits on the left. Payloads: {kind:"object"|"model"|"audio", name}.
import type { AssetCatalog, MaterialDef } from "@slopwars/shared";
import { objectCatalog } from "@game/objects";
import { clear, el, button, toast } from "./ui";
import { api } from "./api";
import { ModelPreview } from "./preview";

export interface PanelCtx {
  catalog: AssetCatalog;
  preview: ModelPreview;
  reloadCatalog: () => Promise<AssetCatalog>;
}

const CATS = ["All", "Objects", "Models", "Audio", "Textures", "Materials"] as const;
type Cat = typeof CATS[number];
const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;

export function renderBrowser(host: HTMLElement, ctx: PanelCtx): void {
  clear(host);
  let cat: Cat = "All";
  let query = "";

  const bar = el("div", "browser-bar");
  const chips = el("div", "chips");
  const search = el("input", "browser-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search assets…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); draw(); });
  bar.append(chips, search);

  const body = el("div", "browser-body");
  const grid = el("div", "asset-grid");
  body.append(grid);
  host.append(bar, body);

  const drawChips = (): void => {
    clear(chips);
    for (const c of CATS) {
      const b = el("button", `chip ${c === cat ? "on" : ""}`, c);
      b.addEventListener("click", () => { cat = c; drawChips(); draw(); });
      chips.append(b);
    }
  };

  const match = (s: string): boolean => !query || s.toLowerCase().includes(query);

  const draw = (): void => {
    clear(grid);
    for (const f of Array.from(host.querySelectorAll(".mat-form"))) f.remove();
    if (cat === "Materials") return materials(grid, ctx, () => draw());
    const show = (c: Cat): boolean => cat === "All" || cat === c;

    if (show("Objects")) for (const o of objectCatalog()) {
      if (o.category === "marker") continue; // markers added from the toolbar
      if (!match(o.name)) continue;
      grid.append(card(o.name, "◆", () => ({ kind: "object", name: o.name })));
    }
    if (show("Models")) for (const m of ctx.catalog.models) {
      if (!match(m.name)) continue;
      const c = card(m.name, "▣", () => ({ kind: "model", name: m.name }));
      c.addEventListener("mouseenter", () => ctx.preview.show(m.gltf));
      grid.append(c);
    }
    if (show("Audio")) for (const a of ctx.catalog.audio) {
      if (!match(a.name)) continue;
      const c = card(a.name, "♪", () => ({ kind: "audio", name: a.name }));
      const audio = el("audio"); audio.src = ASSET(a.file); audio.controls = true; audio.className = "asset-audio";
      c.append(audio);
      grid.append(c);
    }
    if (show("Textures")) for (const t of ctx.catalog.textures) {
      if (!match(t.name)) continue;
      const c = el("div", "asset-card");
      if (t.maps.color) { const img = el("img", "asset-thumb"); img.src = ASSET(t.maps.color); img.loading = "lazy"; c.append(img); }
      else c.append(el("div", "asset-icon", "▦"));
      c.append(el("div", "asset-name", t.name));
      grid.append(c);
    }
    if (grid.childElementCount === 0) grid.append(el("div", "empty", "Nothing here"));
  };

  drawChips();
  draw();
}

/** a draggable asset card carrying a placement payload */
function card(name: string, icon: string, payload: () => Payload): HTMLElement {
  const c = el("div", "asset-card grab");
  c.append(el("div", "asset-icon", icon), el("div", "asset-name", name));
  c.draggable = true;
  c.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("application/x-slop", JSON.stringify(payload())); });
  return c;
}

export interface Payload { kind: "object" | "model" | "audio"; name: string }

function materials(grid: HTMLElement, ctx: PanelCtx, redraw: () => void): void {
  const form = el("div", "mat-form");
  const nameIn = el("input", "field-input") as HTMLInputElement; nameIn.placeholder = "material name";
  const texSel = el("select", "field-input") as HTMLSelectElement;
  texSel.append(el("option", undefined, "(texture set)"));
  for (const t of ctx.catalog.textures) { const o = el("option", undefined, t.name); o.value = t.name; texSel.append(o); }
  const rough = el("input", "field-input") as HTMLInputElement; rough.type = "number"; rough.step = "0.05"; rough.value = "0.7"; rough.title = "roughness";
  const metal = el("input", "field-input") as HTMLInputElement; metal.type = "number"; metal.step = "0.05"; metal.value = "0"; metal.title = "metallic";
  const create = button("Create", async () => {
    const name = nameIn.value.trim();
    if (!name) { toast("name required", true); return; }
    const def: MaterialDef = { texture: texSel.value || undefined, roughness: parseFloat(rough.value), metallic: parseFloat(metal.value) };
    try { await api.saveMaterial(name, def); await ctx.reloadCatalog(); toast(`saved ${name}`); redraw(); }
    catch (e) { toast(String(e), true); }
  }, "primary");
  form.append(nameIn, texSel, rough, metal, create);
  grid.parentElement!.insertBefore(form, grid);

  if (ctx.catalog.materials.length === 0) grid.append(el("div", "empty", "No materials yet"));
  for (const m of ctx.catalog.materials) {
    const c = el("div", "asset-card");
    c.append(el("div", "asset-icon", "●"), el("div", "asset-name", m.name));
    const del = el("button", "btn mini", "✕");
    del.addEventListener("click", async () => { try { await api.deleteMaterial(m.name); await ctx.reloadCatalog(); redraw(); } catch (e) { toast(String(e), true); } });
    c.append(del);
    grid.append(c);
  }
}
