// ─── Synthesized sound effects (no assets) ───────────────────────────────────
import type { WeaponId } from "./types";

class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;

  private ac(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  unlock(): void { this.ac(); }

  /** pan [-1,1], dist for attenuation */
  private out(pan = 0, dist = 0): AudioNode {
    const ctx = this.ac();
    const g = ctx.createGain();
    g.gain.value = 1 / (1 + dist * 0.09);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.master);
    return g;
  }

  private noiseBuf(len: number): AudioBuffer {
    const ctx = this.ac();
    const b = ctx.createBuffer(1, (ctx.sampleRate * len) | 0, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  private burst(dur: number, freq: number, q: number, gain: number, dest: AudioNode, when = 0): void {
    const ctx = this.ac();
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf(dur + 0.02);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t); src.stop(t + dur + 0.05);
  }

  private thump(dur: number, f0: number, f1: number, gain: number, dest: AudioNode, when = 0): void {
    const ctx = this.ac();
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  shot(w: WeaponId, pan = 0, dist = 0): void {
    const dest = this.out(pan, dist);
    if (w === "knife") { this.burst(0.08, 2500, 2, 0.25, dest); return; }
    if (w === "usp") { // suppressed pop
      this.burst(0.07, 1200, 1.2, 0.5, dest);
      this.thump(0.06, 250, 70, 0.4, dest);
    } else if (w === "ak47") {
      this.burst(0.1, 1800, 0.8, 0.9, dest);
      this.burst(0.14, 500, 0.7, 0.7, dest);
      this.thump(0.11, 220, 45, 0.9, dest);
    } else { // awp
      this.burst(0.16, 1400, 0.6, 1.0, dest);
      this.burst(0.3, 300, 0.5, 0.9, dest);
      this.thump(0.25, 160, 32, 1.1, dest);
    }
  }

  reload(w: WeaponId): void {
    const dest = this.out();
    const seq = w === "awp" ? [0, 0.5, 1.4, 2.6, 3.2] : [0, 0.6, w === "ak47" ? 1.7 : 1.4];
    for (const t of seq) this.burst(0.04, 2800 + Math.random() * 800, 4, 0.3, dest, t);
    this.burst(0.06, 900, 3, 0.25, dest, seq[seq.length - 1] + 0.15);
  }

  footstep(): void { this.burst(0.05, 500 + Math.random() * 250, 1.5, 0.14, this.out()); }
  jump(): void { this.burst(0.07, 800, 2, 0.12, this.out()); }
  land(): void { this.thump(0.08, 180, 60, 0.25, this.out()); }

  hitmarker(hs: boolean): void {
    const dest = this.out();
    this.burst(0.04, hs ? 4200 : 3000, 8, 0.4, dest);
    if (hs) this.thump(0.08, 1500, 900, 0.2, dest, 0.02);
  }

  hurt(pan: number): void { this.thump(0.12, 300, 90, 0.5, this.out(pan)); }

  death(): void {
    const dest = this.out();
    this.thump(0.4, 300, 50, 0.6, dest);
    this.burst(0.3, 600, 1, 0.3, dest);
  }

  beep(hi = false): void { this.thump(0.12, hi ? 1320 : 880, hi ? 1320 : 880, 0.25, this.out()); }

  impact(pan: number, dist: number): void { this.burst(0.05, 2200, 3, 0.25, this.out(pan, dist)); }

  explosion(pan: number, dist: number): void {
    const dest = this.out(pan, dist * 0.6);
    this.thump(0.5, 120, 26, 1.4, dest);
    this.burst(0.35, 400, 0.4, 1.2, dest);
    this.burst(0.6, 150, 0.4, 1.0, dest, 0.02);
    this.burst(0.12, 2500, 1, 0.5, dest);
  }

  shatter(pan: number, dist: number): void {
    const dest = this.out(pan, dist * 0.7);
    for (let i = 0; i < 5; i++) this.burst(0.05, 3200 + Math.random() * 2500, 6, 0.3, dest, i * 0.015);
    this.burst(0.2, 900, 1, 0.4, dest);
  }

  fire(dur: number, pan: number, dist: number): void {
    const ctx = this.ac();
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf(1);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 700; f.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.3);
    g.gain.setValueAtTime(0.35, t + dur - 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out(pan, dist * 0.7));
    src.start(t); src.stop(t + dur + 0.1);
  }

  nadeThrow(): void { this.burst(0.09, 1400, 1.2, 0.2, this.out()); }
  nadeBounce(pan: number, dist: number): void { this.burst(0.04, 1800, 3, 0.25, this.out(pan, dist)); }

  pickup(): void {
    const dest = this.out();
    this.thump(0.09, 660, 660, 0.22, dest);
    this.thump(0.12, 990, 990, 0.22, dest, 0.08);
  }

  draw(): void { this.burst(0.05, 2000, 4, 0.2, this.out()); }
}

export const sfx = new Sfx();
