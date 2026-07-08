// ─── Tiny DOM helpers (no framework — matches the game's vanilla approach) ────
import { icon, type IconName } from "./icons";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function clear(node: HTMLElement): void { node.replaceChildren(); }

/** hover/scroll a numeric input to nudge its value: wheel = ±step, Shift = ×10,
 *  Alt = ×0.1. Commits through the same path a typed change would. */
function bindWheelStep(inp: HTMLInputElement, step: number, commit: (v: number) => void): void {
  inp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const cur = parseFloat(inp.value) || 0;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = round(cur + dir * step * mult);
    inp.value = String(next);
    commit(next);
  }, { passive: false });
}

/** labelled numeric field that writes `obj[key]` and fires onChange */
export function numField(label: string, get: () => number, set: (v: number) => void, onChange: () => void, step = 0.1): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", label));
  const inp = el("input", "field-input");
  inp.type = "number";
  inp.step = String(step);
  inp.value = String(round(get()));
  const apply = (v: number): void => { if (!Number.isNaN(v)) { set(v); onChange(); } };
  inp.addEventListener("change", () => apply(parseFloat(inp.value)));
  bindWheelStep(inp, step, apply);
  row.append(inp);
  return row;
}

/** N numeric inputs bound to a numeric tuple (2 or 3 components) */
export function vecField(label: string, tuple: number[], onChange: () => void, step = 0.1): HTMLElement {
  const row = el("div", "field vec3");
  row.append(el("span", "field-label", label));
  const box = el("div", "vec3-inputs");
  const names = ["x", "y", "z", "w"];
  for (let i = 0; i < tuple.length; i++) {
    const inp = el("input", "field-input");
    inp.type = "number"; inp.step = String(step); inp.value = String(round(tuple[i])); inp.title = names[i] ?? String(i);
    const apply = (v: number): void => { if (!Number.isNaN(v)) { tuple[i] = v; onChange(); } };
    inp.addEventListener("change", () => apply(parseFloat(inp.value)));
    bindWheelStep(inp, step, apply);
    box.append(inp);
  }
  row.append(box);
  return row;
}

export function selectField(label: string, options: string[], get: () => string, set: (v: string) => void, onChange: () => void): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", label));
  const sel = el("select", "field-input");
  for (const o of options) { const op = el("option", undefined, o); op.value = o; sel.append(op); }
  sel.value = get();
  sel.addEventListener("change", () => { set(sel.value); onChange(); });
  row.append(sel);
  return row;
}

export function checkField(label: string, get: () => boolean, set: (v: boolean) => void, onChange: () => void): HTMLElement {
  const row = el("label", "field check");
  const inp = el("input");
  inp.type = "checkbox"; inp.checked = get();
  inp.addEventListener("change", () => { set(inp.checked); onChange(); });
  row.append(inp, el("span", "field-label", label));
  return row;
}

/** colour swatch bound to a linear [r,g,b] (0..1) tuple via an <input type=color> */
export function colorField(label: string, tuple: number[], onChange: () => void): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", label));
  const inp = el("input", "field-color") as HTMLInputElement;
  inp.type = "color";
  inp.value = rgbToHex(tuple);
  inp.addEventListener("input", () => { const [r, g, b] = hexToRgb(inp.value); tuple[0] = r; tuple[1] = g; tuple[2] = b; onChange(); });
  row.append(inp);
  return row;
}
function clamp01(n: number): number { return n < 0 ? 0 : n > 1 ? 1 : n; }
function rgbToHex(t: number[]): string {
  const h = (n: number): string => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
  return `#${h(t[0] ?? 0)}${h(t[1] ?? 0)}${h(t[2] ?? 0)}`;
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0.6, 0.6, 0.62];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export function textField(label: string, get: () => string, set: (v: string) => void, onChange: () => void): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", label));
  const inp = el("input", "field-input");
  inp.type = "text"; inp.value = get();
  inp.addEventListener("change", () => { set(inp.value); onChange(); });
  row.append(inp);
  return row;
}

/** make a label element rename-on-double-click: swaps in a text input, commits
 *  on Enter/blur (onChange re-renders and discards it) or restores on Escape. */
