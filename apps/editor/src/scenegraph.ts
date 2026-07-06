// ─── Scene graph: the flat object list, grouped by category ──────────────────
import { objectCategory, ObjCategory } from "@game/objects";
import { state } from "./state";
import { clear, el } from "./ui";

const ORDER: ObjCategory[] = ["geometry", "structure", "prop", "entity", "light", "marker", "sound"];

export function renderSceneGraph(host: HTMLElement): void {
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }

  // bucket object indices by category
  const buckets = new Map<string, number[]>();
  map.objects.forEach((o, i) => {
    const cat = objectCategory(o.type) ?? "prop";
    (buckets.get(cat) ?? buckets.set(cat, []).get(cat)!).push(i);
  });

  const cats = [...new Set([...ORDER, ...buckets.keys()])].filter((c) => buckets.has(c));
  for (const cat of cats) {
    const idxs = buckets.get(cat)!;
    host.append(el("div", "sg-section", `${cat} (${idxs.length})`));
    for (const i of idxs) host.append(row(i));
  }
}

function row(i: number): HTMLElement {
  const o = state.map!.objects[i];
  const r = el("div", "sg-row");
  if (state.sel.index === i) r.classList.add("sel");
  r.append(el("span", "sg-label", label(o.type, o.params)));
  r.append(el("span", "sg-sub", o.at.map((n) => Math.round(n * 10) / 10).join(", ")));
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
