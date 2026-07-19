// ─── Asset store browser (left pane of the bottom dock) ──────────────────────
// Browse merged CC0 asset libraries without leaving the editor: one grid per
// asset class, results from every source rank-interleaved by the host (see
// host/store.ts — sources are pluggable adapters; Poly Haven today), each card
// carrying its source's logo (bottom-left of the thumbnail) so provenance is
// always visible. Import hands the whole download-and-wire job to the host
// (POST /__editor/store/import) — the pane only picks WHAT (asset + resolution)
// and reports progress. Cards are import-only, not draggable: an asset must
// land in the project catalog (right pane) before it can be placed in a map.
import { api, type StoreAsset, type StoreType } from "./api";
import { el, clear, toast } from "./ui";
import { icon } from "./icons";
import phLogoUrl from "./assets/polyhaven-logo.png";

export interface AssetStoreCtx {
  /** an import landed on disk → reload catalog + browser so the asset appears */
  onImported: (type: StoreType, name: string) => Promise<void>;
}

const TYPES: { t: StoreType; label: string }[] = [
  { t: "models", label: "Models" },
  { t: "textures", label: "Textures" },
  { t: "hdris", label: "HDRIs" },
];
const RES_OPTIONS = ["1k", "2k", "4k", "8k"];
// default variant per type: 1k maps are plenty for a browser FPS; skyboxes read
// noticeably better at 2k.
const RES_DEFAULT: Record<StoreType, string> = { models: "1k", textures: "1k", hdris: "2k" };
const PAGE = 80;   // cards rendered per "Show more" step (the texture list alone is thousands of assets)
const COLLAPSE_KEY = "slopedit.store.collapsed";

/** per-source badge art + link (the badge shows on every card, bottom-left).
 *  Mirrors the host's source registry — a new source adds its entry here. */
const SOURCES = {
  polyhaven: { logo: phLogoUrl, name: "Poly Haven", url: "https://polyhaven.com" },
} as const;

