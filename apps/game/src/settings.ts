// ─── User settings: graphics quality preset + aim/FOV/HUD prefs + key bindings ─
// Pure state + persistence + the settings-overlay DOM. Engine-agnostic: main.ts
// maps `quality` onto concrete camera/scene knobs via its own applyGraphics(), and
// reads the (remappable) key/pad bindings when interpreting input.
import type { ShadowQuality } from "@slopwars/shared";
import {
  DEFAULT_KEYS, DEFAULT_PADS, KEY_ACTIONS, KeyAction, keyLabel, PAD_ACTIONS, PadAction, padLabel,
} from "./keybinds";
import { syncRanges } from "./range";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// "custom" = the player touched an individual knob; presets are just knob batches.
// (An old client reading persisted "custom" falls through its ternaries to the high
// branch — graceful, so the union widening needs no storage migration.)
export type Quality = "low" | "medium" | "high" | "custom";
export type Msaa = 0 | 2 | 4;

export interface SettingsState {
  quality: Quality;
  msaa: Msaa; // camera MSAA samples
  hdr: boolean; // HDR rendering
  post: boolean; // post-processing (bloom/tonemap — their *look* stays map-authored)
  weather: boolean; // atmospheric FX (volumetric clouds/mist/rays/rain — look stays map-authored)
  shadowCap: ShadowQuality; // ceiling on the map's authored shadow tier
  renderScale: number; // render-buffer scale 0.5–1 (multiplies the device DPR cap)
  sensitivity: number; // mouse + touch look-speed multiplier
  padSensitivity: number; // controller (right-stick) look-speed multiplier
  invertY: boolean; // invert the vertical look axis (mouse + controller)
  fov: number; // vertical FOV in degrees (hip-fire)
  aimAssist: boolean; // controller + touch aim assist on/off (ignored for mouse+keyboard)
  showStats: boolean; // perf overlay
  aiChat: boolean; // host-only: run the on-device LLM for NPC trash-talk (Chrome built-in AI)
  aiPrompted: boolean; // whether we've already asked to download the model (gates the boot consent)
  name: string; // persisted callsign
  loadoutClass: string; // chosen loadout class id (classes.ts) — applied each FFA/TDM spawn
  keys: Partial<Record<KeyAction, string>>; // keyboard rebindings (over DEFAULT_KEYS)
  pads: Partial<Record<PadAction, number>>; // gamepad button rebindings (over DEFAULT_PADS)
}

/** what each preset means in knobs — the single source for preset clicks AND for
 *  migrating pre-granular storage (which persisted only `quality`) */
export const PRESETS: Record<Exclude<Quality, "custom">, Pick<SettingsState, "msaa" | "hdr" | "post" | "weather" | "shadowCap" | "renderScale">> = {
  low:    { msaa: 0, hdr: false, post: false, weather: false, shadowCap: "off",    renderScale: 0.6 },
  medium: { msaa: 2, hdr: true,  post: true,  weather: true,  shadowCap: "medium", renderScale: 0.85 },
  high:   { msaa: 4, hdr: true,  post: true,  weather: true,  shadowCap: "ultra",  renderScale: 1 },
};

const KEY = "slopwars.settings";

// aiChat defaults OFF: the model is a heavy one-time download, so it stays opt-in —
// armed either from the first-run consent prompt or the Settings toggle.
// aimAssist defaults ON: it's a comfort feature for controller/touch players and does
// nothing on mouse+keyboard, so there's no downside to shipping it enabled.
const DEFAULTS: SettingsState = {
  quality: "high", ...PRESETS.high, sensitivity: 1, padSensitivity: 1, invertY: false, fov: 75, aimAssist: true,
  showStats: true, aiChat: false, aiPrompted: false, name: "", loadoutClass: "assault", keys: {}, pads: {},
};

function load(): SettingsState {
  let s: SettingsState = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SettingsState>;
      s = { ...DEFAULTS, ...parsed };
      // pre-granular storage carried only `quality` — derive the knobs it implied
      if (parsed.msaa === undefined && parsed.quality && parsed.quality !== "custom") {
        Object.assign(s, PRESETS[parsed.quality] ?? PRESETS.high);
      }
    }
  } catch { /* ignore corrupt / unavailable storage */ }
  // clamp knobs: the forgiving merge above happily admits garbage from old/edited storage
  if (!["low", "medium", "high", "custom"].includes(s.quality)) s.quality = "high";
  if (![0, 2, 4].includes(s.msaa)) s.msaa = 4;
  if (!["off", "low", "medium", "high", "ultra"].includes(s.shadowCap)) s.shadowCap = "ultra";
  s.renderScale = Math.min(1, Math.max(0.5, Number(s.renderScale) || 1));
  s.hdr = !!s.hdr;
  s.post = !!s.post;
  if (typeof s.weather !== "boolean") s.weather = true; // pre-weather storage → on

  if (!s.keys || typeof s.keys !== "object") s.keys = {};
  if (!s.pads || typeof s.pads !== "object") s.pads = {};
  if (!s.name) s.name = "player" + ((Math.random() * 900 + 100) | 0);
  return s;
}

