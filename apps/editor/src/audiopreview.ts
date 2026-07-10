// ─── Compact audio preview: waveform + centre play/stop + scrubbing ──────────
// A self-contained audio preview tile (sized like a texture thumbnail). It draws
// the whole clip's waveform, overlays a single centre button that toggles between
// play and stop, highlights the played portion as it advances, and exposes a thin
// scrub line beneath for seeking. Waveform peaks are decoded once per source and
// cached; decoding is deferred until the tile scrolls into view so opening the
// Audio browser tab never decodes every clip up front.
import { el } from "./ui";
import { icon } from "./icons";

/** buckets across the waveform (kept modest — a compact tile can't show more) */
const BUCKETS = 96;

/** decoded, normalised peak amplitudes per source (shared across every tile) */
const peaksCache = new Map<string, Promise<Float32Array>>();
let audioCtx: AudioContext | null = null;

/** decode a clip and reduce it to `BUCKETS` normalised peak amplitudes (0..1) */
function loadPeaks(src: string): Promise<Float32Array> {
  let p = peaksCache.get(src);
  if (p) return p;
  p = (async () => {
    const raw = await fetch(src).then((r) => r.arrayBuffer());
    audioCtx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const buf = await audioCtx.decodeAudioData(raw);
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / BUCKETS));
    const peaks = new Float32Array(BUCKETS);
    let peak = 0;
    for (let i = 0; i < BUCKETS; i++) {
      let max = 0;
      const start = i * step;
      for (let j = 0; j < step && start + j < ch.length; j++) {
        const v = Math.abs(ch[start + j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
      if (max > peak) peak = max;
    }
    if (peak > 0) for (let i = 0; i < BUCKETS; i++) peaks[i] /= peak;   // normalise to fill the tile
    return peaks;
  })();
  peaksCache.set(src, p);
  return p;
}

/** a compact audio preview tile for `src`. Fills its parent (use inside a square
 *  thumbnail slot). Interaction is contained to the button + scrub line so the tile
 *  can still live inside a draggable asset card. */
export function audioPreview(src: string): HTMLElement {
  const wrap = el("div", "audio-prev");
  const canvas = document.createElement("canvas");
  canvas.className = "audio-wave";
  const btn = el("button", "audio-play"); btn.append(icon("play")); btn.title = "play / stop";
  const scrub = el("div", "audio-scrub");
  const pos = el("div", "audio-pos");
  scrub.append(pos);
  wrap.append(canvas, btn, scrub);

  const audio = new Audio(src);
  audio.preload = "none";
  let peaks: Float32Array | null = null;

  const draw = (): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!peaks) return;
    const prog = audio.duration ? audio.currentTime / audio.duration : 0;
    const bw = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const bh = Math.max(1, peaks[i] * h * 0.84);
      const played = (i + 0.5) / peaks.length <= prog;
      ctx.fillStyle = played ? "rgba(230,178,86,0.92)" : "rgba(198,208,220,0.26)";
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
    }
  };

  const fit = (): void => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nw = Math.max(1, Math.round(r.width * dpr)), nh = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== nw || canvas.height !== nh) { canvas.width = nw; canvas.height = nh; }
    draw();
  };

  // decode only once the tile is actually on screen (opening the Audio tab shouldn't
  // decode every clip); fall back to an eager decode where IntersectionObserver is absent.
  const startDecode = (): void => { void loadPeaks(src).then((p) => { peaks = p; fit(); }).catch(() => { /* undecodable clip → empty waveform */ }); };
  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); startDecode(); }
    });
    io.observe(wrap);
  } else startDecode();
  requestAnimationFrame(fit);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(wrap);

  const setIcon = (playing: boolean): void => { btn.replaceChildren(icon(playing ? "stop" : "play")); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (audio.paused) void audio.play().catch(() => { /* needs a user gesture — this click is one */ });
    else audio.pause();
  });

  let raf = 0;
  const tick = (): void => {
    if (audio.paused) return;
    pos.style.left = `${(audio.duration ? audio.currentTime / audio.duration : 0) * 100}%`;
    draw();
    raf = requestAnimationFrame(tick);
  };
  audio.addEventListener("play", () => { setIcon(true); wrap.classList.add("playing"); cancelAnimationFrame(raf); tick(); });
  audio.addEventListener("pause", () => { setIcon(false); wrap.classList.remove("playing"); cancelAnimationFrame(raf); });
  audio.addEventListener("ended", () => { setIcon(false); wrap.classList.remove("playing"); cancelAnimationFrame(raf); pos.style.left = "0%"; draw(); });

  // scrub: click / drag the thin track to seek
  const seekTo = (clientX: number): void => {
    const r = scrub.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    pos.style.left = `${f * 100}%`;
    if (audio.duration) { audio.currentTime = f * audio.duration; draw(); }
  };
  scrub.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); e.preventDefault();
    seekTo(e.clientX);
    const move = (ev: PointerEvent): void => seekTo(ev.clientX);
    const up = (): void => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  return wrap;
}
