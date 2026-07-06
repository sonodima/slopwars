// ─── DOM HUD & screens ───────────────────────────────────────────────────────
import { BOT_LEVELS, BotLevel, CFG_BOUNDS, GameSnapshot, MatchConfig, ModeId, PlayerInfo, WEAPONS, WeaponId } from "./types";
import { MapMeta } from "./maps/schema";
import { MODES, MODE_LIST } from "./modes";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

export class Hud {
  onCreate: ((name: string) => void) | null = null;
  onChat: ((txt: string) => void) | null = null;
  chatOpen = false;
  onJoin: ((code: string, name: string) => void) | null = null;
  onStart: (() => void) | null = null;
  onPlayAgain: (() => void) | null = null;
  onVote: ((mapId: string) => void) | null = null;
  onMode: ((mode: ModeId) => void) | null = null;
  onCfg: ((patch: Partial<MatchConfig>) => void) | null = null;
  onHome: (() => void) | null = null;

  private hitTtl = 0;
  private dmgTtl = 0;

  constructor() {
    $("btn-create").onclick = () => this.onCreate?.(this.name());
    $("btn-join").onclick = () => {
      const c = ($("inp-code") as HTMLInputElement).value.trim();
      if (c.length >= 4) this.onJoin?.(c, this.name());
    };
    $("btn-start").onclick = () => this.onStart?.();
    $("btn-again").onclick = () => this.onPlayAgain?.();
    $("btn-home").onclick = () => this.onHome?.();

    const inp = $("chat-inp") as HTMLInputElement;
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Enter") {
        const v = inp.value.trim();
        if (v) this.onChat?.(v.slice(0, 120));
        this.closeChat();
      } else if (e.code === "Escape") this.closeChat();
    });
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
    e.textContent = state === "on" ? "🎙 voice on · V" : state === "muted" ? "🎙 muted · V" : "🎙 no mic";
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
    $("load-pct").textContent = `${pct}%`;
  }

  /** name of the asset currently being fetched (loading screen) */
  loadingLabel(name: string): void {
    $("load-asset").textContent = name;
  }

  menuError(msg: string): void {
    const e = $("menu-err");
    e.textContent = msg;
    e.classList.remove("hidden");
  }

  connecting(on: boolean): void {
    $("menu-conn").classList.toggle("hidden", !on);
  }

  // ── lobby ──
  lobby(code: string, players: PlayerInfo[], isHost: boolean, mode: ModeId, cfg: MatchConfig): void {
    $("lobby-code").textContent = code;
    $("game-code").textContent = code;
    $("sb-code").textContent = "join code: " + code;
    $("lobby-players").innerHTML = players
      .map((p) => `<div class="lp"><span class="dot" style="background:${hex(p.color)}"></span>${esc(p.name)}${p.id === "host" ? " <em>host</em>" : ""}</div>`)
      .join("");
    $("btn-start").classList.toggle("hidden", !isHost);
    $("lobby-wait").classList.toggle("hidden", isHost);
    this.lobbyModes(mode, isHost);
    this.lobbyRules(mode, cfg, isHost);
  }

  /** host: compact editable match-rules grid · guest: read-only summary */
  private lobbyRules(_mode: ModeId, cfg: MatchConfig, isHost: boolean): void {
    const el = $("lobby-rules");
    const mins = (s: number): string => `${Math.round(s / 60 * 10) / 10} min`;
    if (!isHost) {
      const botTxt = cfg.bots > 0 ? `${cfg.bots} bots · ${cfg.difficulty}` : "no bots";
      el.innerHTML =
        `<div class="rule-ro">${botTxt} · ${cfg.rounds} rounds · ${mins(cfg.roundTime)}` +
        `${cfg.gravity !== 1 ? ` · grav ${cfg.gravity.toFixed(1)}×` : ""}` +
        `${cfg.speed !== 1 ? ` · spd ${cfg.speed.toFixed(1)}×` : ""}</div>`;
      return;
    }
    const [bMin, bMax] = CFG_BOUNDS.bots;
    const [rMin, rMax] = CFG_BOUNDS.rounds;
    const [tMin, tMax] = CFG_BOUNDS.roundTime;
    const [gMin, gMax] = CFG_BOUNDS.gravity;
    const [sMin, sMax] = CFG_BOUNDS.speed;
    const cell = (key: string, label: string, min: number, max: number, step: number, val: number, disp: string): string =>
      `<div class="rule"><label>${label} · <b id="rule-${key}-v">${disp}</b></label>` +
      `<input type="range" class="rng" id="rule-${key}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
    const diff = `<div class="rule rule-wide"><label>Bot difficulty</label><div class="seg" id="rule-diff">` +
      BOT_LEVELS.map((d) => `<button data-v="${d}"${d === cfg.difficulty ? " class=\"on\"" : ""}>${d}</button>`).join("") +
      `</div></div>`;
    el.innerHTML =
      `<div class="rules-grid">` +
      cell("bots", "Bots", bMin, bMax, 1, cfg.bots, String(cfg.bots)) +
      cell("rounds", "Rounds", rMin, rMax, 1, cfg.rounds, String(cfg.rounds)) +
      cell("time", "Round", tMin, tMax, 30, cfg.roundTime, mins(cfg.roundTime)) +
      cell("grav", "Gravity", gMin, gMax, 0.1, cfg.gravity, `${cfg.gravity.toFixed(1)}×`) +
      cell("speed", "Speed", sMin, sMax, 0.1, cfg.speed, `${cfg.speed.toFixed(1)}×`) +
      diff +
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
    bind("time", (v) => ({ roundTime: v }), mins);
    bind("grav", (v) => ({ gravity: v }), (v) => `${v.toFixed(1)}×`);
    bind("speed", (v) => ({ speed: v }), (v) => `${v.toFixed(1)}×`);
    for (const c of Array.from($("rule-diff").children)) {
      c.addEventListener("click", () => this.onCfg?.({ difficulty: (c as HTMLElement).dataset.v as BotLevel }));
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
  hp(v: number): void {
    $("hud-hp").textContent = String(Math.max(0, Math.ceil(v)));
    $("hud-hp").classList.toggle("low", v <= 30);
  }

  ammo(w: WeaponId, mag: number, reserve: number, reloading: boolean): void {
    $("hud-weapon").textContent = WEAPONS[w].name;
    $("hud-ammo").textContent = reloading ? "…" : mag < 0 ? "—" : reserve < 0 ? `${mag}` : `${mag} / ${reserve}`;
  }

  timer(phase: string, round: number, t: number, rounds = 4): void {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("hud-time").textContent = `${m}:${s.toString().padStart(2, "0")}`;
    $("hud-round").textContent = phase === "inter" ? "next round…" : `round ${round}/${rounds}`;
  }

  kill(killer: string, victim: string, w: WeaponId, hs: boolean): void {
    const feed = $("killfeed");
    const el = document.createElement("div");
    el.className = "kf";
    el.innerHTML = `<b>${esc(killer)}</b> <span>[${WEAPONS[w].name}${hs ? " ✱" : ""}]</span> ${esc(victim)}`;
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

  scoreboard(visible: boolean, players: PlayerInfo[], scores: GameSnapshot["scores"], myId: string): void {
    const sb = $("scoreboard");
    sb.classList.toggle("hidden", !visible);
    if (!visible) return;
    const rows = players
      .map((p) => ({ p, s: scores[p.id] ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k);
    $("sb-rows").innerHTML = rows
      .map(({ p, s }) => `<div class="row${p.id === myId ? " me" : ""}"><span>${esc(p.name)}</span><span>${s.k}</span><span>${s.d}</span></div>`)
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

  buff(name: string | null, color: number, secs: number): void {
    const e = $("buff");
    if (!name) { e.classList.add("hidden"); return; }
    e.classList.remove("hidden");
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    e.style.color = hex;
    e.style.borderColor = hex;
    e.textContent = `${name} · ${Math.ceil(secs)}s`;
  }

  // ── map vote (interlude) ──
  /** show vote cards (metas) with `currentId` marked, or hide when metas === null */
  vote(metas: MapMeta[] | null, currentId?: string): void {
    const el = $("vote");
    if (!metas) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    $("vote-cards").innerHTML = metas
      .map((m) => `<div class="vc" data-id="${m.id}"${m.id === currentId ? " data-cur=\"1\"" : ""}>` +
        `<div class="vn">${esc(m.name)}</div><div class="vt">${esc(m.theme)}</div>` +
        `<div class="vcount" id="vcount-${m.id}">0</div>${m.id === currentId ? "<div class=\"vcur\">current</div>" : ""}</div>`)
      .join("");
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

  scope(on: boolean): void { $("scope").classList.toggle("hidden", !on); }
  crosshair(on: boolean): void { $("crosshair").classList.toggle("hidden", !on); }
  clickToPlay(on: boolean): void { $("click-to-play").classList.toggle("hidden", !on); }

  // ── end screen ──
  end(players: PlayerInfo[], scores: GameSnapshot["scores"], isHost: boolean, title = "Match over"): void {
    $("end-title").textContent = title;
    const rows = players
      .map((p) => ({ p, s: scores[p.id] ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k);
    $("end-rows").innerHTML = rows
      .map(({ p, s }, i) => `<div class="row"><span>#${i + 1} ${esc(p.name)}</span><span>${s.k}</span><span>${s.d}</span></div>`)
      .join("");
    $("btn-again").classList.toggle("hidden", !isHost);
  }

  update(dt: number): void {
    if (this.hitTtl > 0) { this.hitTtl -= dt; if (this.hitTtl <= 0) $("hitmarker").classList.add("hidden"); }
    if (this.dmgTtl > 0) { this.dmgTtl -= dt; if (this.dmgTtl <= 0) $("dmg-vignette").classList.add("hidden"); }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