export function renamable(span: HTMLElement, get: () => string, set: (v: string) => void, onChange: () => void): void {
  span.title = "double-click to rename";
  span.addEventListener("dblclick", (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    const inp = el("input", "rename-input");
    inp.type = "text"; inp.value = get();
    span.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = (save: boolean): void => {
      if (done) return; done = true;
      if (save) { set(inp.value.trim()); onChange(); }   // onChange re-renders → discards inp
      else inp.replaceWith(span);                          // cancel → restore label
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    inp.addEventListener("blur", () => commit(true));
  });
}

export function button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `btn ${cls}`.trim(), label);
  b.addEventListener("click", onClick);
  return b;
}

/** a button with a leading icon + label (label optional for icon-only buttons) */
export function iconButton(ic: IconName, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `btn ${cls}`.trim());
  b.append(icon(ic));
  if (label) b.append(el("span", "btn-label", label));
  b.addEventListener("click", onClick);
  return b;
}

// ── context menu (Unity-style right-click actions) ──────────────────────────
/** one entry in a context menu: an action, or a divider (`{ sep: true }`) */
export type MenuItem =
  | { sep: true }
  | { label: string; icon?: IconName; danger?: boolean; disabled?: boolean; onClick: () => void };

let openMenu: HTMLElement | null = null;
/** close whatever context menu is open (also called globally on click/scroll/esc) */
export function closeContextMenu(): void {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

/** pop a context menu at client coordinates (clamped to the viewport). Dismisses on
 *  outside click, scroll, resize, Escape, or after any item fires. Pass this an
 *  event's clientX/clientY (right-click handlers should preventDefault first). */
export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const menu = el("div", "ctx-menu");
  for (const it of items) {
    if ("sep" in it) { menu.append(el("div", "ctx-sep")); continue; }
    const row = el("button", "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""));
    if (it.icon) row.append(icon(it.icon, "ctx-ico")); else row.append(el("span", "ctx-ico"));
    row.append(el("span", "ctx-label", it.label));
    if (!it.disabled) row.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); it.onClick(); });
    menu.append(row);
  }
  menu.style.visibility = "hidden";
  document.body.append(menu);
  // clamp so the menu never spills off-screen
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 6);
  const py = Math.min(y, window.innerHeight - r.height - 6);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
  menu.style.visibility = "";
  openMenu = menu;
}

// global dismissers (registered once)
window.addEventListener("pointerdown", (e) => { if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu(); }, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
window.addEventListener("resize", closeContextMenu);
window.addEventListener("wheel", () => closeContextMenu(), true);

/** centred modal dialog with a titled card; returns a close() fn. Click the
 *  backdrop or press Escape to dismiss. */
export function modal(title: string, body: HTMLElement): { close: () => void } {
  const back = el("div", "modal-back");
  const card = el("div", "modal-card");
  const head = el("div", "modal-head");
  head.append(el("span", "modal-title", title));
  const x = el("button", "btn mini");
  x.append(icon("x"));
  head.append(x);
  card.append(head, body);
  back.append(card);
  document.body.append(back);
  const close = (): void => { back.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  x.addEventListener("click", close);
  window.addEventListener("keydown", onKey);
  return { close };
}

/** a three-way "unsaved changes" dialog. Resolves "save" | "discard" | "cancel"
 *  (the modal's Escape / backdrop dismissal counts as cancel). */
export function confirmUnsaved(what: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const body = el("div", "confirm");
    body.append(el("p", "confirm-msg", `${what} has unsaved changes.`));
    const row = el("div", "confirm-actions");
    let done = false;
    const finish = (r: "save" | "discard" | "cancel"): void => { if (done) return; done = true; dlg.close(); resolve(r); };
    const dlg = modal("Unsaved changes", body);
    row.append(
      button("Cancel", () => finish("cancel")),
      button("Discard", () => finish("discard"), "danger"),
      button("Save", () => finish("save"), "primary"),
    );
    body.append(row);
    // modal() already closes on Escape/backdrop; poll for that to resolve as cancel
    const iv = window.setInterval(() => { if (!document.body.contains(body)) { window.clearInterval(iv); finish("cancel"); } }, 150);
  });
}

/** a confirm dialog for an irreversible action; runs `onYes` only if confirmed. */
export function confirmDelete(what: string, onYes: () => void): void {
  const body = el("div", "confirm");
  body.append(el("p", "confirm-msg", `Delete ${what}? This cannot be undone.`));
  const row = el("div", "confirm-actions");
  const dlg = modal("Confirm delete", body);
  row.append(
    button("Cancel", () => dlg.close()),
    button("Delete", () => { dlg.close(); onYes(); }, "danger"),
  );
  body.append(row);
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

export function toast(msg: string, error = false): void {
  const t = el("div", `toast ${error ? "err" : "ok"}`, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
}
