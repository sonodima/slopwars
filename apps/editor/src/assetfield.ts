// ─── Asset reference field (inspector) ───────────────────────────────────────
// An Unreal-style slot for a model / texture / audio reference: shows an inline
// rendered preview + the asset name, accepts a drag from the asset browser, and
// clicking it opens a thumbnail picker. Used for object params like a prop's
// `model`, a box's `tex`, or a sound's `clip`.
import type { AssetCatalog } from "@slopwars/shared";
import type { ThumbRenderer } from "./preview";
import { clear, el, modal } from "./ui";

export type AssetKind = "model" | "audio" | "texture" | "hdri";

export interface AssetFieldOpts {
  label: string;
  kind: AssetKind;
  catalog: AssetCatalog;
  thumbs: ThumbRenderer | null;
  get: () => string;
  set: (v: string) => void;
  onChange: () => void;
}

/** names available for a kind, for the picker + drop validation */
function names(cat: AssetCatalog, kind: AssetKind): string[] {
  if (kind === "model") return cat.models.map((m) => m.name);
  if (kind === "audio") return cat.audio.map((a) => a.name);
  if (kind === "hdri") return cat.hdri.map((h) => h.name);
  return cat.textures.map((t) => t.name);
}

/** placeholder glyph for an empty / loading slot of a given kind */
function kindIcon(kind: AssetKind): string {
  return kind === "audio" ? "♪" : kind === "texture" ? "▦" : kind === "hdri" ? "🌅" : "▣";
}

/** kick off the inline preview render for `name`, filling `slot` when ready */
function preview(slot: HTMLElement, o: AssetFieldOpts, name: string): void {
  clear(slot);
  if (!name) { slot.append(el("span", "af-ico", kindIcon(o.kind))); return; }
  slot.append(el("span", "af-ico", o.kind === "audio" ? "♪" : "…"));
  const t = o.thumbs; if (!t) return;
  let p: Promise<string | null> | null = null;
  if (o.kind === "model") { const m = o.catalog.models.find((x) => x.name === name); if (m) p = t.modelThumb(m.gltf); }
  else if (o.kind === "texture") { const tx = o.catalog.textures.find((x) => x.name === name); if (tx) p = t.textureThumb(tx.name, tx.maps); }
  else if (o.kind === "hdri") { const h = o.catalog.hdri.find((x) => x.name === name); if (h) p = t.hdriThumb(h.file); }
  if (!p) return;
  void p.then((url) => { if (!url) return; clear(slot); const img = el("img", "af-prev"); img.src = url; slot.append(img); });
}

export function assetField(o: AssetFieldOpts): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", o.label));
  const box = el("div", "assetfield");
  const prev = el("div", "af-prevwrap");
  const nameEl = el("span", "af-name");

  const refresh = (): void => {
    const v = o.get();
    nameEl.textContent = v || "none";
    nameEl.classList.toggle("empty", !v);
    preview(prev, o, v);
  };

  const apply = (v: string): void => { o.set(v); o.onChange(); refresh(); };

  // drag from the asset browser
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", () => box.classList.remove("drop"));
  box.addEventListener("drop", (e) => {
    e.preventDefault(); box.classList.remove("drop");
    const raw = e.dataTransfer?.getData("application/x-slop"); if (!raw) return;
    try {
      const p = JSON.parse(raw) as { kind: string; name: string };
      if (p.kind === o.kind && p.name) apply(p.name);
    } catch { /* ignore malformed */ }
  });

  // click → thumbnail picker
  box.addEventListener("click", () => openPicker(o, apply));

  const clearBtn = el("button", "btn mini", "✕");
  clearBtn.title = "clear";
  clearBtn.addEventListener("click", (e) => { e.stopPropagation(); apply(""); });

  box.append(prev, nameEl, clearBtn);
  row.append(box);
  refresh();
  return row;
}

/** modal grid of thumbnails for the field's kind */
function openPicker(o: AssetFieldOpts, apply: (v: string) => void): void {
  const grid = el("div", "picker-grid");
  const dlg = modal(`Pick ${o.kind}`, grid);
  const none = el("button", "picker-card", "");
  none.append(el("div", "asset-thumb", ""), el("div", "asset-name", "none"));
  none.addEventListener("click", () => { dlg.close(); apply(""); });
  grid.append(none);
  for (const name of names(o.catalog, o.kind)) {
    const card = el("button", "picker-card");
    const thumb = el("div", "asset-thumb");
    card.append(thumb, el("div", "asset-name", name));
    preview(thumb, o, name);
    card.addEventListener("click", () => { dlg.close(); apply(name); });
    grid.append(card);
  }
}
