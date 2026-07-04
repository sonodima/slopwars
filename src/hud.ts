// ─── DOM HUD & screens ───────────────────────────────────────────────────────
import { GameSnapshot, PlayerInfo, WEAPONS, WeaponId } from "./types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export class Hud {
  onCreate: ((name: string) => void) | null = null;
  onChat: ((txt: string) => void) | null = null;
  chatOpen = false;
  onJoin: ((code: string, name: string) => void) | null = null;
  onStart: (() => void) | null = null;
  onPlayAgain: (() => void) | null = null;

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
    ($("inp-name") as HTMLInputElement).value = "player" + ((Math.random() * 900 + 100) | 0);

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
  }

  private name(): string {
    return (($("inp-name") as HTMLInputElement).value || "player").slice(0, 16);
  }

  show(screen: "loading" | "menu" | "lobby" | "game" | "end"): void {
    for (const s of ["loading", "menu", "lobby", "game", "end"]) $(`scr-${s}`).classList.toggle("hidden", s !== screen);
  }

  loadingProgress(frac: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    $("load-bar").style.width = `${pct}%`;
    $("load-pct").textContent = `${pct}%`;
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
  lobby(code: string, players: PlayerInfo[], isHost: boolean): void {
    $("lobby-code").textContent = code;
    $("game-code").textContent = code;
    $("sb-code").textContent = "join code: " + code;
    $("lobby-players").innerHTML = players
      .map((p) => `<div class="lp"><span class="dot" style="background:#${p.color.toString(16).padStart(6, "0")}"></span>${esc(p.name)}${p.id === "host" ? " <em>host</em>" : ""}</div>`)
      .join("");
    $("btn-start").classList.toggle("hidden", !isHost);
    $("lobby-wait").classList.toggle("hidden", isHost);
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

  timer(phase: string, round: number, t: number): void {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("hud-time").textContent = `${m}:${s.toString().padStart(2, "0")}`;
    $("hud-round").textContent = phase === "inter" ? "next round…" : `round ${round}/4`;
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

  stats(html: string): void { $("stats").innerHTML = html; }

  scope(on: boolean): void { $("scope").classList.toggle("hidden", !on); }
  crosshair(on: boolean): void { $("crosshair").classList.toggle("hidden", !on); }
  clickToPlay(on: boolean): void { $("click-to-play").classList.toggle("hidden", !on); }

  // ── end screen ──
  end(players: PlayerInfo[], scores: GameSnapshot["scores"], isHost: boolean): void {
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
