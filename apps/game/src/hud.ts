// ─── DOM HUD & screens ───────────────────────────────────────────────────────
import { BOT_LEVELS, BotLevel, CFG_BOUNDS, DeathCause, deathCauseLabel, GameSnapshot, MatchConfig, ModeId, Platform, PlayerInfo, WEAPONS, WeaponId } from "./types";
import { MapMeta } from "./maps/schema";
import { MODES, MODE_LIST } from "./modes";
import { CLASSES, CLASS_LIST, ClassDef } from "./classes";
import { syncRange } from "./range";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

// ── input-device icons (shown next to players in lists / leaderboards) ──
// Inline SVGs so they inherit currentColor + need no extra asset fetch.
const PLATFORM_ICON: Record<Platform, string> = {
  keyboard: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  gamepad: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8.5h11a3.5 3.5 0 0 1 3.45 2.9l.8 4.6A2.3 2.3 0 0 1 17.4 17L15 14.5H9L6.6 17a2.3 2.3 0 0 1-4.15-1l.8-4.6A3.5 3.5 0 0 1 6.5 8.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 11.3v2.4M5.8 12.5h2.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16" cy="11.6" r="1.05" fill="currentColor"/><circle cx="17.8" cy="13.6" r="1.05" fill="currentColor"/></svg>`,
  touch: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 11V5.2a1.6 1.6 0 0 1 3.2 0V11l3.2.9a2.1 2.1 0 0 1 1.5 2.4l-.6 3.4A3.6 3.6 0 0 1 14.7 21H12a3.6 3.6 0 0 1-2.55-1.05L6 16.5a1.55 1.55 0 0 1 2.2-2.2l1.8 1.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  bot: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="11.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 4.2v3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="3.6" r="1.3" fill="currentColor"/><circle cx="9.3" cy="13" r="1.35" fill="currentColor"/><circle cx="14.7" cy="13" r="1.35" fill="currentColor"/><path d="M9.5 16.6h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
};
const PLATFORM_LABEL: Record<Platform, string> = {
  keyboard: "Keyboard & mouse", gamepad: "Gamepad", touch: "Touch", bot: "AI bot",
};

/** small input-device icon markup for a player, or "" when their device is unknown */
function platIcon(p?: Platform): string {
  if (!p || !PLATFORM_ICON[p]) return "";
  return `<span class="plat plat-${p}" title="${PLATFORM_LABEL[p]}" aria-label="${PLATFORM_LABEL[p]}">${PLATFORM_ICON[p]}</span>`;
}

export class Hud {
  onCreate: ((name: string) => void) | null = null;
  onChat: ((txt: string) => void) | null = null;
  chatOpen = false;
  onJoin: ((code: string, name: string) => void) | null = null;
  onStart: (() => void) | null = null;
  onPlayAgain: (() => void) | null = null;
  onVote: ((mapId: string) => void) | null = null;
  /** host picked the round-1 starting map in the lobby */
  onStartMap: ((mapId: string) => void) | null = null;
  onMode: ((mode: ModeId) => void) | null = null;
  onCfg: ((patch: Partial<MatchConfig>) => void) | null = null;
  onHome: (() => void) | null = null;
  /** player picked a class off the death-screen strip (deploys on respawn) */
  onClass: ((id: string) => void) | null = null;
  /** first-run consent: user chose whether to download the on-device NPC-AI model. */
  onAiConsent: ((accept: boolean) => void) | null = null;

  private hitTtl = 0;
  private dmgTtl = 0;

  // ── NPC-AI model download toast ──
  private aiDlStart = 0;          // wall-clock ms the download began (for the ETA)
  private aiDlDismissed = false;  // user hit × — never re-surface this session
  private aiDlDoneTimer = 0;      // auto-dismiss timer id for the success state

