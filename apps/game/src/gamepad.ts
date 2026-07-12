// ─── Gamepad controls (Xbox / PlayStation, standard mapping) ──────────────────
// Polled once per frame from the game loop. Analog state (move / look / sprint) is
// read directly each tick like the touch stick; discrete actions fire through the
// same edge-triggered callbacks the touch pad uses, so the game state a controller
// drives is identical to keyboard/mouse and touch. Active only in "gamepad mode"
// (see main.ts input-device detection) — a connected-but-idle pad never steals input.
//
// Button layout (W3C "standard" gamepad mapping; identical Xbox/PlayStation indices):
//   Left stick  → move (push to the rim to sprint)      Right stick → look
//   RT (7)      → fire (hold)                            LT (6)      → aim / scope (toggle)
//   A/✕ (0)     → jump (hold)                            X/□ (2)     → reload
//   Y/△ (3)     → mic toggle                             LB/RB (4/5) → cycle weapon − / +
//   D-pad       → weapon slots (↑ rifle · ↓ knife · ← pistol · → AWP)
//   Back (8)    → scoreboard (hold)                      Start (9)   → pause / settings

/** radial dead-zone below which a stick reads as centred (drift rejection) */
const DEAD = 0.18;
/** look response curve exponent (>1 = finer control near centre, fast at the rim) */
const LOOK_EXP = 1.6;

export class GamepadControls {
  /** true while at least one pad is connected (drives device-mode detection) */
  connected = false;

  // analog state, polled by the game loop each tick (mirrors TouchControls)
  moveX = 0; // -1..1 (strafe: right positive)
  moveY = 0; // -1..1 (forward positive)
  sprint = false; // stick pushed near the rim
  lookX = 0; // shaped right-stick X, -1..1 (apply × rate × dt)
  lookY = 0; // shaped right-stick Y, -1..1

  // continuous callbacks (held buttons)
  onFire: (down: boolean) => void = () => {};
  onJump: (down: boolean) => void = () => {};
  onScore: (down: boolean) => void = () => {};
  // discrete taps (rising edge)
  onScope: () => void = () => {};
  onReload: () => void = () => {};
  onWeaponCycle: (dir: number) => void = () => {};
  onWeaponSelect: (i: number) => void = () => {};
  onMic: () => void = () => {};
  onPause: () => void = () => {};
  /** fresh input seen this frame (button/stick) — used to switch into gamepad mode */
  onActivity: () => void = () => {};

  private prev: boolean[] = [];

  /** poll the active pad, update analog state + emit action edges. Call every frame. */
  poll(): void {
    const pad = this.activePad();
    if (!pad) {
      if (this.connected) this.release();
      this.connected = false;
      return;
    }
    this.connected = true;

    const ax = pad.axes;
    const axis = (i: number): number => ax[i] ?? 0;

    // ── movement: left stick, radial dead-zone rescaled so control starts at the edge ──
    const [mx, my] = deadzone(axis(0), axis(1));
    this.moveX = mx;
    this.moveY = -my; // stick-up (−Y) → forward
    this.sprint = Math.hypot(mx, my) > 0.9;

    // ── look: right stick, dead-zoned then a response curve for precise aim ──
    const [rx, ry, rmag] = deadzone(axis(2), axis(3));
    if (rmag > 0) {
      const s = Math.pow(rmag, LOOK_EXP) / rmag; // reshape magnitude, keep direction
      this.lookX = rx * s;
      this.lookY = ry * s;
    } else {
      this.lookX = 0;
      this.lookY = 0;
    }

    // ── buttons: analog triggers count as pressed past half-pull ──
    const btn = pad.buttons;
    const n = btn.length;
    const pressed: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) pressed[i] = !!btn[i] && (btn[i].pressed || btn[i].value > 0.5);
    const rising = (i: number): boolean => !!pressed[i] && !this.prev[i];
    const changed = (i: number): boolean => !!pressed[i] !== !!this.prev[i];

    if (changed(7)) this.onFire(!!pressed[7]);       // RT — fire
    if (changed(0)) this.onJump(!!pressed[0]);       // A/✕ — jump
    if (changed(8)) this.onScore(!!pressed[8]);      // Back/Select — scoreboard
    if (rising(6)) this.onScope();                   // LT — aim / scope
    if (rising(2)) this.onReload();                  // X/□ — reload
    if (rising(4)) this.onWeaponCycle(-1);           // LB — previous weapon
    if (rising(5)) this.onWeaponCycle(1);            // RB — next weapon
    if (rising(12)) this.onWeaponSelect(2);          // D-pad ↑ — rifle
    if (rising(13)) this.onWeaponSelect(0);          // D-pad ↓ — knife
    if (rising(14)) this.onWeaponSelect(1);          // D-pad ← — pistol
    if (rising(15)) this.onWeaponSelect(3);          // D-pad → — AWP
    if (rising(3)) this.onMic();                     // Y/△ — mic toggle
    if (rising(9)) this.onPause();                   // Start/Options — pause

    // ── activity: any button held or a stick off-centre → this is the active device ──
    let active = Math.hypot(mx, my) > 0 || rmag > 0;
    for (let i = 0; i < n && !active; i++) if (pressed[i]) active = true;

    this.prev = pressed;
    if (active) this.onActivity();
  }

  /** first connected pad (ignores empty slots left by disconnects) */
  private activePad(): Gamepad | null {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** drop every held input (pad unplugged / mode switch) so nothing sticks down */
  release(): void {
    this.moveX = 0; this.moveY = 0; this.sprint = false;
    this.lookX = 0; this.lookY = 0;
    if (this.prev[7]) this.onFire(false);
    if (this.prev[0]) this.onJump(false);
    if (this.prev[8]) this.onScore(false);
    this.prev = [];
  }
}

/** radial dead-zone: returns [x, y, magnitude] rescaled so travel begins at the edge
 *  of the zone (no snap) and clamps to a unit circle. Centred input returns zeros. */
function deadzone(x: number, y: number): [number, number, number] {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0, 0];
  const scaled = Math.min(1, (m - DEAD) / (1 - DEAD)); // 0 at edge → 1 at rim
  const k = scaled / m;
  return [x * k, y * k, scaled];
}
