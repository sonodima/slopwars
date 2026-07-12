// ─── User settings: graphics quality preset + aim/FOV/HUD prefs ──────────────
// Pure state + persistence + the settings-overlay DOM. Engine-agnostic: main.ts
// maps `quality` onto concrete camera/scene knobs via its own applyGraphics().
const $ = (id: string): HTMLElement => document.getElementById(id)!;

export type Quality = "low" | "medium" | "high";

export interface SettingsState {
  quality: Quality;
  sensitivity: number; // look-speed multiplier (mouse + touch)
  fov: number; // vertical FOV in degrees (hip-fire)
  showStats: boolean; // perf overlay
  aiChat: boolean; // host-only: run the on-device LLM for NPC trash-talk (Chrome built-in AI)
  aiPrompted: boolean; // whether we've already asked to download the model (gates the boot consent)
  name: string; // persisted callsign
}

const KEY = "slopwars.settings";

// aiChat defaults OFF: the model is a heavy one-time download, so it stays opt-in —
// armed either from the first-run consent prompt or the Settings toggle.
const DEFAULTS: SettingsState = { quality: "high", sensitivity: 1, fov: 75, showStats: true, aiChat: false, aiPrompted: false, name: "" };

function load(): SettingsState {
  let s: SettingsState = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt / unavailable storage */ }
  if (!s.name) s.name = "player" + ((Math.random() * 900 + 100) | 0);
  return s;
}

export class Settings {
  state: SettingsState = load();
  /** fired whenever a value changes (main.ts re-applies graphics/fov/etc.) */
  onChange: (s: SettingsState) => void = () => {};
  /** whether this browser can actually run the NPC-chat model (Chrome Prompt API).
   *  Learned asynchronously at boot; gates the toggle so it can't be armed uselessly. */
  aiSupported = false;
  private built = false;

  /** wire the overlay controls (call once, after the DOM exists) */
  build(): void {
    if (this.built) return;
    this.built = true;

    for (const b of $("set-quality").querySelectorAll("button")) {
      b.addEventListener("click", () => this.set({ quality: (b as HTMLElement).dataset.v as Quality }));
    }
    const sens = $("set-sens") as HTMLInputElement;
    sens.addEventListener("input", () => this.set({ sensitivity: parseFloat(sens.value) }));
    const fov = $("set-fov") as HTMLInputElement;
    fov.addEventListener("input", () => this.set({ fov: parseInt(fov.value, 10) }));
    $("set-stats").addEventListener("click", () => this.set({ showStats: !this.state.showStats }));
    $("set-aichat").addEventListener("click", () => {
      if (!this.aiSupported) return; // the model can't run on this browser — toggle is inert
      // any explicit use of the toggle also counts as answering the download prompt
      this.set({ aiChat: !this.state.aiChat, aiPrompted: true });
    });
    $("set-done").addEventListener("click", () => this.close());
    // tapping the dimmed backdrop (outside the panel) closes too
    $("settings").addEventListener("pointerdown", (e) => { if (e.target === $("settings")) this.close(); });

    this.refresh();
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
    ($("set-sens") as HTMLInputElement).value = String(s.sensitivity);
    ($("set-fov") as HTMLInputElement).value = String(s.fov);
    $("set-sens-val").textContent = s.sensitivity.toFixed(2);
    $("set-fov-val").textContent = String(s.fov);
    const tgl = $("set-stats");
    tgl.classList.toggle("on", s.showStats);
    tgl.setAttribute("aria-pressed", String(s.showStats));

    const ai = $("set-aichat");
    const aiOn = this.aiSupported && s.aiChat;      // only "on" where the model can run
    ai.classList.toggle("on", aiOn);
    ai.classList.toggle("disabled", !this.aiSupported);
    ai.setAttribute("aria-pressed", String(aiOn));
    const status = document.getElementById("set-aichat-status");
    if (status) status.textContent = this.aiSupported ? "" : "Not available on this browser.";
  }

  open(): void { this.refresh(); $("settings").classList.remove("hidden"); }
  close(): void { $("settings").classList.add("hidden"); }
  toggle(): void { this.isOpen() ? this.close() : this.open(); }
  isOpen(): boolean { return !$("settings").classList.contains("hidden"); }
}
