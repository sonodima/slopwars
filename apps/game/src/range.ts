// ─── Range slider fill ───────────────────────────────────────────────────────
// The holo rail lights up the travelled portion of the track, which CSS can't derive
// from an <input type=range> on its own (Firefox has ::-moz-range-progress, WebKit has
// nothing). Each .rng carries a --p custom property with its filled fraction; the CSS
// paints the fill from it.
//
// Live drags are caught by one delegated listener. Programmatic writes (settings /
// lobby rules re-render by assigning .value, which fires no event) call syncRanges.

/** filled fraction of a range input, as a 0–100 % string */
function fill(el: HTMLInputElement): string {
  const min = parseFloat(el.min || "0");
  const max = parseFloat(el.max || "100");
  const v = parseFloat(el.value);
  if (!isFinite(min) || !isFinite(max) || !isFinite(v) || max <= min) return "0%";
  const p = ((v - min) / (max - min)) * 100;
  return `${Math.max(0, Math.min(100, p)).toFixed(2)}%`;
}

/** paints one slider's fill */
export function syncRange(el: HTMLInputElement): void {
  el.style.setProperty("--p", fill(el));
}

/** paints every slider under `root` — call after any render that assigns .value */
export function syncRanges(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLInputElement>("input.rng")) syncRange(el);
}

// one delegated listener covers every slider, including ones added later (the lobby
// rules grid rebuilds its inputs on each render)
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.classList.contains("rng")) syncRange(t);
}, true);
