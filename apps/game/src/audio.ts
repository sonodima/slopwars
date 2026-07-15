// ─── Audio: real sample playback (SFX), music (theme/interlude), ambience ─────
// Samples in public/assets/audio/. Pure-feedback cues (reload, hit, jump…) keep a
// tiny synth since no sample was provided for them.
import { assetUrl } from "./assets";
import type { WeaponId } from "./types";

const SAMPLES = {
  knife: "knife.mp3", usp: "desert_eagle.mp3", ak47: "mp5.mp3", awp: "awp.mp3",
  boom: "bomb.mp3", shatter: "bottle_breaking.mp3", fire: "fire_loop.mp3",
  step1: "walking_rock_1.wav", step2: "walking_rock_2.wav", water: "water_loop.mp3",
  theme: "slopwars_theme_song_loop.mp3", interlude: "round_interlude.mp3",
  roundStart: "round_starts.mp3", roundEnd: "round_end.mp3",
  hit: "hitmarker.mp3", headshot: "headshot.mp3",
  jumpStart: "jump_start.mp3", jumpEnd: "jump_end.mp3", deathScreen: "death_screen.mp3",
} as const;
type SampleName = keyof typeof SAMPLES;

interface Loop { src: AudioBufferSourceNode; gain: GainNode; pan?: StereoPannerNode }

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

const MUFFLE_OPEN = 20000; // lowpass fully open (no audible filtering)
const MUFFLE_ON = 500;     // muffled "underwater" cutoff during death cam