  constructor() {
    $("btn-create").onclick = () => this.onCreate?.(this.name());
    $("btn-join").onclick = () => {
      const c = ($("inp-code") as HTMLInputElement).value.trim();
      if (c.length >= 4) this.onJoin?.(c, this.name());
    };
    $("btn-start").onclick = () => this.onStart?.();
    $("btn-again").onclick = () => this.onPlayAgain?.();
    $("btn-home").onclick = () => this.onHome?.();

    // host: reveal the optional match-rules (collapsed by default)
    $("lobby-adv-toggle").onclick = () => {
      const collapsed = $("lobby-rules").classList.toggle("collapsed");
      $("lobby-adv-toggle").textContent = collapsed ? "Match settings ▾" : "Match settings ▴";
    };

    const inp = $("chat-inp") as HTMLInputElement;
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Enter") {
        const v = inp.value.trim();
        if (v) this.onChat?.(v.slice(0, 120));
        this.closeChat();
      } else if (e.code === "Escape") this.closeChat();
    });

    $("ai-dl-x").onclick = () => this.hideAiDownload();
    $("ai-consent-yes").onclick = () => { this.hideAiConsent(); this.onAiConsent?.(true); };
    $("ai-consent-no").onclick = () => { this.hideAiConsent(); this.onAiConsent?.(false); };
  }

  openChat(): void {
    this.chatOpen = true;
    $("chat-bar").classList.remove("hidden");
    const inp = $("chat-inp") as HTMLInputElement;
    inp.value = "";
    setTimeout(() => inp.focus(), 0);
  }

  closeChat(): void {
    this.chatOpen = false;
    $("chat-bar").classList.add("hidden");
    ($("chat-inp") as HTMLInputElement).blur();
  }

  chatMsg(name: string, color: number, txt: string): void {
    const feed = $("chatfeed");
    const el = document.createElement("div");
    el.className = "cm";
    el.innerHTML = `<b style="color:#${color.toString(16).padStart(6, "0")}">${esc(name)}</b> ${esc(txt)}`;
    feed.appendChild(el);
    while (feed.children.length > 7) feed.firstChild?.remove();
    setTimeout(() => el.remove(), 12000);
  }

  voice(state: "on" | "muted" | "off"): void {
    const e = $("voice");
    e.textContent = state === "on" ? "🎙 voice on · V" : state === "muted" ? "🎙 muted · V" : "🎙 voice off · V";
    e.classList.toggle("off", state !== "on");
    // touch: the standalone indicator is hidden; reflect state on the mic button
    const mic = document.getElementById("tc-mic");
    if (mic) {
      mic.classList.toggle("mic-on", state === "on");
      mic.classList.toggle("mic-muted", state === "muted");
    }
  }

  private name(): string {
    return (($("inp-name") as HTMLInputElement).value || "player").slice(0, 16);
  }

  show(screen: "loading" | "menu" | "lobby" | "game" | "end"): void {
    for (const s of ["loading", "menu", "lobby", "game", "end"]) $(`scr-${s}`).classList.toggle("hidden", s !== screen);
    document.body.dataset.screen = screen; // drives the portrait rotate-hint (touch)
  }

  loadingProgress(frac: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    $("load-bar").style.width = `${pct}%`;
  }

  /** name of the asset currently being fetched — appended to the boot log that
   *  sits behind the wordmark (keep only the last handful of lines) */
  loadingLabel(name: string): void {
    const log = $("load-log");
    if (log.lastElementChild?.textContent === name) return; // de-dupe repeats
    const line = document.createElement("div");
    line.className = "ll";
    line.textContent = name;
    log.appendChild(line);
    // let the log grow to fill the page, then scroll: drop the oldest line only
    // once the stack overflows the viewport height
    while (log.childElementCount > 1 && log.scrollHeight > log.clientHeight)
      log.firstElementChild!.remove();
  }

  menuError(msg: string): void {
    const e = $("menu-err");
    e.textContent = msg;
    e.classList.remove("hidden");
  }

  connecting(on: boolean): void {
    $("menu-conn").classList.toggle("hidden", !on);
  }

  /** reflect a local, bots-only session (host couldn't reach the lobby server). In the
   *  lobby we simply omit the (unshareable) code and show an explanation; in-game the
   *  usual lobby-code slot becomes a red OFFLINE badge. */
  setOffline(on: boolean): void {
    $("lobby-offline").classList.toggle("hidden", !on);
    // lobby: hide the code + its label entirely offline — there's nothing to share
    $("lobby-code").classList.toggle("hidden", on);
    $("lobby-code-label").classList.toggle("hidden", on);
    // in-game: repurpose the code slot as a red OFFLINE badge
    const gc = $("game-code");
    gc.classList.toggle("offline", on);
    if (on) gc.textContent = "OFFLINE";
    $("sb-code").classList.toggle("hidden", on); // the scoreboard "join code" is meaningless offline
  }

  // ── lobby ──
  lobby(code: string, players: PlayerInfo[], isHost: boolean, mode: ModeId, cfg: MatchConfig, myId = "", platforms: Record<string, Platform> = {}): void {
    $("lobby-code").textContent = code;
    $("game-code").textContent = code;
    $("sb-code").textContent = "join code: " + code;
    $("lobby-players").innerHTML = players
      .map((p) => {
        const c = hex(p.color);
        return `<div class="lp${p.id === myId ? " me" : ""}">` +
          `<span class="dot" style="background:${c};color:${c}"></span>` +
          `<span class="lp-name">${esc(p.name)}</span>` +
          `${platIcon(platforms[p.id])}` +
          `${p.id === "host" ? `<em>host</em>` : ""}</div>`;
      })
      .join("");
    $("btn-start").classList.toggle("hidden", !isHost);
    $("lobby-wait").classList.toggle("hidden", isHost);
    $("lobby-adv-toggle").classList.toggle("hidden", !isHost);
    this.lobbyModes(mode, isHost);
    this.lobbyRules(mode, cfg, isHost);
  }

  private static mins(s: number): string { return `${Math.round(s / 60 * 10) / 10} min`; }

  /** host: compact editable match-rules grid · guest: read-only summary.
   *  The host grid is built + wired **once** and then only *synced* in place — never
   *  re-rendered — so a live slider drag is never interrupted by a lobby refresh
   *  (rebuilding the input mid-drag was what made the sliders feel broken). */
  private lobbyRules(_mode: ModeId, cfg: MatchConfig, isHost: boolean): void {
    const el = $("lobby-rules");
    const mins = Hud.mins;
    if (!isHost) {
      el.dataset.built = "guest";
      el.classList.remove("collapsed"); // the one-line summary is informational, always shown
      const botTxt = cfg.bots > 0 ? `${cfg.bots} bots · ${cfg.difficulty}` : "no bots";
      el.innerHTML =
        `<div class="rule-ro">${botTxt} · ${cfg.rounds} rounds · ${mins(cfg.roundTime)}` +
        `${cfg.gravity !== 1 ? ` · grav ${cfg.gravity.toFixed(1)}×` : ""}` +
        `${cfg.speed !== 1 ? ` · spd ${cfg.speed.toFixed(1)}×` : ""}` +
        `${cfg.thirdPerson ? " · 3rd-person" : ""}` +
        `${cfg.aiChat ? " · AI chat" : ""}</div>`;
      return;
    }
    if (el.dataset.built !== "host") this.buildRulesGrid(el);
    this.syncRules(cfg);
  }

  /** one-time construction of the host's editable rules grid + input listeners */
  private buildRulesGrid(el: HTMLElement): void {
    el.dataset.built = "host";
    // expanded by default — the match parameters are the main thing a host tunes, so
    // they're visible up-front rather than hidden behind a toggle (the toggle still
    // collapses them if the host wants a cleaner lobby).
    el.classList.remove("collapsed");
    $("lobby-adv-toggle").textContent = "Match settings ▴";
    const [bMin, bMax] = CFG_BOUNDS.bots;
    const [rMin, rMax] = CFG_BOUNDS.rounds;
    const [tMin, tMax] = CFG_BOUNDS.roundTime;
    const [gMin, gMax] = CFG_BOUNDS.gravity;
    const [sMin, sMax] = CFG_BOUNDS.speed;
    const cell = (key: string, label: string, min: number, max: number, step: number): string =>
      `<div class="rule"><label>${label} · <b id="rule-${key}-v"></b></label>` +
      `<input type="range" class="rng" id="rule-${key}" min="${min}" max="${max}" step="${step}"></div>`;
    const diff = `<div class="rule rule-wide"><label>Bot difficulty</label><div class="seg" id="rule-diff">` +
      BOT_LEVELS.map((d) => `<button data-v="${d}">${d}</button>`).join("") +
      `</div></div>`;
    const cam = `<div class="rule rule-wide"><label>Camera</label><div class="seg" id="rule-cam">` +
      `<button data-v="first">first-person</button><button data-v="third">third-person</button>` +
      `</div></div>`;
    // NPC AI chat is no longer a per-match rule — it's a per-host client preference
    // (Settings ▸ NPC AI chat), so it doesn't appear in this lobby grid.
    el.innerHTML =
      `<div class="rules-grid">` +
      cell("bots", "Bots", bMin, bMax, 1) +
      cell("rounds", "Rounds", rMin, rMax, 1) +
      cell("time", "Round", tMin, tMax, 30) +
      cell("grav", "Gravity", gMin, gMax, 0.1) +
      cell("speed", "Speed", sMin, sMax, 0.1) +
      diff +
      cam +
      `</div>`;

    const bind = (key: string, fn: (v: number) => Partial<MatchConfig>, disp: (v: number) => string): void => {
      const inp = document.getElementById(`rule-${key}`) as HTMLInputElement | null;
      if (!inp) return;
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        const lbl = document.getElementById(`rule-${key}-v`);
        if (lbl) lbl.textContent = disp(v);
        this.onCfg?.(fn(v));
      });
    };
    bind("bots", (v) => ({ bots: v }), (v) => String(v));
    bind("rounds", (v) => ({ rounds: v }), (v) => String(v));
    bind("time", (v) => ({ roundTime: v }), Hud.mins);
    bind("grav", (v) => ({ gravity: v }), (v) => `${v.toFixed(1)}×`);
    bind("speed", (v) => ({ speed: v }), (v) => `${v.toFixed(1)}×`);
    for (const c of Array.from($("rule-diff").children)) {
      c.addEventListener("click", () => this.onCfg?.({ difficulty: (c as HTMLElement).dataset.v as BotLevel }));
    }
    for (const c of Array.from($("rule-cam").children)) {
      c.addEventListener("click", () => this.onCfg?.({ thirdPerson: (c as HTMLElement).dataset.v === "third" }));
    }
  }

  // ─── NPC-AI on-device model: consent + download toasts ─────────────────────
  // The model is a heavy one-time download, so we ask first (showAiConsent). Once the
  // player accepts (or re-enables from Settings), the download can take minutes; the
  // progress toast keeps them informed while they keep playing. Nothing shows when the
  // model is already cached.

  /** first-run consent pop-up: ask whether to download the model. */
  showAiConsent(): void {
    $("ai-consent").classList.remove("ai-out", "hidden");
  }

  /** hide the consent pop-up (after the player picks, or when it's no longer needed). */
  hideAiConsent(): void {
    const el = $("ai-consent");
    if (el.classList.contains("hidden")) return;
    el.classList.add("ai-out");
    window.setTimeout(() => el.classList.add("hidden"), 280);
  }

  /** a model download has begun — reveal the toast. Starts INDETERMINATE (an animated
   *  bar, no %): the Prompt API's `downloadprogress` may not have fired yet — and when
   *  attaching to a browser-level Gemini-Nano download already cached, it can skip the
   *  byte-download phase entirely and go straight to (progress-less) loading. We show a
   *  real percentage only while measured progress is climbing (setAiDownloadProgress). */
  showAiDownload(): void {
    this.aiDlDismissed = false; // a freshly-triggered download always shows
    this.aiDlStart = Date.now();
    window.clearTimeout(this.aiDlDoneTimer);
    const el = $("ai-dl");
    el.classList.remove("done", "ai-out");
    el.classList.add("indet"); // no measured progress yet → animated bar
    $("ai-dl-title").textContent = "Preparing NPC AI";
    $("ai-dl-msg").textContent = "Downloading the on-device model — you can keep playing.";
    $("ai-dl-pct").textContent = "";
    $("ai-dl-eta").textContent = "";
    ($("ai-dl-fill") as HTMLElement).style.width = "0%";
    el.classList.remove("hidden");
  }

  /** update the toast from a `downloadprogress` fraction (0→1; `total` is always 1).
   *  Determinate while bytes stream in; once they're all in (loaded=1) the browser
   *  extracts + loads the model into memory with no further progress signal, so we
   *  flip back to indeterminate — per Chrome's "inform users of model download" guide. */
  setAiDownloadProgress(loaded: number): void {
    if (this.aiDlDismissed) return;
    const el = $("ai-dl");
    if (el.classList.contains("hidden")) this.showAiDownload();
    const frac = Math.max(0, Math.min(1, loaded));
    if (frac <= 0) return; // no signal yet — stay indeterminate
    if (frac >= 1) {
      // bytes are in → extraction / load-into-memory phase (no measurable progress)
      el.classList.add("indet");
      $("ai-dl-msg").textContent = "Almost ready — loading the model…";
      return;
    }
    el.classList.remove("indet");
    $("ai-dl-msg").textContent = "Downloading the on-device model — you can keep playing.";
    const pct = Math.round(frac * 100);
    ($("ai-dl-fill") as HTMLElement).style.width = `${pct}%`;
    $("ai-dl-pct").textContent = `${pct}%`;
    $("ai-dl-eta").textContent = Hud.etaLabel(this.aiDlStart, frac);
  }

  /** the model finished downloading — flip the toast to a success state that the
   *  player can dismiss (auto-clears after a few seconds if they don't). */
  aiDownloadDone(): void {
    if (this.aiDlDismissed) return;
    const el = $("ai-dl");
    el.classList.remove("hidden", "indet");
    el.classList.add("done");
    $("ai-dl-title").textContent = "NPC AI ready";
    $("ai-dl-msg").textContent = "The on-device model is ready — bots will now trash-talk.";
    window.clearTimeout(this.aiDlDoneTimer);
    this.aiDlDoneTimer = window.setTimeout(() => this.hideAiDownload(), 6500);
  }

  /** dismiss the toast (× button, auto-timeout, or a failed download). */
  hideAiDownload(): void {
    this.aiDlDismissed = true;
    window.clearTimeout(this.aiDlDoneTimer);
    const el = $("ai-dl");
    if (el.classList.contains("hidden")) return;
    el.classList.add("ai-out");
    window.setTimeout(() => el.classList.add("hidden"), 280);
  }

  /** turn "started at + fraction done" into a compact "~2m left" style ETA. Returns
   *  "" until there's enough signal to estimate (avoids a wildly wrong first guess). */
  private static etaLabel(startMs: number, frac: number): string {
    if (frac <= 0.02 || frac >= 1) return "";
    const elapsed = (Date.now() - startMs) / 1000;
    if (elapsed < 1.5) return "";
    const remain = Math.round(elapsed * (1 - frac) / frac);
    if (remain <= 0) return "";
    if (remain < 60) return `~${remain}s left`;
    return `~${Math.round(remain / 60)}m left`;
  }

  /** push cfg values into the already-built host grid without touching the DOM
   *  structure (skips an input the user is actively dragging) */
  private syncRules(cfg: MatchConfig): void {
    const set = (key: string, value: number, disp: string): void => {
      const inp = document.getElementById(`rule-${key}`) as HTMLInputElement | null;
      if (inp && document.activeElement !== inp) { inp.value = String(value); syncRange(inp); }
      const lbl = document.getElementById(`rule-${key}-v`);
      if (lbl) lbl.textContent = disp;
    };
    set("bots", cfg.bots, String(cfg.bots));
    set("rounds", cfg.rounds, String(cfg.rounds));
    set("time", cfg.roundTime, Hud.mins(cfg.roundTime));
    set("grav", cfg.gravity, `${cfg.gravity.toFixed(1)}×`);
    set("speed", cfg.speed, `${cfg.speed.toFixed(1)}×`);
    const diff = document.getElementById("rule-diff");
    if (diff) for (const c of Array.from(diff.children)) {
      c.classList.toggle("on", (c as HTMLElement).dataset.v === cfg.difficulty);
    }
    const cam = document.getElementById("rule-cam");
    if (cam) for (const c of Array.from(cam.children)) {
      const isThird = (c as HTMLElement).dataset.v === "third";
      c.classList.toggle("on", isThird === cfg.thirdPerson);
    }
  }

  /** host: clickable mode cards · guest: read-only current mode */
  private lobbyModes(mode: ModeId, isHost: boolean): void {
    const el = $("lobby-mode");
    const ids = isHost ? MODE_LIST : [mode];
    el.innerHTML = ids
      .map((id) => {
        const d = MODES[id];
        const cls = `mode-card${id === mode ? " on" : ""}${isHost ? "" : " readonly"}`;
        return `<div class="${cls}" data-mode="${id}"><div class="mn">${esc(d.name)}</div><div class="mb">${esc(d.blurb)}</div></div>`;
      })
      .join("");
    if (isHost) {
      for (const c of Array.from(el.children)) {
        c.addEventListener("click", () => this.onMode?.((c as HTMLElement).dataset.mode as ModeId));
      }
    }
  }

  // ── loadout class picker (death-screen strip) ──
  /** one class card: name, blurb, and the weapon kit it grants. `n` (1-based) prints a
   *  slot number so the death-screen strip can advertise its number-key shortcut. */
  private static classCard(c: ClassDef, selectedId: string, n = 0): string {
    const kit = c.loadout.map((w) => WEAPONS[w].name).join(" · ");
    const key = n ? `<span class="ck">${n}</span>` : "";
    return `<div class="mode-card class-card${c.id === selectedId ? " on" : ""}" data-class="${c.id}">` +
      `${key}<div class="mn">${esc(c.name)}</div><div class="mb">${esc(c.blurb)}</div>` +
      `<span class="kit">${esc(kit)}</span></div>`;
  }

  /** render class cards into `containerId`, marking `selectedId` and wiring clicks.
   *  `numbered` prints 1..N slot badges (used by the death-screen strip). */
  private renderClassCards(containerId: string, selectedId: string, numbered = false): void {
    const el = $(containerId);
    el.innerHTML = CLASS_LIST.map((id, i) => Hud.classCard(CLASSES[id], selectedId, numbered ? i + 1 : 0)).join("");
    for (const c of Array.from(el.children)) {
      c.addEventListener("click", () => this.pickClass((c as HTMLElement).dataset.class!));
    }
  }

  /** commit a class pick from either surface and reflect it on both without a re-render. */
  private pickClass(id: string): void {
    this.onClass?.(id);
    this.markClass(id);
  }

  /** highlight `id` on the death-screen class strip (the only class surface), so a pick
   *  made with the number keys shows up on the cards too. */
  markClass(id: string): void {
    const el = document.getElementById("respawn-classes");
    if (!el) return;
    for (const s of Array.from(el.children)) s.classList.toggle("on", (s as HTMLElement).dataset.class === id);
  }

  /** death/respawn screen: the compact "choose your next class" strip (deploys on respawn).
   *  Rendered once when the player dies; number badges advertise the 1..N desktop shortcut. */
  respawnClasses(selectedId: string): void { this.renderClassCards("respawn-classes", selectedId, true); }

  /** top-center team score (TDM sides / Prop Hunt seeker-vs-hider). null hides. */
  teamScoreHud(a: { name: string; score: number; color: number } | null, b?: { name: string; score: number; color: number }): void {
    const el = $("hud-teams");
    if (!a || !b) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML =
      `<span class="tn" style="color:${hex(a.color)}">${esc(a.name)}</span>` +
      `<span style="color:${hex(a.color)}">${a.score}</span>` +
      `<span class="dash">—</span>` +
      `<span style="color:${hex(b.color)}">${b.score}</span>` +
      `<span class="tn" style="color:${hex(b.color)}">${esc(b.name)}</span>`;
  }

  /** prop-hunt role / status line. Empty text hides. */
  roleHud(text: string, kind: "hide" | "seek" | "prep" | ""): void {
    const el = $("hud-role");
    if (!text) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.className = kind; // sets color via #hud-role.<kind>
    el.textContent = text;
  }

  /** gun-game tier + current weapon. tier < 0 hides. */
  tierHud(tier: number, max: number, weapon: string): void {
    const el = $("hud-tier");
    if (tier < 0) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = `${esc(weapon)}<span class="tp">tier ${tier + 1}/${max + 1}</span>`;
  }

  // ── in-game ──
  /** Health is shown diegetically, not as a number: a blood vignette creeps in as HP
   *  drops and the scene desaturates toward B/W. Death (v ≤ 0) hands the visuals to the
   *  body.dead CSS (full-grayscale death cinematic) and clears the low-HP state. */
  hp(v: number): void {
    const missing = Math.max(0, Math.min(1, 1 - v / 100));
    // blood: visible from the first hit, aggressive near death; parked while dead
    $("blood-vignette").style.opacity = v <= 0 ? "0" : Math.pow(missing, 1.35).toFixed(3);
    // B/W: kicks in below ~65 HP, up to 85% desaturation on the brink. Inline filter
    // would override the body.dead full-grayscale rule, so clear it when dead/full.
    const gray = v > 0 ? Math.max(0, Math.min(1, (65 - v) / 65)) * 0.85 : 0;
    $("game-canvas").style.filter = gray > 0.01 ? `grayscale(${gray.toFixed(3)})` : "";
  }

  private ammoPanelOn: boolean | null = null;
  /** bottom-right weapon/ammo panel: shown only in third person (first person reads
   *  ammo off the weapon-mounted holo readout instead) */
  ammoPanel(on: boolean): void {
    if (on === this.ammoPanelOn) return;
    this.ammoPanelOn = on;
    document.querySelector(".hud-br")?.classList.toggle("hidden", !on);
  }

  ammo(w: WeaponId, mag: number, reserve: number, reloading: boolean): void {
    $("hud-weapon").textContent = WEAPONS[w].name;
    $("hud-ammo").textContent = reloading ? "…" : mag < 0 ? "—" : reserve < 0 ? `${mag}` : `${mag} / ${reserve}`;
  }

  timer(phase: string, round: number, t: number, rounds = 4): void {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("hud-time").textContent = `${m}:${s.toString().padStart(2, "0")}`;
    $("hud-round").textContent = phase === "inter" ? "next round…" : phase === "deploy" ? "get ready" : `round ${round}/${rounds}`;
  }

  kill(killer: string, victim: string, w: DeathCause, hs: boolean): void {
    const feed = $("killfeed");
    const el = document.createElement("div");
    el.className = "kf";
    el.innerHTML = `<b>${esc(killer)}</b> <span>[${deathCauseLabel(w)}${hs ? " ✱" : ""}]</span> ${esc(victim)}`;
    feed.prepend(el);
    setTimeout(() => el.remove(), 5000);
    while (feed.children.length > 5) feed.lastChild?.remove();
  }

  hitmarker(hs: boolean): void {
    const e = $("hitmarker");
    e.classList.remove("hidden");
    e.classList.toggle("hs", hs);
    this.hitTtl = 0.09;
  }

  damageFlash(): void {
    $("dmg-vignette").classList.remove("hidden");
    this.dmgTtl = 0.25;
  }

  /** flashbang whiteout: snap the overlay to `intensity` (0..1), HOLD it solid for a
   *  beat (a hard flash keeps you fully blind for a couple of seconds, not just a bright
   *  frame), then fade it out over a duration that scales with how hard you were flashed.
   *  Re-flashing takes the stronger of the two (read from the *live* animated opacity)
   *  so a second nade can't read as *less* blinding than the first. */
  blind(intensity: number): void {
    const e = $("flash-blind");
    const cur = parseFloat(getComputedStyle(e).opacity) || 0;
    const v = Math.max(cur, Math.min(1, intensity));
    const hold = v > 0.45 ? (v - 0.45) * 4.5 : 0; // up to ~2.5s of solid white on a direct look
    const dur = 0.8 + v * 3.7;                    // then the fade itself (up to ~4.5s)
    e.classList.remove("hidden");
    e.style.transition = "none";
    e.style.opacity = String(v);
    void e.offsetWidth; // reflow so the fade starts from the snapped value
    // ease-in keeps the screen mostly washed out through the first half of the fade
    e.style.transition = `opacity ${dur}s ease-in ${hold}s`;
    e.style.opacity = "0";
  }

  scoreboard(visible: boolean, players: PlayerInfo[], scores: GameSnapshot["scores"], myId: string, platforms: Record<string, Platform> = {}): void {
    const sb = $("scoreboard");
    sb.classList.toggle("hidden", !visible);
    // clear the on-screen touch controls (weapon strip + fire cluster) while the
    // board is up — round-end interlude or a held scoreboard — so they don't float
    // over it on phones
    document.body.classList.toggle("sb-open", visible);
    if (!visible) return;
    const rows = players
      .map((p) => ({ p, s: scores[p.id] ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k || a.s.d - b.s.d);
    $("sb-rows").innerHTML = rows
      .map(({ p, s }, i) => Hud.lbRow(p, s, i, myId, platforms[p.id]))
      .join("");
  }

  banner(text: string, ms = 2500): void {
    const b = $("banner");
    b.textContent = text;
    b.classList.remove("hidden");
    clearTimeout((b as HTMLElement & { _t?: number })._t);
    (b as HTMLElement & { _t?: number })._t = window.setTimeout(() => b.classList.add("hidden"), ms);
  }

  respawnOverlay(t: number | null): void {
    const e = $("respawn");
    e.classList.toggle("hidden", t === null);
    if (t !== null) $("respawn-t").textContent = Math.ceil(t).toString();
  }

  private deployMode = false;
  /** pre-round deploy overlay (match/round start): reuses the death screen's class strip +
   *  countdown, with the label flipped to "round starts in". Driven per-frame while the
   *  deploy phase runs (so a stray respawnOverlay(null) from the initial spawn burst can't
   *  permanently hide it); null restores the overlay to its respawn wording and hides it. */
  deployOverlay(t: number | null): void {
    if (t === null) {
      if (!this.deployMode) return; // don't touch the overlay when a real death owns it
      this.deployMode = false;
      $("respawn").classList.add("hidden");
      $("respawn-label").textContent = "respawn in";
      $("rd-sub-when").textContent = "deploys on respawn";
      return;
    }
    this.deployMode = true;
    $("respawn").classList.remove("hidden");
    $("respawn-label").textContent = "round starts in";
    $("rd-sub-when").textContent = "deploys now"; // a pick during the freeze applies immediately
    $("respawn-t").textContent = Math.max(1, Math.ceil(t)).toString();
  }

  /** show/hide the death-screen "choose your class" strip and (when shown) render it with
   *  the current pick highlighted. Hidden for modes without a class choice (Gun Game tiers,
   *  Prop-Hunt hiders). Rendered once per death; the overlay itself is toggled by
   *  respawnOverlay each frame. */
  respawnDeploy(show: boolean, selectedId: string): void {
    $("respawn-deploy").classList.toggle("hidden", !show);
    if (show) this.respawnClasses(selectedId);
  }

  /** spectator banner for a no-respawn player (Prop-Hunt hider). `name` = who's being
   *  watched, or null to hide. */
  spectate(name: string | null): void {
    const e = $("spectate");
    e.classList.toggle("hidden", name === null);
    if (name !== null) $("spectate-n").textContent = name;
  }

  buff(name: string | null, color: number, secs: number): void {
    const e = $("buff");
    if (!name) { e.classList.add("hidden"); return; }
    e.classList.remove("hidden");
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    e.style.color = hex;
    e.style.borderColor = hex;
    e.textContent = `${name} · ${Math.ceil(secs)}s`;
  }

  // ── map picker cards (shared by the lobby "starting map" grid + interlude vote) ──
  /** one map card: the preview screenshot fills the whole card with the map name overlaid.
   *  `previews[id]` is a screenshot URL (folder-map preview), or absent for a placeholder.
   *  A live vote count (interlude) sits as a corner badge. */
  private static mapCard(m: MapMeta, previews: Record<string, string>, currentId?: string, withCount = false): string {
    const url = previews[m.id];
    const cls = url ? "vc" : "vc empty";
    const bg = url ? ` style="background-image:url('${esc(url)}')"` : "";
    return `<div class="${cls}" data-id="${esc(m.id)}"${bg}${m.id === currentId ? " data-cur=\"1\"" : ""}>` +
      (withCount ? `<div class="vcount" id="vcount-${esc(m.id)}">0</div>` : "") +
      (m.id === currentId ? "<div class=\"vcur\">current</div>" : "") +
      `<div class="vname">${esc(m.name)}</div>` +
      `</div>`;
  }

  // ── lobby: host's "starting map" picker (round 1) ──
  /** render the lobby map grid. Host: clickable, sets the round-1 map. Guest: read-only,
   *  showing the host's pick. `selectedId` is the currently chosen map. */
  lobbyMaps(metas: MapMeta[], previews: Record<string, string>, selectedId: string | undefined, isHost: boolean): void {
    const el = $("lobby-maps");
    el.classList.toggle("readonly", !isHost);
    // one card per map, the host's pick marked `.sel`
    el.innerHTML = metas.map((m) => Hud.mapCard(m, previews, undefined)).join("");
    for (const c of Array.from(el.children)) {
      const cel = c as HTMLElement;
      cel.classList.toggle("sel", cel.dataset.id === selectedId);
      if (isHost) cel.addEventListener("click", () => this.onStartMap?.(cel.dataset.id!));
    }
    // hide the picker entirely when there's nothing to choose (single map / none loaded)
    const only = metas.length <= 1;
    $("lobby-maps-label").classList.toggle("hidden", metas.length === 0);
    $("lobby-maps-hint").classList.toggle("hidden", only || !isHost);
  }

  // ── map vote (interlude) ──
  /** show vote cards (metas) with `currentId` marked, or hide when metas === null.
   *  `previews` maps a map id to its screenshot URL for the card thumbnail. */
  vote(metas: MapMeta[] | null, currentId?: string, previews: Record<string, string> = {}): void {
    const el = $("vote");
    if (!metas || metas.length === 0) { el.classList.add("hidden"); document.body.classList.remove("voting"); return; }
    el.classList.remove("hidden");
    document.body.classList.add("voting"); // pushes the scoreboard up so the two don't overlap
    $("vote-cards").innerHTML = metas.map((m) => Hud.mapCard(m, previews, currentId, true)).join("");
    for (const c of Array.from($("vote-cards").children)) {
      c.addEventListener("click", () => this.onVote?.((c as HTMLElement).dataset.id!));
    }
  }

  /** update per-map vote counts + highlight the local player's pick */
  voteCounts(counts: Record<string, number>, myVote: string | null): void {
    for (const c of Array.from($("vote-cards").children)) {
      const el = c as HTMLElement;
      const id = el.dataset.id!;
      const cn = document.getElementById(`vcount-${id}`);
      if (cn) cn.textContent = String(counts[id] ?? 0);
      el.classList.toggle("sel", id === myVote);
    }
  }

  stats(html: string): void { $("stats").innerHTML = html; }

  // ── frame-time graph (perf HUD): scrolling bars, one per frame, so drops/stutter
  //    read as visible spikes instead of hiding inside a smoothed fps average ──
  private perfCtx: CanvasRenderingContext2D | null = null;
  private perfBuf = new Float32Array(120); // last N frame times (ms), ring buffer
  private perfIdx = 0;
  private static readonly PERF_W = 150;
  private static readonly PERF_H = 40;
  private static readonly PERF_RANGE_MS = 40; // full graph height = 40 ms (25 fps)

  /** push one frame time (ms) and redraw the graph. Called per-frame while visible. */
  perfSample(ms: number): void {
    if (!this.perfCtx) {
      const canvas = $("perf-graph") as HTMLCanvasElement;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Hud.PERF_W * dpr;
      canvas.height = Hud.PERF_H * dpr;
      this.perfCtx = canvas.getContext("2d");
      this.perfCtx?.scale(dpr, dpr);
      if (!this.perfCtx) return;
    }
    const ctx = this.perfCtx;
    this.perfBuf[this.perfIdx] = ms;
    this.perfIdx = (this.perfIdx + 1) % this.perfBuf.length;

    const W = Hud.PERF_W, H = Hud.PERF_H, n = this.perfBuf.length;
    const yOf = (t: number): number => H - (Math.min(t, Hud.PERF_RANGE_MS) / Hud.PERF_RANGE_MS) * H;
    ctx.clearRect(0, 0, W, H);
    // budget reference lines: 60 fps (16.7 ms) and 30 fps (33.3 ms)
    ctx.fillStyle = "rgba(155,236,255,.28)";
    ctx.fillRect(0, yOf(1000 / 60), W, 1);
    ctx.fillStyle = "rgba(255,106,90,.35)";
    ctx.fillRect(0, yOf(1000 / 30), W, 1);
    // bars, oldest → newest left to right; colored by how blown the frame budget is
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = this.perfBuf[(this.perfIdx + i) % n];
      if (v <= 0) continue;
      const y = yOf(v);
      ctx.fillStyle = v > 34 ? "#ff6a5a" : v > 20 ? "#e5c05a" : "rgba(155,236,255,.7)";
      ctx.fillRect(i * bw, y, Math.max(bw - 0.4, 0.5), H - y);
    }
  }

  scope(on: boolean): void {
    $("scope").classList.toggle("hidden", !on);
    // clip world-anchored nametags to the scope's circular window while ADS — a name
    // floating over the black scope border reads as a wallhack (see index.html CSS)
    document.body.classList.toggle("scoped", on);
  }
  crosshair(on: boolean): void { $("crosshair").classList.toggle("hidden", !on); }
  clickToPlay(on: boolean): void { $("click-to-play").classList.toggle("hidden", !on); }

  // ── end screen ──
  end(players: PlayerInfo[], scores: GameSnapshot["scores"], isHost: boolean, title = "Match over", myId = "", platforms: Record<string, Platform> = {}): void {
    $("end-title").textContent = title;
    // rank by kills, then fewest deaths as the tie-breaker
    const rows = players
      .map((p) => ({ p, s: scores[p.id] ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k || a.s.d - b.s.d);

    // MVP spotlight = the top fragger
    const mvp = rows[0];
    $("end-mvp").innerHTML = mvp
      ? `<div class="mvp-medal">🏆</div>` +
        `<div class="mvp-info"><div class="mvp-label">MVP</div>` +
        `<div class="mvp-name" style="color:${hex(mvp.p.color)}">${esc(mvp.p.name)}</div></div>` +
        `<div class="mvp-kd"><span><b>${mvp.s.k}</b>kills</span><span><b>${mvp.s.d}</b>deaths</span></div>`
      : "";

    $("end-rows").innerHTML = rows
      .map(({ p, s }, i) => Hud.lbRow(p, s, i, myId, platforms[p.id], `animation-delay:${Math.min(i * 45, 400)}ms`))
      .join("");
    $("btn-again").classList.toggle("hidden", !isHost);
  }

  /** one medalled leaderboard row — shared by the end screen and the in-game
   *  scoreboard so both read as the same UI. `i` is the 0-based rank. */
  private static lbRow(
    p: PlayerInfo,
    s: { k: number; d: number },
    i: number,
    myId: string,
    plat?: Platform,
    style = "",
  ): string {
    const rank = i + 1;
    const ratio = (s.k / Math.max(1, s.d)).toFixed(1); // treat 0 deaths as 1 → no "Infinity"
    const medal = rank <= 3
      ? `<i class="medal m${rank}">${rank}</i>`
      : `<span class="rnum">${rank}</span>`;
    const c = hex(p.color);
    return `<div class="lb-row${p.id === myId ? " me" : ""}"${style ? ` style="${style}"` : ""}>` +
      `<span class="c-rank">${medal}</span>` +
      `<span class="c-name"><span class="pdot" style="background:${c};color:${c}"></span>${esc(p.name)}${platIcon(plat)}</span>` +
      `<span class="c-k">${s.k}</span><span class="c-d">${s.d}</span><span class="c-r">${ratio}</span></div>`;
  }

  /** the parallax vars live on #scr-game (not #hud-parallax) so every heads-up layer under
   *  it — the drifting chrome wrapper AND the centred round-start banner — reads the same
   *  --hud-px/--hud-py via inheritance and leans into the turn together. */
  private hudRoot: HTMLElement | null = document.getElementById("scr-game");
  /** drift the whole in-game HUD chrome with the player's look, for a floating holographic
   *  parallax. `vx`/`vy` are the smoothed per-frame look deltas (yaw/pitch, in rad); the
   *  chrome leans into the turn (same direction as the camera pan) so it reads as a heads-up
   *  layer riding the view. Reduced-motion users get no drift — the stylesheet zeroes the
   *  transform regardless of these vars. */
  parallax(vx: number, vy: number): void {
    const el = this.hudRoot;
    if (!el) return;
    const K = 260, MAX = 18; // px per rad/frame, clamped so a fast flick can't fling it far
    const px = Math.max(-MAX, Math.min(MAX, vx * K));
    const py = Math.max(-MAX, Math.min(MAX, -vy * K));
    el.style.setProperty("--hud-px", `${px.toFixed(1)}px`);
    el.style.setProperty("--hud-py", `${py.toFixed(1)}px`);
  }

  update(dt: number): void {
    if (this.hitTtl > 0) { this.hitTtl -= dt; if (this.hitTtl <= 0) $("hitmarker").classList.add("hidden"); }
    if (this.dmgTtl > 0) { this.dmgTtl -= dt; if (this.dmgTtl <= 0) $("dmg-vignette").classList.add("hidden"); }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
