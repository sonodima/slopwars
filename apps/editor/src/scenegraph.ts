// ─── Scene graph: hierarchical list of everything placed in the current map ──
import { state, SelKind } from "./state";
import { clear, el } from "./ui";

export function renderSceneGraph(host: HTMLElement): void {
  clear(host);
  const map = state.map;
  if (!map) { host.append(el("div", "empty", "No map loaded")); return; }

  host.append(row("Environment", "env", 0, () => "Sky / lighting / textures"));

  section(host, `Brushes (${map.brushes.length})`, () => {
    map.brushes.forEach((b, i) => host.append(row(brushLabel(b, i), "brush", i, () => b.k)));
  });
  section(host, `Objects (${map.objects.length})`, () => {
    map.objects.forEach((o, i) => host.append(row(`${o.type}`, "object", i, () => `${o.at.map(fmt).join(", ")}`)));
  });
  section(host, `Spawns (${map.spawns.length})`, () => {
    map.spawns.forEach((s, i) => host.append(row(`spawn ${i}`, "spawn", i, () => `${s.at[0]}, ${s.at[1]} · ${s.yaw}°`)));
  });
  section(host, `Pickups (${map.pickups.length})`, () => {
    map.pickups.forEach((_p, i) => host.append(row(`pickup ${i}`, "pickup", i, () => "")));
  });
  section(host, `Power-ups (${map.powerups.length})`, () => {
    map.powerups.forEach((_p, i) => host.append(row(`powerup ${i}`, "powerup", i, () => "")));
  });
}

function section(host: HTMLElement, title: string, fill: () => void): void {
  host.append(el("div", "sg-section", title));
  fill();
}

function row(label: string, kind: SelKind, index: number, sub: () => string): HTMLElement {
  const r = el("div", "sg-row");
  if (state.sel.kind === kind && state.sel.index === index) r.classList.add("sel");
  r.append(el("span", "sg-label", label));
  const s = sub(); if (s) r.append(el("span", "sg-sub", s));
  r.addEventListener("click", () => state.select(kind, index));
  // delete button for removable items
  if (kind !== "env" && kind !== "none") {
    const del = el("button", "btn mini", "✕");
    del.addEventListener("click", (ev) => { ev.stopPropagation(); removeItem(kind, index); });
    r.append(del);
  }
  return r;
}

function removeItem(kind: SelKind, index: number): void {
  const map = state.map; if (!map) return;
  const arr = ({ brush: map.brushes, object: map.objects, spawn: map.spawns, pickup: map.pickups, powerup: map.powerups } as Record<string, unknown[]>)[kind];
  if (!arr) return;
  arr.splice(index, 1);
  if (state.sel.kind === kind && state.sel.index === index) state.select("none", -1);
  state.touch();
}

function brushLabel(b: { k: string }, i: number): string { return `${b.k} ${i}`; }
function fmt(n: number): string { return String(Math.round(n * 10) / 10); }