class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private lowpass!: BiquadFilterNode; // master-bus lowpass for the muffle effect
  private buffers = new Map<SampleName, AudioBuffer>();
  private loading = new Map<SampleName, Promise<AudioBuffer>>();

  private theme: Loop | null = null;
  private interlude: Loop | null = null;
  private water: Loop | null = null;

  private ac(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.lowpass = this.ctx.createBiquadFilter();
      this.lowpass.type = "lowpass";
      this.lowpass.frequency.value = MUFFLE_OPEN;
      this.master.connect(this.lowpass).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** muffle everything (death cam) or restore. Smooth ramp so it feels like a filter sweep. */
  muffle(on: boolean): void {
    const ctx = this.ac();
    const f = this.lowpass.frequency;
    const now = ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    f.exponentialRampToValueAtTime(on ? MUFFLE_ON : MUFFLE_OPEN, now + 0.25);
  }

  unlock(): void { this.ac(); }

  /** Warm the sample cache up front (fetch + off-thread decode) so the FIRST shot,
   *  barrel/grenade blast, hit-marker, etc. don't fetch+decode mid-action — a common
   *  source of the brief hitch (or silent first shot) when a sound plays for the first
   *  time. Decoding happens off the main thread, so this never blocks gameplay; music /
   *  water loops are left to their own lazy loaders (they start moments later anyway). */
  preload(): void {
    const warm: SampleName[] = [
      "knife", "usp", "ak47", "awp", "boom", "shatter", "fire",
      "hit", "headshot", "jumpStart", "jumpEnd", "step1", "step2", "deathScreen",
      "roundStart", "roundEnd",
    ];
    for (const n of warm) void this.buf(n).catch(() => { /* a missing sample just stays lazy */ });
  }

  private buf(name: SampleName): Promise<AudioBuffer> {
    const cached = this.buffers.get(name);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(name);
    if (!p) {
      const ctx = this.ac();
      p = fetch(assetUrl(`audio/${SAMPLES[name]}`))
        .then((r) => r.arrayBuffer())
        .then((a) => ctx.decodeAudioData(a))
        .then((b) => { this.buffers.set(name, b); return b; });
      this.loading.set(name, p);
    }
    return p;
  }

  /** spatial one-shot */
  private play(name: SampleName, opts: { pan?: number; dist?: number; gain?: number; rate?: number } = {}): void {
    void this.buf(name).then((b) => {
      const ctx = this.ac();
      const src = ctx.createBufferSource();
      src.buffer = b;
      if (opts.rate) src.playbackRate.value = opts.rate;
      const g = ctx.createGain();
      g.gain.value = (opts.gain ?? 1) / (1 + (opts.dist ?? 0) * 0.09);
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(opts.pan ?? 0, -1, 1);
      src.connect(g).connect(p).connect(this.master);
      src.start();
    });
  }

  // ── low synth for pure-feedback cues (no samples supplied) ──
  private out(pan = 0, dist = 0): AudioNode {
    const ctx = this.ac();
    const g = ctx.createGain();
    g.gain.value = 1 / (1 + dist * 0.09);
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
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

  // ── weapons / combat (real samples) ──
  shot(w: WeaponId, pan = 0, dist = 0): void {
    const map: Partial<Record<WeaponId, SampleName>> = { knife: "knife", usp: "usp", ak47: "ak47", awp: "awp" };
    const s = map[w];
    if (s) this.play(s, { pan, dist, gain: w === "awp" ? 1 : 0.85, rate: 0.96 + Math.random() * 0.08 });
  }
  explosion(pan: number, dist: number): void { this.play("boom", { pan, dist: dist * 0.6, gain: 1 }); }
  shatter(pan: number, dist: number): void { this.play("shatter", { pan, dist: dist * 0.7, gain: 0.9 }); }

  /** looping molotov fire for `dur` seconds, fades out at the end */
  fire(dur: number, pan: number, dist: number): void {
    void this.buf("fire").then((b) => {
      const ctx = this.ac();
      const src = ctx.createBufferSource();
      src.buffer = b; src.loop = true;
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      const vol = 0.6 / (1 + dist * 0.09);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.3);
      g.gain.setValueAtTime(vol, t + Math.max(0.3, dur - 0.8));
      g.gain.linearRampToValueAtTime(0.001, t + dur);
      src.connect(g).connect(p).connect(this.master);
      src.start(t); src.stop(t + dur + 0.1);
    });
  }

  footstep(): void { this.play(Math.random() < 0.5 ? "step1" : "step2", { gain: 0.5, rate: 0.92 + Math.random() * 0.16 }); }

  // ── feedback cues (synth) ──
  reload(w: WeaponId): void {
    const dest = this.out();
    const seq = w === "awp" ? [0, 0.5, 1.4, 2.6, 3.2] : [0, 0.6, w === "ak47" ? 1.7 : 1.4];
    for (const t of seq) this.burst(0.04, 2800 + Math.random() * 800, 4, 0.3, dest, t);
    this.burst(0.06, 900, 3, 0.25, dest, seq[seq.length - 1] + 0.15);
  }
  jump(): void { this.play("jumpStart", { gain: 0.5, rate: 0.97 + Math.random() * 0.06 }); }
  land(): void { this.play("jumpEnd", { gain: 0.55, rate: 0.97 + Math.random() * 0.06 }); }
  hitmarker(hs: boolean): void { this.play(hs ? "headshot" : "hit", { gain: hs ? 1.2 : 1.0 }); }
  hurt(pan: number): void { this.thump(0.12, 300, 90, 0.5, this.out(pan)); }
  death(): void { this.play("deathScreen", { gain: 1.2 }); }
  impact(pan: number, dist: number): void { this.burst(0.05, 2200, 3, 0.25, this.out(pan, dist)); }
  nadeThrow(): void { this.burst(0.09, 1400, 1.2, 0.2, this.out()); }
  nadeBounce(pan: number, dist: number): void { this.burst(0.04, 1800, 3, 0.25, this.out(pan, dist)); }
  pickup(): void { const d = this.out(); this.thump(0.09, 660, 660, 0.22, d); this.thump(0.12, 990, 990, 0.22, d, 0.08); }
  draw(): void { this.burst(0.05, 2000, 4, 0.2, this.out()); }

  // ── round stings ──
  roundStart(): void { this.play("roundStart", { gain: 0.7 }); }
  roundEnd(): void { this.play("roundEnd", { gain: 0.7 }); }

  // ── music (looping, fade in/out) ──
  private startLoop(name: SampleName, vol: number, slot: "theme" | "interlude", loop = true): void {
    if (this[slot]) return;
    void this.buf(name).then((b) => {
      if (this[slot]) return; // guard re-entrancy
      const ctx = this.ac();
      const src = ctx.createBufferSource();
      src.buffer = b; src.loop = loop;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(g).connect(this.master);
      src.start();
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + (loop ? 1.6 : 0.4));
      const handle: Loop = { src, gain: g };
      this[slot] = handle;
      if (!loop) src.onended = () => { if (this[slot] === handle) this[slot] = null; };
    });
  }
  private stopLoop(existing: "theme" | "interlude", fade = 1.2): void {
    const l = this[existing];
    if (!l) return;
    this[existing] = null;
    const now = this.ac().currentTime;
    l.gain.gain.cancelScheduledValues(now);
    l.gain.gain.setValueAtTime(l.gain.gain.value, now);
    l.gain.gain.linearRampToValueAtTime(0, now + fade);
    l.src.stop(now + fade + 0.1);
  }

  startTheme(): void { this.startLoop("theme", 0.5, "theme"); }
  stopTheme(): void { this.stopLoop("theme"); }
  startInterlude(): void { this.startLoop("interlude", 0.6, "interlude", false); } // one-shot, not looped
  stopInterlude(): void { this.stopLoop("interlude", 0.6); }

  // ── ambient water (spatialized loop near fountain) ──
  startAmbientWater(): void {
    if (this.water) return;
    void this.buf("water").then((b) => {
      if (this.water) return;
      const ctx = this.ac();
      const src = ctx.createBufferSource();
      src.buffer = b; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(g).connect(p).connect(this.master);
      src.start();
      this.water = { src, gain: g, pan: p };
    });
  }
  setWaterSpatial(pan: number, dist: number): void {
    const w = this.water;
    if (!w || !w.pan) return;
    w.gain.gain.value = dist > 26 ? 0 : Math.min(0.5, 0.5 / (1 + dist * 0.12));
    w.pan.pan.value = clamp(pan, -1, 1);
  }
  stopAmbientWater(): void {
    const w = this.water;
    if (!w) return;
    this.water = null;
    try { w.src.stop(); } catch { /* already stopped */ }
  }
}

export const sfx = new Sfx();
