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

export type GamepadMode = "game" | "menu";

export class GamepadControls {
  /** true while at least one pad is connected (drives device-mode detection) */
  connected = false;
  /** "game" drives the FPS; "menu" drives DOM focus navigation. Set by main each frame. */
  mode: GamepadMode = "game";

  // analog state, polled by the game loop each tick (mirrors TouchControls). Zeroed in
  // menu mode so a resting stick never leaks into movement while a menu is open.
  moveX = 0; // -1..1 (strafe: right positive)
  moveY = 0; // -1..1 (forward positive)
  sprint = false; // stick pushed near the rim
  lookX = 0; // shaped right-stick X, -1..1 (apply × rate × dt)
  lookY = 0; // shaped right-stick Y, -1..1

  // ── game-mode callbacks ──
  onFire: (down: boolean) => void = () => {};   // held
  onJump: (down: boolean) => void = () => {};   // held
  onScore: (down: boolean) => void = () => {};  // held
  onScope: () => void = () => {};               // rising edge
  onReload: () => void = () => {};
  onWeaponCycle: (dir: number) => void = () => {};
  onWeaponSelect: (i: number) => void = () => {};
  onMic: () => void = () => {};
  // ── menu-mode callbacks (DOM navigation) ──
  onNavigate: (dir: number) => void = () => {}; // −1 up / +1 down (D-pad / left stick Y, auto-repeat)
  onAdjust: (dir: number) => void = () => {};   // −1 left / +1 right (D-pad / left stick X, auto-repeat)
  onConfirm: () => void = () => {};             // A/✕
  onBack: () => void = () => {};                // B/○
  // ── both modes ──
  onPause: () => void = () => {};               // Start/Options
  /** fresh input seen this frame (button/stick) — used to switch into gamepad mode */
  onActivity: () => void = () => {};

  private prev: boolean[] = [];
  private prevMode: GamepadMode = "game";
  // auto-repeat state for held menu navigation directions (X = ←/→, Y = ↑/↓)
  private repeat: Record<"x" | "y", { dir: number; next: number }> = {
    x: { dir: 0, next: 0 }, y: { dir: 0, next: 0 },
  };

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

    // ── analog sticks: movement + look — only meaningful in game mode ──
    const [mx, my] = deadzone(axis(0), axis(1));
    const [rx, ry, rmag] = deadzone(axis(2), axis(3));
    if (this.mode === "game") {
      this.moveX = mx;
      this.moveY = -my; // stick-up (−Y) → forward
      this.sprint = Math.hypot(mx, my) > 0.9;
      if (rmag > 0) {
        const s = Math.pow(rmag, LOOK_EXP) / rmag; // reshape magnitude, keep direction
        this.lookX = rx * s;
        this.lookY = ry * s;
      } else { this.lookX = 0; this.lookY = 0; }
    } else {
      this.moveX = 0; this.moveY = 0; this.sprint = false; this.lookX = 0; this.lookY = 0;
    }

    // ── buttons: analog triggers count as pressed past half-pull ──
    const btn = pad.buttons;
    const n = btn.length;
    const pressed: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) pressed[i] = !!btn[i] && (btn[i].pressed || btn[i].value > 0.5);
    const rising = (i: number): boolean => !!pressed[i] && !this.prev[i];
    const changed = (i: number): boolean => !!pressed[i] !== !!this.prev[i];

    // leaving game mode with something held (e.g. pausing mid-fire) must release it,
    // or the held action sticks on under the open menu.
    if (this.mode !== this.prevMode) {
      if (this.mode === "menu") {
        if (this.prev[7]) this.onFire(false);
        if (this.prev[0]) this.onJump(false);
        if (this.prev[8]) this.onScore(false);
      }
      this.prevMode = this.mode;
      this.repeat.x.dir = 0; this.repeat.y.dir = 0;
    }

    if (rising(9)) this.onPause();                   // Start/Options — pause (both modes)

    if (this.mode === "game") {
      if (changed(7)) this.onFire(!!pressed[7]);     // RT — fire
      if (changed(0)) this.onJump(!!pressed[0]);     // A/✕ — jump
      if (changed(8)) this.onScore(!!pressed[8]);    // Back/Select — scoreboard
      if (rising(6)) this.onScope();                 // LT — aim / scope
      if (rising(2)) this.onReload();                // X/□ — reload
      if (rising(4)) this.onWeaponCycle(-1);         // LB — previous weapon
      if (rising(5)) this.onWeaponCycle(1);          // RB — next weapon
      if (rising(12)) this.onWeaponSelect(2);        // D-pad ↑ — rifle
      if (rising(13)) this.onWeaponSelect(0);        // D-pad ↓ — knife
      if (rising(14)) this.onWeaponSelect(1);        // D-pad ← — pistol
      if (rising(15)) this.onWeaponSelect(3);        // D-pad → — AWP
      if (rising(3)) this.onMic();                   // Y/△ — mic toggle
    } else {
      // ── menu navigation: A confirm, B back, D-pad / left stick move focus ──
      if (rising(0)) this.onConfirm();               // A/✕ — activate
      if (rising(1)) this.onBack();                  // B/○ — back / close
      const dpadY = (pressed[13] ? 1 : 0) - (pressed[12] ? 1 : 0);
      const dpadX = (pressed[15] ? 1 : 0) - (pressed[14] ? 1 : 0);
      const dy = dpadY || (my > 0.6 ? 1 : my < -0.6 ? -1 : 0);
      const dx = dpadX || (mx > 0.6 ? 1 : mx < -0.6 ? -1 : 0);
      const now = performance.now();
      if (this.repeatDir("y", dy, now)) this.onNavigate(dy);
      if (this.repeatDir("x", dx, now)) this.onAdjust(dx);
    }

    // ── activity: any button held or a stick off-centre → this is the active device ──
    let active = Math.hypot(mx, my) > 0 || rmag > 0;
    for (let i = 0; i < n && !active; i++) if (pressed[i]) active = true;

    this.prev = pressed;
    if (active) this.onActivity();
  }

  /** debounced auto-repeat for a held navigation direction: fires once on press, then
   *  again after an initial delay, then at a steady cadence while held. */
  private repeatDir(key: "x" | "y", dir: number, now: number): boolean {
    const st = this.repeat[key];
    if (dir === 0) { st.dir = 0; st.next = 0; return false; }
    if (dir !== st.dir) { st.dir = dir; st.next = now + 380; return true; } // fresh press
    if (now >= st.next) { st.next = now + 130; return true; }               // held → repeat
    return false;
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
    this.repeat.x.dir = 0; this.repeat.y.dir = 0;
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
