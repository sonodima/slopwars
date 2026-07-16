// ─── Custom holographic pointer ──────────────────────────────────────────────
// A visor-styled reticle that replaces the native cursor across the menu / lobby /
// settings chrome, drawn on an overlay canvas with an additive ghost trail. Echoes
// the HUD language: cyan holo palette, chamfered "piece of kit" silhouette, thin
// glowing strokes.
//
// It hides itself whenever the pointer isn't the thing driving the UI — pointer lock
// (in-match look), touch, or gamepad — so it never fights the crosshair or the sticks.
//
// A gamepad has no pointer, but it does have a focused control, so `lockTo()` lets menu
// navigation borrow the lock-on brackets on their own: the reticle body and trail stay
// dark, and only the frame flies between controls as the focus moves.

const HOLO = "155,236,255";       // --holo, as an rgb triplet for per-ghost alpha
const HOLO_HOT = "215,248,255";   // near-white core for the hot center

/** ghost trail length — enough to read as a streak on a fast flick, short enough
 *  that a slow drag doesn't smear into a blob */
const GHOSTS = 14;
/** a ghost is dropped every frame; ones older than this fade out entirely */
const GHOST_MS = 260;
/** how far the trail may lag before it's a teleport (alt-tab, window re-entry) —
 *  beyond this the trail is reset rather than drawing a streak across the screen */
const TELEPORT_PX = 260;

type Shape = "idle" | "hover" | "text";

interface Ghost { x: number; y: number; t: number }

