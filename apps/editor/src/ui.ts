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

/** labelled numeric field that writes `obj[key]` and fires onChange */
export function numField(label: string, get: () => number, set: (v: number) => void, onChange: () => void, step = 0.1): HTMLElement {
  const row = el("label", "field");
  row.append(el("span", "field-label", label));
  const inp = el("input", "field-input");
  inp.type = "number";
  inp.step = String(step);
  inp.value = String(round(get()));
  inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) { set(v); onChange(); } });
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
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) { tuple[i] = v; onChange(); } });
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

export function button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `btn ${cls}`.trim(), label);
  b.addEventListener("click", onClick);
  return b;
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

export function toast(msg: string, error = false): void {
  const t = el("div", `toast ${error ? "err" : "ok"}`, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
}