export class Settings {
  state: SettingsState = load();
  /** fired whenever a value changes (main.ts re-applies graphics/fov/bindings/etc.) */
  onChange: (s: SettingsState) => void = () => {};
  /** request a single gamepad-button capture; returns a cancel fn. Wired by main.ts (it
   *  owns the pad poll). Called when the player clicks a controller binding to rebind it. */
  onCapturePad: ((done: (index: number) => void) => (() => void)) | null = null;
  /** whether this browser can actually run the NPC-chat model (Chrome Prompt API).
   *  Learned asynchronously at boot; gates the toggle so it can't be armed uselessly. */
  aiSupported = false;
  private built = false;
  /** active rebind in progress (row highlighted, waiting for input), or null */
  private capturing: { device: "key" | "pad"; action: string } | null = null;
  private cancelCapture: (() => void) | null = null;

  // ── resolved bindings (state override → default) ──
  keyCode(a: KeyAction): string { return this.state.keys[a] ?? DEFAULT_KEYS[a]; }
  padButton(a: PadAction): number { return this.state.pads[a] ?? DEFAULT_PADS[a]; }
  /** the key action a code is currently bound to (reverse lookup), or null */
  keyActionFor(code: string): KeyAction | null {
    for (const { action } of KEY_ACTIONS) if (this.keyCode(action) === code) return action;
    return null;
  }
  /** current gamepad button index → action map (for gamepad.ts) */
  padBinds(): Record<PadAction, number> {
    const out = {} as Record<PadAction, number>;
    for (const { action } of PAD_ACTIONS) out[action] = this.padButton(action);
    return out;
  }