export function renderAssetStore(host: HTMLElement, ctx: AssetStoreCtx): void {
  clear(host);
  let active: StoreType = "models";
  let query = "";
  let shown = PAGE;
  const res: Record<StoreType, string> = { ...RES_DEFAULT };
  const lists = new Map<StoreType, StoreAsset[]>();
  const loading = new Set<StoreType>();
  const failed = new Map<StoreType, string>();
  const busy = new Set<string>();   // "source:id" keys with an import in flight

  // ── chrome: header (collapse · title · source links · resolution) + tabs + search ──
  const head = el("div", "store-bar");
  const collapse = el("button", "btn mini store-collapse");
  collapse.append(icon("chevleft"));
  collapse.title = "Collapse the asset store pane";
  const title = el("span", "store-title", "Asset Store");
  // tiny linked source logos in the header — the sources at a glance, and where
  // the per-card badges lead if you want the site itself
  const links = el("span", "store-links");
  for (const s of Object.values(SOURCES)) {
    const a = el("a") as HTMLAnchorElement;
    a.href = s.url; a.target = "_blank"; a.rel = "noreferrer"; a.title = `${s.name} — free CC0 assets`;
    const img = el("img", "store-logo") as HTMLImageElement;
    img.src = s.logo; img.alt = s.name;
    a.append(img);
    links.append(a);
  }
  const resSel = el("select", "map-picker store-res") as HTMLSelectElement;
  for (const r of RES_OPTIONS) { const o = el("option", undefined, r); o.value = r; resSel.append(o); }
  resSel.title = "Resolution variant to download";
  resSel.addEventListener("change", () => { res[active] = resSel.value; });
  head.append(collapse, title, links, resSel);

  const tabsBar = el("div", "store-bar store-tabs");
  const tabsBox = el("div", "browser-tabs");
  for (const { t, label } of TYPES) {
    const b = el("button", "browser-tab", label); b.dataset.store = t;
    b.addEventListener("click", () => { active = t; query = ""; search.value = ""; shown = PAGE; resSel.value = res[t]; syncTabs(); draw(); void ensureList(t); });
    tabsBox.append(b);
  }
  tabsBar.append(tabsBox);

  const searchBar = el("div", "store-bar");
  const search = el("input", "browser-search store-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search assets…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); shown = PAGE; draw(); });
  searchBar.append(search);

  const body = el("div", "browser-body store-body");
  const grid = el("div", "asset-grid store-grid");

  // collapsed → a slim rail (click to expand)
  const rail = el("button", "store-rail");
  rail.append(icon("chevright"), icon("download"));
  rail.title = "Asset store";

  host.append(head, tabsBar, searchBar, body, rail);
  body.append(grid);

  const setCollapsed = (on: boolean): void => {
    host.classList.toggle("collapsed", on);
    try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : ""); } catch { /* ignore */ }
  };
  collapse.addEventListener("click", () => setCollapsed(true));
  rail.addEventListener("click", () => setCollapsed(false));
  setCollapsed((() => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } })());

  const syncTabs = (): void => {
    for (const b of Array.from(tabsBox.querySelectorAll<HTMLElement>(".browser-tab"))) b.classList.toggle("on", b.dataset.store === active);
  };

  // ── listing (fetched once per type; the host caches + merges the sources) ──
  async function ensureList(t: StoreType): Promise<void> {
    if (lists.has(t) || loading.has(t)) return;
    loading.add(t); failed.delete(t); draw();
    try { lists.set(t, await api.storeList(t)); }
    catch (e) { failed.set(t, String(e)); }
    finally { loading.delete(t); draw(); }
  }

  const match = (a: StoreAsset): boolean =>
    !query || a.id.toLowerCase().includes(query) || a.name.toLowerCase().includes(query)
    || a.tags.some((s) => s.toLowerCase().includes(query)) || a.categories.some((s) => s.toLowerCase().includes(query));

  // ── import (the host downloads; the card shows a spinner meanwhile) ──
  async function doImport(a: StoreAsset): Promise<void> {
    const key = `${a.source}:${a.id}`;
    if (busy.has(key)) return;
    busy.add(key); draw();
    const type = active;
    try {
      const r = await api.storeImport({ source: a.source, type, id: a.id, res: res[type] });
      if (r.error || !r.name) { toast(`import failed: ${r.error ?? "unknown error"}`, true); return; }
      const extra = r.textures?.length ? ` + ${r.textures.length} texture set${r.textures.length === 1 ? "" : "s"}` : "";
      toast(`imported “${r.name}” (${r.res})${extra} from ${SOURCES[a.source].name}`);
      await ctx.onImported(type, r.name);
    } catch (e) { toast(`import failed: ${e}`, true); }
    finally { busy.delete(key); draw(); }
  }

  // ── grid ──
  function card(a: StoreAsset): HTMLElement {
    const c = el("div", "asset-card store-card");
    const thumb = el("div", "asset-thumb");
    const img = el("img", "thumb-img") as HTMLImageElement;
    img.src = a.thumb; img.loading = "lazy"; img.alt = a.name;
    thumb.append(img);
    // source badge, bottom-left — which library this entry comes from
    const src = el("img", "store-src") as HTMLImageElement;
    src.src = SOURCES[a.source].logo; src.alt = SOURCES[a.source].name; src.title = SOURCES[a.source].name;
    thumb.append(src);
    const btn = el("button", "btn mini store-import");
    if (busy.has(`${a.source}:${a.id}`)) { btn.append(el("span", "store-spin")); btn.disabled = true; c.classList.add("busy"); }
    else { btn.append(icon("download")); btn.title = `Import at ${res[active]}`; }
    btn.addEventListener("click", (e) => { e.stopPropagation(); void doImport(a); });
    thumb.append(btn);
    c.append(thumb, el("div", "asset-name", a.name));
    c.title = `${a.name} — ${SOURCES[a.source].name} · double-click or ⬇ to import (${res[active]})`;
    c.addEventListener("dblclick", () => void doImport(a));
    return c;
  }

  function draw(): void {
    clear(grid);
    if (loading.has(active)) { grid.append(el("div", "empty", "Loading assets…")); return; }
    const err = failed.get(active);
    if (err) {
      const box = el("div", "empty");
      box.append(el("div", undefined, "Asset sources unreachable"), el("div", "store-err", err));
      const retry = el("button", "btn mini", "Retry");
      retry.addEventListener("click", () => void ensureList(active));
      box.append(retry);
      grid.append(box);
      return;
    }
    const all = (lists.get(active) ?? []).filter(match);
    for (const a of all.slice(0, shown)) grid.append(card(a));
    if (!all.length && lists.has(active)) grid.append(el("div", "empty", query ? "No matches" : "Nothing here"));
    if (all.length > shown) {
      const more = el("button", "btn store-more", `Show more (${all.length - shown} left)`);
      more.addEventListener("click", () => { shown += PAGE; draw(); });
      grid.append(more);
    }
  }

  syncTabs();
  resSel.value = res[active];
  draw();
  void ensureList(active);
}
