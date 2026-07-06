// ─── Scene outliner: one flat, searchable list of every placed object ────────
// Selection is by reference (see state.ts), so highlighting always tracks the
// real selected object — no index drift when things are added/removed. The
// search bar is built once and the list re-renders on any change/selection so
// typing keeps its focus.
import type { Placement } from "@slopwars/shared";
import { state } from "./state";
import { clear, el, renamable } from "./ui";

let query = "";
let listHost: HTMLElement | null = null;

export function mountSceneGraph(host: HTMLElement): void {
  clear(host);
  const bar = el("div", "sg-search-bar");
  const search = el("input", "sg-search") as HTMLInputElement;
  search.type = "search"; search.placeholder = "Search objects…";
  search.addEventListener("input", () => { query = search.value.toLowerCase(); renderList(); });
  bar.append(search);

  const list = el("div", "sg-list");
  listHost = list;
  host.append(bar, list);

  state.onChange(renderList);
  state.onSelect(renderList);
  renderList();
}

function renderList(): void {
  const host = listHost;
  if (!host) return;
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }

  // "World" is always first: selecting it (= no object selected) shows the map's
  // sky / lighting / effects in the inspector.
  const world = el("div", "sg-row sg-world");
  if (state.selIndex < 0) world.classList.add("sel");
  world.append(el("span", "sg-ico", "🌍"), el("span", "sg-label", "World"));
  world.addEventListener("click", () => state.select(-1));
  host.append(world);

  const selIdx = state.selIndex;
  let shown = 0;
  map.objects.forEach((o, i) => {
    const text = label(o);
    if (query && !text.toLowerCase().includes(query)) return;
    host.append(row(o, i, text, i === selIdx));
    shown++;
  });
  if (shown === 0) host.append(el("div", "empty", query ? "No matches" : "No objects"));
}

function row(o: Placement, i: number, text: string, selected: boolean): HTMLElement {
  const r = el("div", "sg-row");
  if (selected) r.classList.add("sel");
  const lbl = el("span", "sg-label", text);
  renamable(lbl, () => o.name ?? "", (v) => { o.name = v || undefined; }, () => { state.select(i); state.commit(true); });
  r.append(lbl);
  r.addEventListener("click", () => state.select(i));

  const dup = el("button", "btn mini", "⧉");
  dup.title = "duplicate";
  dup.addEventListener("click", (ev) => { ev.stopPropagation(); state.duplicate(i); });
  const del = el("button", "btn mini", "✕");
  del.title = "delete";
  del.addEventListener("click", (ev) => { ev.stopPropagation(); state.remove(i); });
  r.append(dup, del);
  return r;
}

function label(o: Placement): string {
  if (o.name) return o.name;
  if (o.type === "prop" && o.params?.model) return `prop · ${o.params.model}`;
  if (o.type === "sound" && o.params?.clip) return `sound · ${o.params.clip}`;
  return o.type;
}

/** kept as an alias so external callers referencing the old name still work */
export const renderSceneGraph = (): void => renderList();
