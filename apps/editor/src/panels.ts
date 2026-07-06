// ─── Asset panels (bottom dock): Models · Textures · Materials · Audio · Objects
// A file-driven browser over the scanned catalog. Objects place into the map;
// Materials create/delete JSON files via the dev API. Everything here is sourced
// from the pipeline — add an asset folder and it shows up on reload.
import type { AssetCatalog, MaterialDef } from "@slopwars/shared";
import { objectTypeNames } from "@game/objects";
import { clear, el, button, toast } from "./ui";
import { api } from "./api";

export interface PanelCtx {
  catalog: AssetCatalog;
  placeObject: (type: string) => void;
  reloadCatalog: () => Promise<AssetCatalog>;
}

const TABS = ["Objects", "Models", "Textures", "Materials", "Audio"] as const;
type Tab = typeof TABS[number];

const ASSET = (p: string): string => `${import.meta.env.BASE_URL}assets/${p}`;

export function renderPanels(tabsHost: HTMLElement, bodyHost: HTMLElement, ctx: PanelCtx): void {
  let active: Tab = "Objects";
  const draw = (): void => {
    clear(tabsHost);
    for (const t of TABS) {
      const b = el("button", `tab ${t === active ? "on" : ""}`, t);
      b.addEventListener("click", () => { active = t; draw(); });
      tabsHost.append(b);
    }
    clear(bodyHost);
    if (active === "Objects") objectsPanel(bodyHost, ctx);
    else if (active === "Models") modelsPanel(bodyHost, ctx);
    else if (active === "Textures") texturesPanel(bodyHost, ctx);
    else if (active === "Materials") materialsPanel(bodyHost, ctx, draw);
    else if (active === "Audio") audioPanel(bodyHost, ctx);
  };
  draw();
}

function grid(host: HTMLElement): HTMLElement { const g = el("div", "asset-grid"); host.append(g); return g; }

function objectsPanel(host: HTMLElement, ctx: PanelCtx): void {
  host.append(el("p", "panel-hint", "Click to place an entity at the origin, then position it in the inspector."));
  const g = grid(host);
  for (const name of objectTypeNames()) {
    const card = el("div", "asset-card obj");
    card.append(el("div", "asset-icon", "◆"));
    card.append(el("div", "asset-name", name));
    card.addEventListener("click", () => ctx.placeObject(name));
    g.append(card);
  }
}

function modelsPanel(host: HTMLElement, ctx: PanelCtx): void {
  host.append(el("p", "panel-hint", `${ctx.catalog.models.length} models discovered in public/assets/models/.`));
  const g = grid(host);
  for (const m of ctx.catalog.models) {
    const card = el("div", "asset-card");
    card.append(el("div", "asset-icon", "▣"));
    card.append(el("div", "asset-name", m.name));
    card.title = m.gltf;
    g.append(card);
  }
}

function texturesPanel(host: HTMLElement, ctx: PanelCtx): void {
  host.append(el("p", "panel-hint", "PBR texture sets. Bind a folder to a material slot in the Environment inspector."));
  const g = grid(host);
  for (const t of ctx.catalog.textures) {
    const card = el("div", "asset-card");
    if (t.maps.color) {
      const img = el("img", "asset-thumb");
      img.src = ASSET(t.maps.color); img.loading = "lazy";
      card.append(img);
    } else {
      card.append(el("div", "asset-icon", "▦"));
    }
    card.append(el("div", "asset-name", t.name));
    card.title = Object.keys(t.maps).join(", ");
    g.append(card);
  }
}

function audioPanel(host: HTMLElement, ctx: PanelCtx): void {
  host.append(el("p", "panel-hint", `${ctx.catalog.audio.length} audio clips.`));
  const g = grid(host);
  for (const a of ctx.catalog.audio) {
    const card = el("div", "asset-card");
    card.append(el("div", "asset-icon", "♪"));
    card.append(el("div", "asset-name", a.name));
    const play = el("audio"); play.src = ASSET(a.file); play.controls = true; play.className = "asset-audio";
    card.append(play);
    g.append(card);
  }
}

function materialsPanel(host: HTMLElement, ctx: PanelCtx, redraw: () => void): void {
  host.append(el("p", "panel-hint", "Reusable materials → public/assets/materials/<name>.json"));

  // create form
  const form = el("div", "mat-form");
  const nameIn = el("input", "field-input"); nameIn.placeholder = "material name";
  const texSel = el("select", "field-input");
  texSel.append(el("option", undefined, "(texture set)"));
  for (const t of ctx.catalog.textures) { const o = el("option", undefined, t.name); o.value = t.name; texSel.append(o); }
  const rough = el("input", "field-input"); rough.type = "number"; rough.step = "0.05"; rough.value = "0.7"; rough.title = "roughness";
  const metal = el("input", "field-input"); metal.type = "number"; metal.step = "0.05"; metal.value = "0"; metal.title = "metallic";
  const create = button("Create", async () => {
    const name = nameIn.value.trim();
    if (!name) { toast("name required", true); return; }
    const def: MaterialDef = { texture: texSel.value || undefined, roughness: parseFloat(rough.value), metallic: parseFloat(metal.value) };
    try { await api.saveMaterial(name, def); await ctx.reloadCatalog(); toast(`saved ${name}`); redraw(); }
    catch (e) { toast(String(e), true); }
  }, "primary");
  form.append(nameIn, texSel, rough, metal, create);
  host.append(form);

  const g = grid(host);
  if (ctx.catalog.materials.length === 0) g.append(el("div", "empty", "No materials yet"));
  for (const m of ctx.catalog.materials) {
    const card = el("div", "asset-card");
    card.append(el("div", "asset-icon", "●"));
    card.append(el("div", "asset-name", m.name));
    const del = el("button", "btn mini", "✕");
    del.addEventListener("click", async () => {
      try { await api.deleteMaterial(m.name); await ctx.reloadCatalog(); toast(`deleted ${m.name}`); redraw(); }
      catch (e) { toast(String(e), true); }
    });
    card.append(del);
    g.append(card);
  }
}
