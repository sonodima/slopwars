// ─── Tiny DOM helpers (no framework — matches the game's vanilla approach) ────

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

/** centred modal dialog with a titled card; returns a close() fn. Click the
 *  backdrop or press Escape to dismiss. */
export function modal(title: string, body: HTMLElement): { close: () => void } {
  const back = el("div", "modal-back");
  const card = el("div", "modal-card");
  const head = el("div", "modal-head");
  head.append(el("span", "modal-title", title));
  const x = el("button", "btn mini", "✕");
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

function round(n: number): number { return Math.round(n * 1000) / 1000; }

export function toast(msg: string, error = false): void {
  const t = el("div", `toast ${error ? "err" : "ok"}`, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
}
