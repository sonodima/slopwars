// ─── Procedural textures (canvas → Texture2D) ───────────────────────────────
import { Engine, Texture2D } from "@galacean/engine";

function canvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")!];
}

function noise(ctx: CanvasRenderingContext2D, size: number, alpha: number, mono = true): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 2 * alpha * 255;
    d[i] += mono ? n : (Math.random() - 0.5) * 2 * alpha * 255;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function toTex(engine: Engine, c: HTMLCanvasElement): Texture2D {
  const t = new Texture2D(engine, c.width, c.height);
  t.setImageSource(c);
  t.generateMipmaps();
  t.anisoLevel = 4;
  return t;
}

export interface MapTextures {
  wall: Texture2D;    // sand plaster
  floor: Texture2D;   // concrete tiles
  crate: Texture2D;   // wood
  metal: Texture2D;   // ribbed door metal
  stone: Texture2D;   // brick
  dark: Texture2D;    // tunnel tarmac
}

export function buildTextures(engine: Engine): MapTextures {
  const S = 384;

  // sand plaster wall
  let [c, ctx] = canvas(S);
  ctx.fillStyle = "#c9b088";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${150 + Math.random() * 60 | 0},${120 + Math.random() * 50 | 0},${80 + Math.random() * 40 | 0},0.25)`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  ctx.fillStyle = "rgba(90,70,50,0.35)"; // grime band bottom
  ctx.fillRect(0, S - 34, S, 34);
  ctx.strokeStyle = "rgba(110,90,60,0.4)";
  for (let i = 0; i < 7; i++) { // cracks
    ctx.beginPath();
    let x = Math.random() * S, y = Math.random() * S;
    ctx.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 40; y += Math.random() * 25; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  noise(ctx, S, 0.05);
  const wall = toTex(engine, c);

  // concrete floor tiles
  [c, ctx] = canvas(S);
  ctx.fillStyle = "#b3a184";
  ctx.fillRect(0, 0, S, S);
  noise(ctx, S, 0.07);
  ctx.strokeStyle = "rgba(70,60,45,0.6)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 2; i++) {
    ctx.beginPath(); ctx.moveTo(i * S / 2, 0); ctx.lineTo(i * S / 2, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * S / 2); ctx.lineTo(S, i * S / 2); ctx.stroke();
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(60,50,40,${Math.random() * 0.15})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 3, 3);
  }
  const floor = toTex(engine, c);

  // wooden crate
  [c, ctx] = canvas(S);
  ctx.fillStyle = "#8a6238";
  ctx.fillRect(0, 0, S, S);
  const ph = S / 6;
  for (let i = 0; i < 6; i++) { // planks
    ctx.fillStyle = i % 2 ? "#906a3e" : "#7d5730";
    ctx.fillRect(0, i * ph, S, ph - 4);
  }
  for (let i = 0; i < 500; i++) { // grain
    ctx.fillStyle = `rgba(60,40,20,${Math.random() * 0.25})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 10 + Math.random() * 26, 1);
  }
  ctx.strokeStyle = "#5d3f1e"; ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, S - 14, S - 14); // frame
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(10, 10); ctx.lineTo(S - 10, S - 10); ctx.stroke(); // cross
  ctx.beginPath(); ctx.moveTo(S - 10, 10); ctx.lineTo(10, S - 10); ctx.stroke();
  noise(ctx, S, 0.04);
  const crate = toTex(engine, c);

  // ribbed metal (doors)
  [c, ctx] = canvas(S);
  ctx.fillStyle = "#5d6b60";
  ctx.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 24) {
    ctx.fillStyle = "#4c584e"; ctx.fillRect(x, 0, 12, S);
    ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(x + 12, 0, 2, S);
    ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fillRect(x + 10, 0, 2, S);
  }
  for (let i = 0; i < 160; i++) { // rust
    ctx.fillStyle = `rgba(120,70,40,${Math.random() * 0.3})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 8, 2 + Math.random() * 8);
  }
  noise(ctx, S, 0.05);
  const metal = toTex(engine, c);

  // brick / stone
  [c, ctx] = canvas(S);
  ctx.fillStyle = "#9d8a6b";
  ctx.fillRect(0, 0, S, S);
  const bh = 32, bw = 64;
  for (let row = 0; row < S / bh; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col < S / bw + 1; col++) {
      ctx.fillStyle = `hsl(${33 + Math.random() * 8},${28 + Math.random() * 12}%,${48 + Math.random() * 12}%)`;
      ctx.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
    }
  }
  noise(ctx, S, 0.05);
  const stone = toTex(engine, c);

  // dark tunnel tarmac
  [c, ctx] = canvas(S);
  ctx.fillStyle = "#57503f";
  ctx.fillRect(0, 0, S, S);
  noise(ctx, S, 0.09);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(Math.random() * S, Math.random() * S, 4 + Math.random() * 18, 0, 7);
    ctx.fill();
  }
  const dark = toTex(engine, c);

  return { wall, floor, crate, metal, stone, dark };
}