  /** wire the overlay controls (call once, after the DOM exists) */
  build(): void {
    if (this.built) return;
    this.built = true;

    // sub-page tabs (Video / Input / Controls / AI)
    for (const b of $("set-tabs").querySelectorAll("button")) {
      b.addEventListener("click", () => this.showPage((b as HTMLElement).dataset.tab!));
    }
    for (const b of $("set-quality").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        const q = (b as HTMLElement).dataset.v as Quality;
        // a preset click batches all its knobs in ONE set(); "custom" just labels
        // the current hand-picked knobs (clicking it changes nothing else)
        this.set(q === "custom" ? { quality: q } : { quality: q, ...PRESETS[q] });
      });
    }
    // individual knobs: any edit flips the preset to "custom" in the same patch
    for (const b of $("set-msaa").querySelectorAll("button")) {
      b.addEventListener("click", () => this.set({ quality: "custom", msaa: Number((b as HTMLElement).dataset.v) as Msaa }));
    }
    for (const b of $("set-shadows").querySelectorAll("button")) {
      b.addEventListener("click", () => this.set({ quality: "custom", shadowCap: (b as HTMLElement).dataset.v as ShadowQuality }));
    }
    $("set-hdr").addEventListener("click", () => this.set({ quality: "custom", hdr: !this.state.hdr }));
    $("set-post").addEventListener("click", () => this.set({ quality: "custom", post: !this.state.post }));
    $("set-weather").addEventListener("click", () => this.set({ quality: "custom", weather: !this.state.weather }));
    const scale = $("set-scale") as HTMLInputElement;
    // label live while dragging, but apply on release only: every apply reallocates
    // the render buffer, and a drag fires dozens of input events per second
    scale.addEventListener("input", () => { $("set-scale-val").textContent = `${Math.round(parseFloat(scale.value) * 100)}%`; });
    scale.addEventListener("change", () => this.set({ quality: "custom", renderScale: parseFloat(scale.value) }));

    // Fullscreen is a stateless ACTION, not a persisted setting: requestFullscreen
    // needs a user gesture (can't re-apply at boot) and Esc/F11 would desync a stored
    // value. Hidden where the API is missing (iOS) and on app:// (the desktop shell
    // manages an OS-fullscreen window; F11 lives there).
    const fsBtn = $("set-fullscreen");
    const fsRow = fsBtn.closest(".set-toggle") as HTMLElement;
    if (!document.documentElement.requestFullscreen || location.protocol === "app:") {
      fsRow.classList.add("hidden");
    } else {
      const fsLabel = (): void => { fsBtn.textContent = document.fullscreenElement ? "exit" : "enter"; };
      fsBtn.addEventListener("click", () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => { /* gesture/permission denied */ });
      });
      document.addEventListener("fullscreenchange", fsLabel);
      fsLabel();
    }
    $("set-ver").textContent = `v${__PKG_VERSION__} · ${__GAME_VERSION__}`;

    const sens = $("set-sens") as HTMLInputElement;
    sens.addEventListener("input", () => this.set({ sensitivity: parseFloat(sens.value) }));
    const padSens = $("set-padsens") as HTMLInputElement;
    padSens.addEventListener("input", () => this.set({ padSensitivity: parseFloat(padSens.value) }));
    const fov = $("set-fov") as HTMLInputElement;
    fov.addEventListener("input", () => this.set({ fov: parseInt(fov.value, 10) }));
    $("set-invert").addEventListener("click", () => this.set({ invertY: !this.state.invertY }));
    $("set-aim").addEventListener("click", () => this.set({ aimAssist: !this.state.aimAssist }));
    $("set-stats").addEventListener("click", () => this.set({ showStats: !this.state.showStats }));
    $("set-aichat").addEventListener("click", () => {
      if (!this.aiSupported) return; // the model can't run on this browser — toggle is inert
      // any explicit use of the toggle also counts as answering the download prompt
      this.set({ aiChat: !this.state.aiChat, aiPrompted: true });
    });
    $("set-done").addEventListener("click", () => this.close());
    // tapping the dimmed backdrop (outside the panel) closes too
    $("settings").addEventListener("pointerdown", (e) => { if (e.target === $("settings")) this.close(); });

    this.buildBindings();
    this.refresh();
  }

  // ── key/pad rebinding UI ───────────────────────────────────────────────────
  /** one-time construction of the keyboard + gamepad binding rows + their listeners */
  private buildBindings(): void {
    const rows = (id: string, defs: { action: string; label: string }[], device: "key" | "pad"): void => {
      $(id).innerHTML = defs.map((d) =>
        `<div class="bind-row" data-action="${d.action}"><span class="bind-label">${d.label}</span>` +
        `<button class="bind-key" data-device="${device}" data-action="${d.action}"></button></div>`).join("");
    };
    rows("set-keybinds", KEY_ACTIONS, "key");
    rows("set-padbinds", PAD_ACTIONS, "pad");
    // delegate clicks on any binding button → start capturing a new key/button for it
    const wire = (id: string): void => {
      $(id).addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".bind-key") as HTMLElement | null;
        if (btn) this.beginRebind(btn.dataset.device as "key" | "pad", btn.dataset.action!);
      });
    };
    wire("set-keybinds");
    wire("set-padbinds");
    $("set-keys-reset").addEventListener("click", () => { this.cancelRebind(); this.set({ keys: {} }); });
    $("set-pads-reset").addEventListener("click", () => { this.cancelRebind(); this.set({ pads: {} }); });
  }

  /** switch the visible settings sub-page; leaving Controls aborts any pending rebind */
  private showPage(tab: string): void {
    this.cancelRebind();
    const tabs = $("set-tabs");
    const btns = tabs.querySelectorAll("button");
    btns.forEach((b, i) => {
      const on = (b as HTMLElement).dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      if (on) tabs.style.setProperty("--i", String(i)); // slides the lit block onto this segment
    });
    tabs.style.setProperty("--n", String(btns.length));
    for (const p of document.querySelectorAll<HTMLElement>("#settings .set-page")) {
      p.classList.toggle("hidden", p.dataset.page !== tab);
    }
  }

  /** begin capturing a replacement key/button for `action`. Escape (or picking again)
   *  cancels. Persists on the first valid input, then re-renders. */
  private beginRebind(device: "key" | "pad", action: string): void {
    this.cancelRebind();
    this.capturing = { device, action };
    this.refresh();
    if (device === "key") {
      const onKey = (e: KeyboardEvent): void => {
        e.preventDefault();
        e.stopImmediatePropagation(); // never let the rebind keystroke reach the game
        if (e.code !== "Escape") this.set({ keys: { ...this.state.keys, [action]: e.code } });
        this.finishRebind(onKey);
      };
      window.addEventListener("keydown", onKey, { capture: true });
      this.cancelCapture = () => window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    } else {
      const cancel = this.onCapturePad?.((index) => {
        this.set({ pads: { ...this.state.pads, [action]: index } });
        this.finishRebind();
      });
      this.cancelCapture = cancel ?? null;
    }
  }

  private finishRebind(onKey?: (e: KeyboardEvent) => void): void {
    if (onKey) window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    this.cancelCapture = null;
    this.capturing = null;
    this.refresh();
  }

  /** abort any in-progress capture without changing a binding */
  private cancelRebind(): void {
    if (this.cancelCapture) { this.cancelCapture(); this.cancelCapture = null; }
    if (this.capturing) { this.capturing = null; this.refresh(); }
  }

  private set(patch: Partial<SettingsState>): void {
    this.state = { ...this.state, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* ignore */ }
    this.refresh();
    this.onChange(this.state);
  }

  /** reflect on-device model support once probing resolves: disable the toggle and
   *  surface a "not available" note when the feature can't run on this browser. */
  setAiSupported(supported: boolean): void {
    this.aiSupported = supported;
    this.refresh();
  }

  /** set the NPC-AI-chat intent (from the first-run consent prompt). Marks the prompt
   *  as answered so it never auto-shows again, and fires onChange like any other edit. */
  setAiChat(on: boolean): void {
    this.set({ aiChat: on, aiPrompted: true });
  }

  /** persist the chosen loadout class (classes.ts id). Fires onChange so the player's
   *  live weapon system + HUD can re-apply the kit. */
  setLoadoutClass(id: string): void {
    this.set({ loadoutClass: id });
  }

  /** persist an edited callsign (trimmed to 16 chars, never blank in storage) */
  setName(v: string): void {
    this.state = { ...this.state, name: v.slice(0, 16) };
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* ignore */ }
  }

  /** push current state into the controls */
  private refresh(): void {
    const s = this.state;
    for (const b of $("set-quality").querySelectorAll("button")) {
      b.classList.toggle("on", (b as HTMLElement).dataset.v === s.quality);
    }
    for (const b of $("set-msaa").querySelectorAll("button")) {
      b.classList.toggle("on", Number((b as HTMLElement).dataset.v) === s.msaa);
    }
    for (const b of $("set-shadows").querySelectorAll("button")) {
      b.classList.toggle("on", (b as HTMLElement).dataset.v === s.shadowCap);
    }
    this.toggleBtn("set-hdr", s.hdr);
    this.toggleBtn("set-post", s.post);
    this.toggleBtn("set-weather", s.weather);
    ($("set-scale") as HTMLInputElement).value = String(s.renderScale);
    $("set-scale-val").textContent = `${Math.round(s.renderScale * 100)}%`;
    ($("set-sens") as HTMLInputElement).value = String(s.sensitivity);
    ($("set-padsens") as HTMLInputElement).value = String(s.padSensitivity);
    ($("set-fov") as HTMLInputElement).value = String(s.fov);
    $("set-sens-val").textContent = s.sensitivity.toFixed(2);
    $("set-padsens-val").textContent = s.padSensitivity.toFixed(2);
    $("set-fov-val").textContent = String(s.fov);
    syncRanges(); // assigning .value above fires no input event, so light the rails by hand

    this.toggleBtn("set-invert", s.invertY);
    this.toggleBtn("set-aim", s.aimAssist);
    this.toggleBtn("set-stats", s.showStats);
    this.refreshBindings();

    const ai = $("set-aichat");
    const aiOn = this.aiSupported && s.aiChat;      // only "on" where the model can run
    ai.classList.toggle("on", aiOn);
    ai.classList.toggle("disabled", !this.aiSupported);
    ai.setAttribute("aria-pressed", String(aiOn));
    const status = document.getElementById("set-aichat-status");
    if (status) status.textContent = this.aiSupported ? "" : "Not available on this browser.";
  }

  private toggleBtn(id: string, on: boolean): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", String(on));
  }

  /** paint each binding button with its current key/button label (or "press…" while
   *  that row is capturing a replacement) */
  private refreshBindings(): void {
    for (const { action } of KEY_ACTIONS) {
      const btn = document.querySelector<HTMLElement>(`#set-keybinds .bind-key[data-action="${action}"]`);
      if (!btn) continue;
      const cap = this.capturing?.device === "key" && this.capturing.action === action;
      btn.textContent = cap ? "press a key…" : keyLabel(this.keyCode(action));
      btn.classList.toggle("capturing", cap);
    }
    for (const { action } of PAD_ACTIONS) {
      const btn = document.querySelector<HTMLElement>(`#set-padbinds .bind-key[data-action="${action}"]`);
      if (!btn) continue;
      const cap = this.capturing?.device === "pad" && this.capturing.action === action;
      btn.textContent = cap ? "press a button…" : padLabel(this.padButton(action));
      btn.classList.toggle("capturing", cap);
    }
  }

  open(): void { this.refresh(); $("settings").classList.remove("hidden"); }
  /** open directly on a sub-page (e.g. the low-fps alert jumps to "video") */
  openPage(tab: string): void { this.open(); this.showPage(tab); }
  close(): void { this.cancelRebind(); $("settings").classList.add("hidden"); }
  toggle(): void { this.isOpen() ? this.close() : this.open(); }
  isOpen(): boolean { return !$("settings").classList.contains("hidden"); }
}
