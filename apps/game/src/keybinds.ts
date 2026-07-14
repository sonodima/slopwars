// ─── Remappable input bindings (keyboard + gamepad) ──────────────────────────
// The default control scheme is expressed here as data, and every key/button the
// game reads at runtime is resolved through the player's (possibly customized)
// bindings — so a player can rebind movement, actions and weapon slots from
// Settings without touching game code. Keyboard bindings are `KeyboardEvent.code`
// strings; gamepad bindings are W3C "standard" button indices (Xbox/PlayStation
// share the layout). Persisted inside Settings.

export type KeyAction =
  | "forward" | "back" | "left" | "right" | "jump" | "sprint"
  | "reload" | "chat" | "mic" | "scoreboard" | "loadout"
  | "weapon1" | "weapon2" | "weapon3" | "weapon4" | "weapon5" | "weapon6";

export type PadAction =
  | "fire" | "jump" | "scope" | "reload"
  | "weaponPrev" | "weaponNext" | "mic" | "scoreboard" | "pause";

export interface BindDef<A extends string> { action: A; label: string }

/** keyboard actions in the order they appear in the Settings remap list */
export const KEY_ACTIONS: BindDef<KeyAction>[] = [
  { action: "forward", label: "Move forward" },
  { action: "back", label: "Move back" },
  { action: "left", label: "Strafe left" },
  { action: "right", label: "Strafe right" },
  { action: "jump", label: "Jump" },
  { action: "sprint", label: "Sprint" },
  { action: "reload", label: "Reload" },
  { action: "scoreboard", label: "Scoreboard (hold)" },
  { action: "loadout", label: "Loadout / class" },
  { action: "chat", label: "Chat" },
  { action: "mic", label: "Toggle mic" },
  { action: "weapon1", label: "Weapon 1 · knife" },
  { action: "weapon2", label: "Weapon 2 · pistol" },
  { action: "weapon3", label: "Weapon 3 · rifle" },
  { action: "weapon4", label: "Weapon 4 · sniper" },
  { action: "weapon5", label: "Weapon 5 · grenade" },
  { action: "weapon6", label: "Weapon 6 · molotov" },
];

export const DEFAULT_KEYS: Record<KeyAction, string> = {
  forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", jump: "Space", sprint: "ShiftLeft",
  reload: "KeyR", chat: "KeyT", mic: "KeyV", scoreboard: "Tab", loadout: "KeyL",
  weapon1: "Digit1", weapon2: "Digit2", weapon3: "Digit3", weapon4: "Digit4", weapon5: "Digit5", weapon6: "Digit6",
};

/** gamepad actions in the order they appear in the Settings remap list */
export const PAD_ACTIONS: BindDef<PadAction>[] = [
  { action: "fire", label: "Fire" },
  { action: "jump", label: "Jump" },
  { action: "scope", label: "Aim / scope" },
  { action: "reload", label: "Reload" },
  { action: "weaponPrev", label: "Prev weapon" },
  { action: "weaponNext", label: "Next weapon" },
  { action: "mic", label: "Toggle mic" },
  { action: "scoreboard", label: "Scoreboard (hold)" },
  { action: "pause", label: "Pause / settings" },
];

// W3C standard mapping button indices (see gamepad.ts header)
export const DEFAULT_PADS: Record<PadAction, number> = {
  fire: 7, jump: 0, scope: 6, reload: 2, weaponPrev: 4, weaponNext: 5, mic: 3, scoreboard: 8, pause: 9,
};

/** which weapon slot (0-based) a key action selects, or -1 if it isn't a weapon key */
export function weaponSlot(action: KeyAction | null): number {
  if (!action) return -1;
  const m = /^weapon([1-6])$/.exec(action);
  return m ? Number(m[1]) - 1 : -1;
}

// ── pretty labels ─────────────────────────────────────────────────────────────

const KEY_NAMES: Record<string, string> = {
  Space: "Space", ShiftLeft: "L-Shift", ShiftRight: "R-Shift", ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl",
  AltLeft: "L-Alt", AltRight: "R-Alt", Tab: "Tab", Enter: "Enter", Backquote: "`", Escape: "Esc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", CapsLock: "Caps",
};

/** friendly label for a KeyboardEvent.code (KeyW → "W", Digit1 → "1", …) */
export function keyLabel(code: string): string {
  if (!code) return "—";
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code); if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code); if (m) return `Num ${m[1]}`;
  m = /^F([0-9]{1,2})$/.exec(code); if (m) return code;
  return code;
}

// Xbox-style button names for the standard-mapping indices
const PAD_NAMES: Record<number, string> = {
  0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB", 6: "LT", 7: "RT",
  8: "View", 9: "Menu", 10: "L-Stick", 11: "R-Stick",
  12: "D-Up", 13: "D-Down", 14: "D-Left", 15: "D-Right", 16: "Guide",
};

/** friendly label for a gamepad button index (Xbox naming) */
export function padLabel(index: number): string {
  return index < 0 ? "—" : (PAD_NAMES[index] ?? `B${index}`);
}
