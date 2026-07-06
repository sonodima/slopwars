// ─── Scene outliner: one flat, searchable list of every placed object ────────
// Selection is by reference (see state.ts), so highlighting always tracks the
// real selected object — no index drift when things are added/removed. The
// search bar is built once and the list re-renders on any change/selection so
// typing keeps its focus.
import { state } from "./state";
import { clear, el } from "./ui";

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

  const selIdx = state.selIndex;
  let shown = 0;
  map.objects.forEach((o, i) => {
    const text = label(o.type, o.params);
    if (query && !text.toLowerCase().includes(query)) return;
    host.append(row(i, text, i === selIdx));
    shown++;
  });
  if (shown === 0) host.append(el("div", "empty", query ? "No matches" : "No objects"));
}

function row(i: number, text: string, selected: boolean): HTMLElement {
  const r = el("div", "sg-row");
  if (selected) r.classList.add("sel");
  r.append(el("span", "sg-label", text));
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

function label(type: string, params?: Record<string, unknown>): string {
  if (type === "prop" && params?.model) return `prop · ${params.model}`;
  if (type === "sound" && params?.clip) return `sound · ${params.clip}`;
  return type;
}

/** kept as an alias so external callers referencing the old name still work */
export const renderSceneGraph = (): void => renderList();
