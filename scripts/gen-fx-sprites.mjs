// Generate the particle sprite textures used as realistic defaults by the `fire`
// and `smoke` emitter presets (see apps/game/src/objects.ts). Each is written as
// a normal texture *folder* under public/assets/textures/<name>/color.png, so the
// asset scanner discovers it like any other texture and the particle system reads
// its colour map as the sprite. Swapping in a real captured/authored sheet later
// is just dropping a new color.* into the same folder — no code change.
//
// The shapes are deliberately physically-motivated rather than plain round puffs:
//   • fire  — a tall flickering teardrop with a hot near-white core fading through
//              warm tones to a wispy tip (tinted orange + additive at runtime).
//   • smoke — billowy fractal-noise turbulence with a soft round falloff (tinted
//              grey + normal-blended at runtime), so puffs read as volume not discs.
//
// Run: node scripts/gen-fx-sprites.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SIZE = 128;
const OUT = path.resolve("public/assets/textures");

// ── deterministic value-noise (seeded) so results are reproducible ────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** a tileable value-noise grid sampler — wraps on `cells`, so it accepts any uv
 *  (callers sample at scaled coords well outside 0..1 for turbulence). */
function noiseGrid(cells, rng) {
  const g = [];
  for (let y = 0; y < cells; y++) { g[y] = []; for (let x = 0; x < cells; x++) g[y][x] = rng(); }
  const wrap = (n) => ((n % cells) + cells) % cells;
  return (u, v) => {
    const fx = u * cells, fy = v * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const x0 = wrap(ix), y0 = wrap(iy), x1 = wrap(ix + 1), y1 = wrap(iy + 1);
    const tx = smooth(fx - ix), ty = smooth(fy - iy);
    const top = lerp(g[y0][x0], g[y0][x1], tx);
    const bot = lerp(g[y1][x0], g[y1][x1], tx);
    return lerp(top, bot, ty);
  };
}
/** fractal (summed-octave) noise in [0,1] */
function fbm(rng, octaves = 4, baseCells = 3) {
  const layers = [];
  let cells = baseCells, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { layers.push({ n: noiseGrid(cells, rng), amp }); norm += amp; cells *= 2; amp *= 0.5; }
  return (u, v) => { let s = 0; for (const l of layers) s += l.n(u, v) * l.amp; return s / norm; };
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ── minimal RGBA PNG encoder (no deps) ────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                         // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function writeSprite(name, shade) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / (SIZE - 1), v = y / (SIZE - 1);
      const { r, g, b, a } = shade(u, v);
      const i = (y * SIZE + x) * 4;
      buf[i] = Math.round(clamp01(r) * 255);
      buf[i + 1] = Math.round(clamp01(g) * 255);
      buf[i + 2] = Math.round(clamp01(b) * 255);
      buf[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "color.png"), encodePNG(buf, SIZE, SIZE));
  console.log("wrote", path.relative(process.cwd(), path.join(dir, "color.png")));
}

// ── fire: teardrop flame, hot core → warm tip, flicker noise ──────────────────
{
  const turb = fbm(mulberry32(0xf1_2e), 5, 3);
  writeSprite("fire", (u, v) => {
    const cx = u - 0.5;
    const yUp = 1 - v;                                  // 0 at bottom, 1 at top
    // teardrop half-width: fat at the base, pinching to a point at the top
    const halfW = 0.42 * Math.sin(Math.min(1, yUp * 1.05) * Math.PI * 0.5) * (1 - yUp * 0.35) + 0.02;
    const wob = (turb(u * 1.6, v * 1.3) - 0.5) * 0.10 * (0.3 + yUp);   // wavering edges
    const edge = Math.abs(cx + wob) / halfW;                            // 0 centre → 1 rim
    let a = clamp01(1 - edge * edge);
    a *= clamp01(1 - Math.pow(Math.abs(yUp - 0.5) * 1.7, 3));           // fade base & tip
    a *= 0.65 + 0.35 * turb(u * 2.2 + 3, v * 2.2 - yUp * 1.5);          // internal flicker
    a = clamp01(a * 1.15);
    // hot core (near-white/yellow) at the bottom, cooling upward
    const core = clamp01(1 - edge * 1.5) * clamp01(1 - yUp * 1.2);
    const r = 1.0;
    const g = clamp01(0.55 + 0.45 * core - yUp * 0.15);
    const b = clamp01(0.12 + 0.7 * core);
    return { r, g, b, a };
  });
}

// ── smoke: billowy fractal turbulence under a soft round mask ─────────────────
{
  const turb = fbm(mulberry32(0x5_c0c), 6, 2);
  writeSprite("smoke", (u, v) => {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const d = Math.hypot(dx, dy);
    const mask = clamp01(1 - d);
    const soft = mask * mask * (3 - 2 * mask);          // smoothstep round falloff
    const n = turb(u, v);
    const cloud = clamp01((n - 0.34) / 0.4);             // higher contrast → visible billows
    let a = soft * (0.55 + 0.75 * cloud);               // denser core, soft rim
    a = clamp01(a * 1.15);
    const shade = 0.72 + 0.28 * n;                       // internal light/dark variation
    return { r: shade, g: shade, b: shade, a };
  });
}
