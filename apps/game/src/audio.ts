// ─── Audio: real sample playback (SFX), music (theme/interlude), ambience ─────
// Samples in public/assets/audio/. Each entry below names an audio asset by its
// *slug* (its on-disk folder name), resolved to a file path through the catalog —
// so these engine SFX are decoupled from the on-disk layout (audio is a folder per
// clip like every other asset) and survive a folder move. Pure-feedback cues
// (reload, hit, jump…) keep a tiny synth since no sample was provided for them.
import catalog from "virtual:asset-catalog";
import { assetBySlug } from "@slopwars/shared";
import { assetUrl } from "./assets";
import type { WeaponId } from "./types";

const SAMPLES = {
  knife: "knife", usp: "desert_eagle", ak47: "mp5", awp: "awp", luger: "luger_p08", m4a1: "m4a1", suomi: "suomi", shotgun: "shotgun",
  boom: "bomb", shatter: "bottle_breaking", fire: "fire_loop",
  step1: "walking_rock_1", step2: "walking_rock_2", water: "water_loop",
  theme: "slopwars_theme_song_loop", interlude: "round_interlude",
  roundStart: "round_starts", roundEnd: "round_end",
  hit: "hitmarker", headshot: "headshot",
  jumpStart: "jump_start", jumpEnd: "jump_end", deathScreen: "death_screen",
  portalShot: "portal_gun", portalLoop: "portal_loop",
} as const;
type SampleName = keyof typeof SAMPLES;

/** URL for a sample: resolve its slug to the catalog's file path (folder-per-clip),
 *  falling back to a flat path so a not-yet-scanned clip still tries to load. */
function sampleUrl(name: SampleName): string {
  const slug = SAMPLES[name];
  return assetUrl(assetBySlug(catalog.audio, slug)?.file ?? `audio/${slug}.mp3`);
}

interface Loop { src: AudioBufferSourceNode; gain: GainNode; pan?: StereoPannerNode }

/** live handle to a looping portal hum (see portalHum) */
export interface PortalHum { set(pan: number, dist: number, level: number): void; stop(): void }

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
  private rainLoop: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

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
      "knife", "usp", "ak47", "awp", "luger", "m4a1", "suomi", "shotgun", "boom", "shatter", "fire",
      "hit", "headshot", "jumpStart", "jumpEnd", "step1", "step2", "deathScreen",
      "roundStart", "roundEnd", "portalShot", "portalLoop",
    ];
    for (const n of warm) void this.buf(n).catch(() => { /* a missing sample just stays lazy */ });
  }

  private buf(name: SampleName): Promise<AudioBuffer> {
    const cached = this.buffers.get(name);
    if (cached) return Promise.resolve(cached);
    let p = this.loading.get(name);
    if (!p) {
      const ctx = this.ac();
      p = fetch(sampleUrl(name))
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
    const map: Partial<Record<WeaponId, SampleName>> = { knife: "knife", usp: "usp", ak47: "ak47", awp: "awp", luger: "luger", m4a1: "m4a1", suomi: "suomi", shotgun: "shotgun" };
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
  hitmarker(hs: boolean): void { this.play(hs ? "headshot" : "hit", { gain: hs ? 1.2 : 1.4 }); }
  hurt(pan: number): void { this.thump(0.12, 300, 90, 0.5, this.out(pan)); }
  death(): void { this.play("deathScreen", { gain: 1.2 }); }
  impact(pan: number, dist: number): void { this.burst(0.05, 2200, 3, 0.25, this.out(pan, dist)); }
  nadeThrow(): void { this.burst(0.09, 1400, 1.2, 0.2, this.out()); }
  nadeBounce(pan: number, dist: number): void { this.burst(0.04, 1800, 3, 0.25, this.out(pan, dist)); }
  pickup(): void { const d = this.out(); this.thump(0.09, 660, 660, 0.22, d); this.thump(0.12, 990, 990, 0.22, d, 0.08); }
  draw(): void { this.burst(0.05, 2000, 4, 0.2, this.out()); }

  // ── hardpoint ──
  /** the hill is about to relocate — an urgent double blip */
  hillWarn(): void { const d = this.out(); this.thump(0.07, 760, 760, 0.22, d); this.thump(0.07, 760, 760, 0.22, d, 0.16); }
  /** the hill moved — a rising two-tone sting (inverse of the pickup chirp) */
  hillMove(): void { const d = this.out(); this.thump(0.1, 520, 520, 0.26, d); this.thump(0.16, 880, 880, 0.28, d, 0.11); }

  // ── portals ──
  /** a portal snapped open (real sample). Orange (slot 1) plays a touch higher so the
   *  pair still reads as two distinct colours, like the old synth cue did. */
  portalFire(slot: 0 | 1, pan = 0, dist = 0): void {
    this.play("portalShot", { pan, dist, gain: 0.95, rate: slot === 0 ? 1.0 : 1.12 });
  }
  /** placement ray hit nothing in range — a soft dud */
  portalFail(): void { this.thump(0.12, 230, 120, 0.2, this.out()); }
  /** something crossed a portal — an airy whoosh with a falling tail */
  portalEnter(pan = 0, dist = 0): void {
    const d = this.out(pan, dist);
    this.burst(0.22, 900, 0.8, 0.3, d);
    this.thump(0.26, 540, 90, 0.35, d);
  }
  /** start a looping portal hum from the real `portal_loop` sample, spatialized. The
   *  caller drives it every frame — panning + distance attenuation AND the lifespan cue
   *  (level fades toward 0 over the portal's last seconds) — then must stop() it, which
   *  fades out and kills the source. The buffer decodes off-thread; nodes are wired up
   *  front so set/stop work immediately and the loop simply starts once it's ready. */
  portalHum(): PortalHum {
    const ctx = this.ac();
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner();
    g.connect(p).connect(this.master);
    let src: AudioBufferSourceNode | null = null;
    let stopped = false;
    void this.buf("portalLoop").then((b) => {
      if (stopped) return; // stopped before the sample finished decoding
      src = ctx.createBufferSource();
      src.buffer = b; src.loop = true;
      src.connect(g);
      src.start();
    });
    return {
      set: (pan, dist, level) => {
        p.pan.value = clamp(pan, -1, 1);
        const v = dist > 30 ? 0 : (0.6 * clamp(level, 0, 1)) / (1 + dist * 0.14);
        g.gain.setTargetAtTime(v, ctx.currentTime, 0.08); // smoothed — no zipper noise
      },
      stop: () => {
        stopped = true;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.05);
        if (src) { try { src.stop(t + 0.4); } catch { /* already stopped */ } }
      },
    };
  }

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

  // ── rain ambience (no sample exists — band-filtered noise IS rain) ──
  startRain(level: number): void {
    if (this.rainLoop) return;
    const ctx = this.ac();
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf(2.5);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 420;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 3400;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(lp).connect(g).connect(this.master);
    src.start();
    g.gain.linearRampToValueAtTime(0.16 * clamp(level, 0, 1) + 0.04, ctx.currentTime + 1.4);
    this.rainLoop = { src, gain: g };
  }
  stopRain(): void {
    const r = this.rainLoop;
    if (!r) return;
    this.rainLoop = null;
    const now = this.ac().currentTime;
    r.gain.gain.cancelScheduledValues(now);
    r.gain.gain.setValueAtTime(r.gain.gain.value, now);
    r.gain.gain.linearRampToValueAtTime(0, now + 0.8);
    r.src.stop(now + 0.9);
  }
}

export const sfx = new Sfx();