export class Cursor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private x = -100; private y = -100;       // live pointer position (never smoothed — aim is exact)
  private ghosts: Ghost[] = [];
  private seen = false;                      // a real mousemove has landed
  private raf = 0;

  private shape: Shape = "idle";
  private down = false;
  /** spring state: 0 = idle silhouette, 1 = fully locked-on (hover) */
  private lock = 0;
  /** click pulse — 0..1, rings outward and fades */
  private pulse = 1;
  /** lock-on flash — 1 the instant a new target is acquired, decays to 0 */
  private snap = 0;

  /** the control the brackets frame (resolved from rawEl — see resolveHover) */
  private hoverEl: Element | null = null;
  /** the gamepad-focused control, when a pad is driving the menus (see lockTo) */
  private navEl: Element | null = null;
  /** the last raw event target, purely to detect when a re-resolve is needed */
  private rawEl: Element | null = null;
  /** true while the overlay is intentionally dark (see blanked()) — latched so the
   *  canvas is cleared once rather than every frame */
  private blank = false;
  /** the animated frame the corner brackets sit on: springs from a small box around the
   *  pointer out to the hovered element's rect, so a hover reads as acquiring a target */
  private box = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** whether `box` holds a frame worth sliding *from* — false means snap straight to the
   *  target rather than sweeping in from wherever the box was last left */
  private hadBox = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "cursor-fx";
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.resize();

    addEventListener("resize", () => this.resize());
    addEventListener("mousemove", (e) => this.onMove(e), { passive: true });
    addEventListener("mousedown", () => { this.down = true; this.pulse = 0; }, { passive: true });
    addEventListener("mouseup", () => { this.down = false; }, { passive: true });
    // leaving the window / entering a native UI surface: drop the trail so it doesn't
    // reappear as a stale streak on the way back in
    addEventListener("mouseleave", () => { this.seen = false; this.ghosts.length = 0; this.sync(); });
    addEventListener("blur", () => { this.seen = false; this.ghosts.length = 0; this.sync(); });
    // pointer lock owns the pointer in-match — the 3D crosshair takes over there
    document.addEventListener("pointerlockchange", () => this.sync());
  }

  /** true when the reticle should be drawing: a fine pointer exists, it has actually
   *  moved, and nothing else (lock / touch / gamepad) owns the pointer */
  private pointerActive(): boolean {
    if (!this.seen) return false;
    if (document.pointerLockElement) return false;
    if (document.body.classList.contains("touch") || document.body.classList.contains("gamepad")) return false;
    return matchMedia("(pointer:fine)").matches;
  }

  /** true when the overlay has anything to draw at all — a live pointer, or a gamepad
   *  focus to frame */
  private active(): boolean {
    return this.pointerActive() || (!!this.navEl && this.navEl.isConnected);
  }

  /** Point the lock-on brackets at a gamepad-focused control (or `null` to drop them).
   *  Only the frame is drawn in this mode — there's no pointer to put a reticle on. */
  lockTo(el: Element | null): void {
    if (el === this.navEl) return;
    if (el) this.snap = 1;         // acquiring a control flashes, the same way a hover does
    else this.hadBox = false;      // focus dropped — the next acquire starts fresh
    this.navEl = el;
    this.sync();
  }

  /** reconciles the running state with `active()` — toggles the body class that hides
   *  the native cursor, and starts / stops the rAF loop so an idle menu costs nothing */
  private sync(): void {
    const on = this.active();
    // only a live *pointer* hides the native cursor: in gamepad mode there's no arrow on
    // screen to hide, and latching the class would strip `cursor:pointer` from every
    // control the moment a pad woke up.
    document.body.classList.toggle("cursor-fx", this.pointerActive());
    if (on && !this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); }
    if (!on && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; this.clear(); }
  }

  private onMove(e: MouseEvent): void {
    // a locked pointer reports deltas, not a position — ignore it entirely
    if (document.pointerLockElement) return;
    if (Math.hypot(e.clientX - this.x, e.clientY - this.y) > TELEPORT_PX) this.ghosts.length = 0;
    this.x = e.clientX; this.y = e.clientY;
    this.seen = true;
    // a mouse move is the signal the pointer is back in play, so it's also what revives
    // the loop after it stopped — platform switches toggle body.touch / body.gamepad
    // without telling us, and without this a single touch on a hybrid device would
    // retire the reticle for good.
    if (!this.raf) this.sync();
    // compared against the *raw* target, not the resolved control: several raw targets
    // (a button and the label inside it) resolve to the same control, and re-resolving
    // only when the raw target changes keeps the style reads off the hot path
    const raw = e.target instanceof Element ? e.target : null;
    if (raw !== this.rawEl) {
      this.rawEl = raw;
      const prev = this.hoverEl;
      const { shape, el } = resolveHover(raw);
      this.shape = shape;
      this.hoverEl = el;
      // flash on *acquiring* a target — including moving straight from one control to
      // another, but not when crossing between pieces of the same control
      if (shape === "hover" && el !== prev) this.snap = 1;
    }
  }

  private resize(): void {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.ceil(innerWidth * this.dpr);
    this.canvas.height = Math.ceil(innerHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  /** half-size of the reticle body — it tightens slightly on a lock, handing the
   *  emphasis to the brackets rather than competing with them */
  private radius(): number {
    return (this.shape === "text" ? 5 : 7 - this.lock * 1.5) * (this.down ? 0.82 : 1);
  }

  /** the loading screen is dead time — a progress bar and nothing to point at — so the
   *  reticle stays dark over it rather than hovering around with nothing to do.
   *
   *  The exception: the first-run AI-consent toast resolves asynchronously and pops over
   *  the loading screen while assets are still streaming in, and it *is* clickable — so
   *  the reticle comes back for as long as it's up, or its buttons couldn't be aimed at. */
  private blanked(): boolean {
    if (document.body.dataset.screen !== "loading") return false;
    const toast = document.getElementById("ai-consent");
    return !toast || toast.classList.contains("hidden");
  }

  /** the element rect the brackets should frame, or null to fall back to a small box
   *  around the pointer */
  private lockRect(): DOMRect | null {
    const nav = this.navMode();
    const el = nav ? this.navEl : this.hoverEl;
    if (!nav && this.shape !== "hover") return null;
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    // full-bleed hit areas (#click-to-play is inset:0) would frame the whole viewport —
    // that reads as a border, not a lock
    if (r.width > innerWidth * 0.7 && r.height > innerHeight * 0.7) return null;
    return r;
  }

  /** the pad owns the UI: frame the focused control, and draw nothing else */
  private navMode(): boolean {
    return !this.pointerActive() && !!this.navEl && this.navEl.isConnected;
  }

  private last = performance.now();
  private tick = (now: number): void => {
    const dt = Math.min((now - this.last) / 1000, 0.05); this.last = now;
    if (!this.active()) { this.sync(); return; }
    this.raf = requestAnimationFrame(this.tick);

    // Nothing to point at: stay dark, but keep the loop alive to notice the screen
    // changing (and keep the native cursor hidden — the class stays on, so the blank
    // screen gets no pointer at all rather than the system arrow back). The trail is
    // dropped too, or it would whip across the screen when the menu appears.
    if (this.blanked()) {
      if (!this.blank) { this.clear(); this.blank = true; }
      this.ghosts.length = 0;
      return;
    }
    this.blank = false;

    const nav = this.navMode();

    // ── springs ──
    const wantLock = nav || this.shape === "hover" ? 1 : 0;
    this.lock += (wantLock - this.lock) * Math.min(dt * 14, 1);
    this.pulse = Math.min(this.pulse + dt * 3.4, 1);
    this.snap = Math.max(this.snap - dt * 4.5, 0);

    // ── lock-on frame ──
    // The rect is re-read every frame rather than cached on hover: menus scroll, panels
    // animate in, and a stale rect would leave the brackets framing empty space.
    const r = this.lockRect();
    // a pad-focused control that scrolled out of the DOM leaves nothing to frame
    if (nav && !r) { this.clear(); return; }
    const R = this.radius();
    const tx0 = r ? r.left - 4 : this.x - (R + 8), ty0 = r ? r.top - 4 : this.y - (R + 8);
    const tx1 = r ? r.right + 4 : this.x + (R + 8), ty1 = r ? r.bottom + 4 : this.y + (R + 8);
    // with nothing locked the frame just rides the pointer (k=1), so the next hover
    // launches the brackets from the reticle instead of sliding in from a stale corner.
    // The pad's first focus of a session has no previous frame to slide from either.
    const k = this.lock < 0.02 || (nav && !this.hadBox) ? 1 : Math.min(dt * 16, 1);
    this.box.x0 += (tx0 - this.box.x0) * k; this.box.y0 += (ty0 - this.box.y0) * k;
    this.box.x1 += (tx1 - this.box.x1) * k; this.box.y1 += (ty1 - this.box.y1) * k;
    this.hadBox = true;

    // ── trail ── (pointer only — there's no pointer path to streak in nav mode)
    if (!nav) {
      this.ghosts.push({ x: this.x, y: this.y, t: now });
      while (this.ghosts.length > GHOSTS || (this.ghosts.length && now - this.ghosts[0].t > GHOST_MS)) this.ghosts.shift();
    }

    this.draw(now, nav);
  };

  /** every stroke is laid down twice — a dark backing, then the holo line over it. The
   *  palette is light, and the primary CTAs are filled with it, so a plain cyan stroke
   *  disappears on its own buttons; the ink outline keeps it readable on both the dark
   *  chrome and the light fills. */
  private dual(path: () => void, alpha: number, w: number): void {
    const c = this.ctx;
    c.shadowBlur = 0;
    c.strokeStyle = `rgba(5,9,12,${alpha * 0.65})`;
    c.lineWidth = w + 2;
    path(); c.stroke();
    c.shadowColor = `rgba(120,214,255,${0.65 + this.lock * 0.3})`;
    c.shadowBlur = 9;
    c.strokeStyle = `rgba(${HOLO},${alpha})`;
    c.lineWidth = w;
    path(); c.stroke();
  }

  /** the corner brackets clamped to `box` — the shared "target acquired" read, whether
   *  the target came from a hover or from gamepad focus */
  private drawBrackets(): void {
    if (this.lock <= 0.01) return;
    const c = this.ctx, b = this.box;
    // arms scale with the frame but never overrun a short edge (a 22px-tall slider
    // would otherwise get brackets that meet in the middle and read as a full box)
    const arm = Math.max(3.5, Math.min(14, Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.26));
    this.dual(() => {
      c.beginPath();
      c.moveTo(b.x0, b.y0 + arm); c.lineTo(b.x0, b.y0); c.lineTo(b.x0 + arm, b.y0); // ┌
      c.moveTo(b.x1 - arm, b.y0); c.lineTo(b.x1, b.y0); c.lineTo(b.x1, b.y0 + arm); // ┐
      c.moveTo(b.x1, b.y1 - arm); c.lineTo(b.x1, b.y1); c.lineTo(b.x1 - arm, b.y1); // ┘
      c.moveTo(b.x0 + arm, b.y1); c.lineTo(b.x0, b.y1); c.lineTo(b.x0, b.y1 - arm); // └
    }, this.lock * (0.85 + this.snap * 0.15), 1.5 + this.snap * 1.2);
  }

  private draw(now: number, nav: boolean): void {
    const c = this.ctx;
    this.clear();
    c.save();
    if (nav) { this.drawBrackets(); c.restore(); return; }
    // the trail is light on a dark UI — additive keeps overlapping ghosts glowing
    // rather than muddying into flat fill
    c.globalCompositeOperation = "lighter";
    c.lineJoin = "miter";

    // ── ghost trail: shrinking, fading copies of the silhouette ──
    for (let i = 0; i < this.ghosts.length - 1; i++) {
      const g = this.ghosts[i];
      const age = (now - g.t) / GHOST_MS;
      if (age >= 1) continue;
      // clamped, not just `1 - age`: a ghost stamped ahead of `now` would make life
      // blow past 1 and scale the radius into a viewport-spanning box. rAF timestamps
      // are monotonic so this shouldn't happen, but the failure is ugly and the guard
      // is free.
      const life = Math.min(1 - age, 1);
      // the falloff is deliberately gentler than a square — squared put all but the
      // two or three newest ghosts under ~0.2 alpha, which read as no trail at all
      const a = Math.pow(life, 1.5) * 0.58;
      const r = (5.5 + this.lock * 2) * (0.4 + life * 0.55);
      c.strokeStyle = `rgba(${HOLO},${a})`;
      c.lineWidth = 1.15;
      chamfer(c, g.x, g.y, r);
      c.stroke();
    }

    // ── streak: a hairline through the ghost path, ties the copies into one motion ──
    if (this.ghosts.length > 2) {
      const grad = c.createLinearGradient(this.ghosts[0].x, this.ghosts[0].y, this.x, this.y);
      grad.addColorStop(0, `rgba(${HOLO},0)`);
      grad.addColorStop(1, `rgba(${HOLO},0.5)`);
      c.strokeStyle = grad; c.lineWidth = 1;
      c.beginPath();
      c.moveTo(this.ghosts[0].x, this.ghosts[0].y);
      for (const g of this.ghosts) c.lineTo(g.x, g.y);
      c.stroke();
    }

    c.restore();
    c.save();

    const x = this.x, y = this.y;
    const R = this.radius();

    // ── click pulse: a chamfered ring blowing outward on mousedown ──
    if (this.pulse < 1) {
      const p = this.pulse;
      c.globalCompositeOperation = "lighter";
      c.strokeStyle = `rgba(${HOLO},${(1 - p) * 0.55})`;
      c.lineWidth = 1.5 * (1 - p) + 0.5;
      chamfer(c, x, y, R + p * 22);
      c.stroke();
      c.globalCompositeOperation = "source-over";
    }

    const dual = (path: () => void, alpha: number, w: number) => this.dual(path, alpha, w);

    if (this.shape === "text") {
      // text fields get an I-beam in the same holo language — bar + serif caps
      dual(() => {
        c.beginPath();
        c.moveTo(x, y - 8); c.lineTo(x, y + 8);
        c.moveTo(x - 3.5, y - 8); c.lineTo(x + 3.5, y - 8);
        c.moveTo(x - 3.5, y + 8); c.lineTo(x + 3.5, y + 8);
      }, 1, 1.4);
    } else {
      // ── body: the chamfered "piece of kit" outline, straight from .panel ──
      dual(() => chamfer(c, x, y, R), 0.9 + this.lock * 0.1, 1.4);

      // ── lock-on brackets: they fly off the reticle and clamp to the hovered
      //    element's corners, so hovering reads as the visor acquiring a target ──
      this.drawBrackets();

      // ── ticks: N/E/S/W hairlines, the idle silhouette's read at a glance. They
      //    retract into the body as the brackets take over the hover read. ──
      const t0 = R + 2, t1 = R + 5 + (1 - this.lock) * 2;
      dual(() => {
        c.beginPath();
        c.moveTo(x, y - t0); c.lineTo(x, y - t1);
        c.moveTo(x, y + t0); c.lineTo(x, y + t1);
        c.moveTo(x - t0, y); c.lineTo(x - t1, y);
        c.moveTo(x + t0, y); c.lineTo(x + t1, y);
      }, (1 - this.lock) * 0.6 + 0.3, 1.1);
    }

    // ── hot core: the one pixel that says exactly where the click lands ──
    c.shadowBlur = 0;
    c.fillStyle = "rgba(5,9,12,.6)";
    c.beginPath();
    c.arc(x, y, (this.down ? 2.5 : 1.9) + 1.3, 0, Math.PI * 2);
    c.fill();
    c.shadowColor = `rgba(120,214,255,.8)`; c.shadowBlur = 7;
    c.fillStyle = `rgba(${HOLO_HOT},1)`;
    c.beginPath();
    c.arc(x, y, this.down ? 2.5 : 1.9, 0, Math.PI * 2);
    c.fill();

    c.restore();
  }
}

/** the chamfered square from `.panel` / the holo modules — square with the top-right
 *  and bottom-left corners cut, scaled to a `r`-radius reticle */
function chamfer(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const k = Math.max(r * 0.42, 1.5); // cut depth, proportional to size
  c.beginPath();
  c.moveTo(x - r, y - r);
  c.lineTo(x + r - k, y - r);
  c.lineTo(x + r, y - r + k);
  c.lineTo(x + r, y + r);
  c.lineTo(x - r + k, y + r);
  c.lineTo(x - r, y + r - k);
  c.closePath();
}

/** which silhouette the pointer wants, and which element the brackets should frame —
 *  mirrors what the native cursor would have done, so the reticle stays truthful about
 *  what's clickable without a hand-maintained list of selectors.
 *
 *  The catch: hiding the native cursor means `cursor:none!important` sits on every
 *  element, so the computed value here would always read back `none` and nothing would
 *  ever be seen as clickable. The override is lifted for the read and restored in the
 *  same synchronous block — the browser only paints at frame boundaries, so it never
 *  sees the gap. Called on hover-target changes, not per frame.
 *
 *  `cursor` inherits, so the event target is often some piece *inside* the control (the
 *  <i> knob of a toggle, a button's label) that merely inherited `pointer`. Framing that
 *  is wrong — it's not what you're aiming at. Climbing to the outermost ancestor that
 *  still computes the same cursor lands on the element that actually declared it, i.e.
 *  the control itself. */
function resolveHover(el: Element | null): { shape: Shape; el: Element | null } {
  if (!el) return { shape: "idle", el: null };
  const cl = document.body.classList;
  const lifted = cl.contains("cursor-fx");
  if (lifted) cl.remove("cursor-fx");
  try {
    const cur = getComputedStyle(el).cursor;
    const shape: Shape = cur === "pointer" ? "hover" : cur === "text" ? "text" : "idle";
    let target = el;
    if (shape === "hover") {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).cursor !== cur) break;
        target = p;
      }
    }
    return { shape, el: target };
  } finally {
    if (lifted) cl.add("cursor-fx"); // restore even if a getComputedStyle throws
  }
}
