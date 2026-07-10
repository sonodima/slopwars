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
  name: string; // persisted callsign
}

const KEY = "slopwars.settings";

const DEFAULTS: SettingsState = { quality: "high", sensitivity: 1, fov: 75, showStats: true, name: "" };

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
  }

  open(): void { this.refresh(); $("settings").classList.remove("hidden"); }
  close(): void { $("settings").classList.add("hidden"); }
  toggle(): void { this.isOpen() ? this.close() : this.open(); }
  isOpen(): boolean { return !$("settings").classList.contains("hidden"); }
}
