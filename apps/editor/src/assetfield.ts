// ─── Asset reference field (inspector) ───────────────────────────────────────
// An Unreal-style slot for a model / texture / audio / material / hdri reference:
// shows an inline rendered preview + the asset's display name, accepts a drag from
// the asset browser, and clicking it opens a thumbnail picker. Used for object
// params like a prop's `model`, a box's `tex`, a sound's `clip`, or a map's HDRI.
//
// The VALUE the field reads/writes is the asset's stable id (what authored data
// stores), never its name — so renaming an asset never breaks the reference. The
// field resolves that id back to the asset for its name + preview; a value that
// resolves to nothing is flagged as dangling.
import type { AssetCatalog, AssetId } from "@slopwars/shared";
import { assetById } from "@slopwars/shared";
import type { ThumbRenderer } from "./preview";
import { clear, el, modal } from "./ui";
import { icon, type IconName } from "./icons";

export type AssetKind = "model" | "audio" | "texture" | "material" | "hdri";

export interface AssetFieldOpts {
  label: string;
  kind: AssetKind;
  catalog: AssetCatalog;
  thumbs: ThumbRenderer | null;
  get: () => string;
  set: (v: string) => void;
  onChange: () => void;
}

/** the catalog list for a kind (each entry carries id / slug / name / folder) */
function assets(cat: AssetCatalog, kind: AssetKind): readonly AssetId[] {
  if (kind === "model") return cat.models;
  if (kind === "audio") return cat.audio;
  if (kind === "hdri") return cat.hdri;
  if (kind === "material") return cat.materials;
  return cat.textures;
}

/** placeholder icon for an empty / loading slot of a given kind */
function kindIcon(kind: AssetKind): IconName {
  return kind === "audio" ? "volume" : kind === "texture" ? "image" : kind === "material" ? "material" : kind === "hdri" ? "mountain" : "box";
}

/** kick off the inline preview render for the asset with id `ref`, filling `slot` */
function preview(slot: HTMLElement, o: AssetFieldOpts, ref: string): void {
  clear(slot);
  const ico = (): HTMLElement => { const s = el("span", "af-ico"); s.append(icon(kindIcon(o.kind))); return s; };
  if (!ref) { slot.append(ico()); return; }
  slot.append(ico());
  const t = o.thumbs; if (!t) return;
  let p: Promise<string | null> | null = null;
  if (o.kind === "model") { const m = o.catalog.models.find((x) => x.id === ref); if (m) p = t.modelThumb(m.gltf); }
  else if (o.kind === "texture") {
    // textures show their flat bitmap, not a lit sphere — you're picking raw image data
    const tx = o.catalog.textures.find((x) => x.id === ref);
    if (tx?.maps.color) { clear(slot); const img = el("img", "af-prev"); img.src = `${import.meta.env.BASE_URL}assets/${tx.maps.color}`; slot.append(img); }
    return;
  }
  else if (o.kind === "material") { const mt = o.catalog.materials.find((x) => x.id === ref); if (mt) p = t.materialThumb(mt.id, mt.def, o.catalog); }
  else if (o.kind === "hdri") { const h = o.catalog.hdri.find((x) => x.id === ref); if (h) p = t.hdriThumb(h.file); }
  if (!p) return;
  void p.then((url) => { if (!url) return; clear(slot); const img = el("img", "af-prev"); img.src = url; slot.append(img); });
}

export function assetField(o: AssetFieldOpts): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", o.label));
  const box = el("div", "assetfield");
  const prev = el("div", "af-prevwrap");
  const nameEl = el("span", "af-name");

  const warn = el("span", "af-warn"); warn.append(icon("warn"));
  warn.title = "missing asset — falls back to a default; pick another or clear it";
  const refresh = (): void => {
    const v = o.get();
    // resolve the stored id to its asset; a reference that resolves to nothing is
    // dangling — show it flagged red. The engine + game degrade gracefully (default
    // material/texture, no model), so the map still loads.
    const asset = v ? assetById(assets(o.catalog, o.kind), v) : undefined;
    const missing = !!v && !asset;
    nameEl.textContent = asset ? asset.name : (v ? "missing" : "none");
    nameEl.classList.toggle("empty", !v);
    nameEl.classList.toggle("dangling", missing);
    box.classList.toggle("dangling", missing);
    warn.style.display = missing ? "" : "none";
    preview(prev, o, asset ? asset.id : "");
  };

  const apply = (v: string): void => { o.set(v); o.onChange(); refresh(); };

  // drag from the asset browser (payload carries the asset id)
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", () => box.classList.remove("drop"));
  box.addEventListener("drop", (e) => {
    e.preventDefault(); box.classList.remove("drop");
    const raw = e.dataTransfer?.getData("application/x-slop"); if (!raw) return;
    try {
      const p = JSON.parse(raw) as { kind: string; id?: string; name?: string };
      if (p.kind === o.kind && p.id) apply(p.id);
    } catch { /* ignore malformed */ }
  });

  // click → thumbnail picker
  box.addEventListener("click", () => openPicker(o, apply));

  const clearBtn = el("button", "btn mini"); clearBtn.append(icon("x"));
  clearBtn.title = "clear";
  clearBtn.addEventListener("click", (e) => { e.stopPropagation(); apply(""); });

  box.append(prev, nameEl, warn, clearBtn);
  row.append(box);
  refresh();
  return row;
}

/** modal grid of thumbnails for the field's kind — picking one stores its id */
function openPicker(o: AssetFieldOpts, apply: (v: string) => void): void {
  const grid = el("div", "picker-grid");
  const dlg = modal(`Pick ${o.kind}`, grid);
  const none = el("button", "picker-card", "");
  none.append(el("div", "asset-thumb", ""), el("div", "asset-name", "none"));
  none.addEventListener("click", () => { dlg.close(); apply(""); });
  grid.append(none);
  // group by folder so a large, foldered library stays navigable
  for (const a of [...assets(o.catalog, o.kind)].sort((x, y) => x.folder.localeCompare(y.folder) || x.name.localeCompare(y.name))) {
    const card = el("button", "picker-card");
    const thumb = el("div", "asset-thumb");
    const label = a.folder ? `${a.folder}/${a.name}` : a.name;
    card.append(thumb, el("div", "asset-name", label));
    preview(thumb, o, a.id);
    card.addEventListener("click", () => { dlg.close(); apply(a.id); });
    grid.append(card);
  }
}
