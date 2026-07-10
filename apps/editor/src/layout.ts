// ─── Resizable editor panels ─────────────────────────────────────────────────
// Three draggable gutters drive CSS custom properties on :root that the grid
// layout reads: left outliner width, right inspector width, and bottom dock
// height. Sizes are clamped and persisted for the session in localStorage so a
// reload keeps your layout.
const root = document.documentElement;

interface Gutter {
  cls: string;
  varName: "--left-w" | "--right-w" | "--dock-h";
  axis: "x" | "y";
  /** map a client coordinate to a panel size in px */
  size: (clientX: number, clientY: number) => number;
  min: number; max: () => number;
}

const GUTTERS: Gutter[] = [
  { cls: "resizer-left", varName: "--left-w", axis: "x", size: (x) => x, min: 150, max: () => window.innerWidth * 0.4 },
  { cls: "resizer-right", varName: "--right-w", axis: "x", size: (x) => window.innerWidth - x, min: 180, max: () => window.innerWidth * 0.45 },
  { cls: "resizer-dock", varName: "--dock-h", axis: "y", size: (_x, y) => window.innerHeight - y, min: 120, max: () => window.innerHeight * 0.6 },
];

export function mountResizers(): void {
  restore();
  const app = document.getElementById("app");
  const main = document.getElementById("main");
  if (!app || !main) return;
  for (const g of GUTTERS) {
    const host = g.varName === "--dock-h" ? app : main;
    const h = document.createElement("div");
    h.className = `resizer ${g.cls}`;
    host.appendChild(h);
    bind(h, g);
  }
}

function bind(handle: HTMLElement, g: Gutter): void {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = g.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent): void => {
      const px = clamp(g.size(ev.clientX, ev.clientY), g.min, g.max());
      root.style.setProperty(g.varName, `${Math.round(px)}px`);
    };
    const up = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

const KEY = "slopedit.layout";
function persist(): void {
  const data: Record<string, string> = {};
  for (const g of GUTTERS) data[g.varName] = root.style.getPropertyValue(g.varName);
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ }
}
function restore(): void {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return;
    const data = JSON.parse(raw) as Record<string, string>;
    for (const g of GUTTERS) { const v = data[g.varName]; if (v) root.style.setProperty(g.varName, v); }
  } catch { /* ignore */ }
}
