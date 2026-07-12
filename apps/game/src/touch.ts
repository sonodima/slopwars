// ─── On-screen touch controls (virtual stick + look drag + action buttons) ────
// Only active in "touch mode" (see main.ts detection). Desktop mouse + keyboard
// behaviour is untouched: these listeners live on dedicated overlay elements and
// feed the exact same game state the keyboard/mouse paths do.
import { LOADOUT, WEAPONS } from "./types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// short viewmodel-strip labels for the loadout slots
const WEP_SHORT: Record<string, string> = {
  knife: "KNF", usp: "USP", ak47: "AK", awp: "AWP", he: "HE", mol: "MOL",
};

export class TouchControls {
  enabled = false;

  // analog state, polled by the game loop each tick
  moveX = 0; // -1..1 (strafe: right positive)
  moveY = 0; // -1..1 (forward positive)
  sprint = false; // true when the stick is pushed near the rim

  // continuous callbacks (held buttons)
  onLook: (dx: number, dy: number) => void = () => {};
  onFire: (down: boolean) => void = () => {};
  onJump: (down: boolean) => void = () => {};
  onScore: (down: boolean) => void = () => {};
  // discrete taps
  onScope: () => void = () => {};
  onReload: () => void = () => {};
  onWeapon: (i: number) => void = () => {};
  onChat: () => void = () => {};
  onMic: () => void = () => {};

  private knob!: HTMLElement;
  private joyId = -1;
  private joyCx = 0;
  private joyCy = 0;
  private joyR = 52;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;
  private fireId = -1;
  private wepEls: HTMLElement[] = [];
  private built = false;

  /** wire up DOM listeners + build the weapon strip (call once) */
  build(): void {
    if (this.built) return;
    this.built = true;
    this.knob = $("tc-knob");
    this.buildWeapons();
    this.bindJoystick();
    this.bindLook();
    this.bindButtons();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.reset();
  }

  /** release everything (mode switch / pointer loss) */
  private reset(): void {
    this.moveX = 0; this.moveY = 0; this.sprint = false;
    this.joyId = -1; this.lookId = -1; this.fireId = -1;
    if (this.knob) this.knob.style.transform = "";
    this.onFire(false); this.onJump(false); this.onScore(false);
    for (const el of document.querySelectorAll(".tcb.on, .tc-wep.on")) el.classList.remove("on");
  }

  /** reflect the active weapon in the strip highlight */
  setWeapon(id: string): void {
    for (const el of this.wepEls) el.classList.toggle("on", el.dataset.wep === id);
  }

  private buildWeapons(): void {
    const strip = $("tc-weapons");
    strip.innerHTML = "";
    this.wepEls = [];
    LOADOUT.forEach((id, i) => {
      const b = document.createElement("button");
      b.className = "tc-wep";
      b.dataset.wep = id;
      b.innerHTML = `${WEP_SHORT[id] ?? WEAPONS[id].name}<span class="k">${i + 1}</span>`;
      // tap → select (edge-triggered on pointerdown for snappiness)
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        this.onWeapon(i);
      });
      strip.appendChild(b);
      this.wepEls.push(b);
    });
  }

  private bindJoystick(): void {
    const el = $("tc-move");
    const down = (e: PointerEvent): void => {
      if (this.joyId !== -1) return;
      e.preventDefault();
      this.joyId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      this.joyCx = r.left + r.width / 2;
      this.joyCy = r.top + r.height / 2;
      this.updateJoy(e.clientX, e.clientY);
    };
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== this.joyId) return;
      e.preventDefault();
      this.updateJoy(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = -1;
      this.moveX = 0; this.moveY = 0; this.sprint = false;
      this.knob.style.transform = "";
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private updateJoy(px: number, py: number): void {
    let dx = px - this.joyCx, dy = py - this.joyCy;
    const len = Math.hypot(dx, dy);
    const R = this.joyR;
    if (len > R) { dx = dx / len * R; dy = dy / len * R; }
    this.knob.style.transform = `translate(${dx}px,${dy}px)`;
    this.moveX = dx / R;
    this.moveY = -dy / R; // screen-up → forward
    this.sprint = len / R > 0.9;
  }

  private bindLook(): void {
    const el = $("tc-look");
    el.addEventListener("pointerdown", (e) => {
      if (this.lookId !== -1) return;
      e.preventDefault();
      this.lookId = e.pointerId;
      this.lookX = e.clientX; this.lookY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookId) return;
      e.preventDefault();
      const dx = e.clientX - this.lookX, dy = e.clientY - this.lookY;
      this.lookX = e.clientX; this.lookY = e.clientY;
      this.onLook(dx, dy);
    });
    const end = (e: PointerEvent): void => { if (e.pointerId === this.lookId) this.lookId = -1; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  private bindButtons(): void {
    this.fireButton($("tc-fire"));
    this.hold($("tc-jump"), this.onJump);
    this.hold($("tc-scores"), this.onScore);
    this.tap($("tc-reload"), () => this.onReload());
    this.tap($("tc-scope"), () => this.onScope());
    this.tap($("tc-chat"), () => this.onChat());
    this.tap($("tc-mic"), () => this.onMic());
  }

  /** Fire button that doubles as a look pad: hold to fire, and sliding the
   *  same finger without lifting keeps firing while aiming the camera — so
   *  full-auto weapons can be tracked onto a target one-thumbed. */
  private fireButton(el: HTMLElement): void {
    let fx = 0, fy = 0;
    el.addEventListener("pointerdown", (e) => {
      if (this.fireId !== -1) return;
      e.preventDefault(); e.stopPropagation();
      this.fireId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add("on");
      fx = e.clientX; fy = e.clientY;
      this.onFire(true);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.fireId) return;
      e.preventDefault();
      const dx = e.clientX - fx, dy = e.clientY - fy;
      fx = e.clientX; fy = e.clientY;
      if (dx || dy) this.onLook(dx, dy);
    });
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== this.fireId) return;
      this.fireId = -1;
      el.classList.remove("on");
      this.onFire(false);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /** press-and-hold button → callback(down) with pointer capture so release is reliable */
  private hold(el: HTMLElement, cb: (down: boolean) => void): void {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add("on");
      cb(true);
    });
    const up = (e: PointerEvent): void => {
      e.preventDefault();
      el.classList.remove("on");
      cb(false);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /** momentary tap button → fires on press, with a brief highlight */
  private tap(el: HTMLElement, cb: () => void): void {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add("on");
      cb();
    });
    const up = (): void => el.classList.remove("on");
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
  }
}
