// ─── PeerJS serverless networking (host = relay + authority) ─────────────────
import Peer, { DataConnection } from "peerjs";
import { Msg, PlayerInfo } from "./types";

export const PREFIX = "gsweb2-";

function code(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}

export class Net {
  peer: Peer | null = null;
  isHost = false;
  myId = "";
  lobbyCode = "";
  players: PlayerInfo[] = [];
  /** true when the host couldn't reach the PeerJS signaling server and fell back to a
   *  purely local session: no peers can join, but you can still play a bots-only match.
   *  The UI surfaces this as an OFFLINE badge instead of a shareable lobby code. */
  offline = false;

  private conns = new Map<string, DataConnection>(); // host: guests by id
  private hostConn: DataConnection | null = null; // guest: to host
  private opened = false; // the peer reached the signaling server (open fired)

  // ── liveness ──
  // WebRTC data-channel "close" is unreliable (a crashed tab, dropped network or
  // backgrounded mobile browser often never fires it), which left ghost players
  // standing frozen in the match. Both sides therefore heartbeat: guests ping every
  // 2s (the host answers pong), and each side drops a peer it hasn't heard from.
  private lastSeen = new Map<string, number>(); // host: guest id → last data (ms)
  private lastFromHost = 0;                     // guest: last host data (ms)
  private liveTimer: number | null = null;
  private static readonly GUEST_TIMEOUT = 8000;  // host drops a silent guest (they ping @2s)
  private static readonly HOST_TIMEOUT = 15000;  // guest gives up on a silent host

  onMessage: ((m: Msg, fromId: string) => void) | null = null;
  onPeerJoin: ((p: PlayerInfo) => void) | null = null;
  onPeerLeave: ((id: string) => void) | null = null;
  onReady: (() => void) | null = null;
  onError: ((err: string) => void) | null = null;
  /** host: called when a new guest says hello; must return init payload */
  onHello: ((id: string, name: string) => Msg) | null = null;

  /** pick a palette colour not currently used by any player (falls back to hash) */
  pickColor(seed: string): number {
    const used = new Set(this.players.map((p) => p.color));
    for (const c of COLOR_PALETTE) if (!used.has(c)) return c;
    return colorFor(seed);
  }

  host(myName: string): void {
    this.isHost = true;
    this.lobbyCode = code();
    this.myId = "host";
    this.players = [{ id: "host", name: myName, color: COLOR_PALETTE[0] }];
    const p = new Peer(PREFIX + this.lobbyCode);
    this.peer = p;
    p.on("open", () => { this.opened = true; this.onReady?.(); });
    p.on("error", (e) => {
      // couldn't even reach the signaling server → don't strand the player at the menu.
      // Fall back to a local, bots-only session (host authority is entirely local, so
      // everything works — there's just no one to relay to). A later transient error,
      // once we're open, is surfaced normally.
      if (!this.opened) { this.goOffline(); return; }
      this.onError?.(String((e as Error).message ?? e));
    });
    // sweep for guests that silently vanished (no clean close event)
    this.liveTimer = window.setInterval(() => {
      const now = Date.now();
      for (const id of [...this.conns.keys()]) {
        const seen = this.lastSeen.get(id) ?? now;
        if (now - seen > Net.GUEST_TIMEOUT) this.dropGuest(id);
      }
    }, 2000);
    p.on("connection", (conn) => {
      // ── version gate ── the guest's build id rides the connection `metadata`
      // (signaling channel: reliable and present before the datachannel opens), so a
      // pre-versioning client is detectable by its absence. Mismatch ⇒ refuse before
      // any handshake: the guest never enters conns/players and gets told why.
      const guestV = (conn.metadata as { v?: string } | undefined)?.v;
      if (guestV !== __GAME_VERSION__) {
        this.refuse(conn, { t: "reject", reason: "version", hostV: __GAME_VERSION__ });
        return;
      }
      conn.on("data", (raw) => {
        const m = raw as Msg;
        this.lastSeen.set(conn.peer, Date.now());
        if (m.t === "hello") {
          const id = conn.peer;
          this.conns.set(id, conn);
          const info: PlayerInfo = { id, name: (m.name || "player").slice(0, 16), color: this.pickColor(id) };
          this.players.push(info);
          const init = this.onHello?.(id, info.name);
          if (init) conn.send(init);
          this.broadcast({ t: "pjoin", p: info }, id);
          this.onPeerJoin?.(info);
        } else if (m.t === "leave") {
          this.dropGuest(conn.peer);
        } else {
          this.onMessage?.(m, conn.peer);
        }
      });
      conn.on("close", () => this.dropGuest(conn.peer));
      conn.on("error", () => this.dropGuest(conn.peer));
    });
  }

  join(codeStr: string, myName: string): void {
    this.isHost = false;
    this.lobbyCode = codeStr.toUpperCase().trim();
    const p = new Peer();
    this.peer = p;
    p.on("error", (e) => this.onError?.(String((e as Error).message ?? e)));
    p.on("open", (id) => {
      this.myId = id;
      // version in metadata: the host gates on it before the datachannel even opens
      const conn = p.connect(PREFIX + this.lobbyCode, { reliable: false, metadata: { v: __GAME_VERSION__ } });
      this.hostConn = conn;
      conn.on("open", () => {
        conn.send({ t: "hello", name: myName } satisfies Msg);
        this.lastFromHost = Date.now();
        // Heartbeat from a plain interval, NOT the rAF game loop: a backgrounded tab's
        // rAF stops entirely (the host would then drop us as vanished), while interval
        // timers keep firing at ≥1 Hz. The host answers each ping with a pong, which
        // both feeds the HUD's RTT readout and proves the host is still alive.
        this.liveTimer = window.setInterval(() => {
          this.send({ t: "ping", ts: performance.now() });
          if (Date.now() - this.lastFromHost > Net.HOST_TIMEOUT) {
            if (this.liveTimer !== null) { clearInterval(this.liveTimer); this.liveTimer = null; }
            this.onError?.("Lost connection to host");
          }
        }, 2000);
        this.onReady?.();
      });
      conn.on("data", (raw) => {
        this.lastFromHost = Date.now();
        this.onMessage?.(raw as Msg, "host");
      });
      conn.on("close", () => this.onError?.("Lost connection to host"));
      conn.on("error", () => this.onError?.("Connection failed"));
    });
  }

  /** the host fell back to a local-only session (signaling server unreachable): tear
   *  the dead peer down, mark offline, and enter the lobby anyway so a bots-only match
   *  is playable. Guests can't join a local session — this only fires for the host. */
  private goOffline(): void {
    if (this.opened || this.offline) return;
    this.offline = true;
    this.opened = true;   // stop any further pre-open error from re-triggering this
    this.lobbyCode = "OFFLINE";
    try { this.peer?.destroy(); } catch { /* already dead */ }
    this.peer = null;
    this.onReady?.();
  }

  /** Send a peer one last message it will actually receive, then close. A plain
   *  close() tears the RTCPeerConnection down without draining the send buffer —
   *  close({flush:true}) defers until the message is through (PeerJS ≥1.5), with a
   *  2s hard-close fallback in case the remote never acks. */
  private refuse(conn: DataConnection, m: Msg): void {
    const part = (): void => {
      try { conn.send(m); conn.close({ flush: true }); } catch { try { conn.close(); } catch { /* dead */ } }
      window.setTimeout(() => { try { conn.close(); } catch { /* already closed */ } }, 2000);
    };
    if (conn.open) part();
    else conn.on("open", part);
  }

  /** host: remove a guest from the lobby/match. Tells the target why before the
   *  drop (a kick is a nudge, not a ban: peer ids are ephemeral, so a kicked player
   *  can rejoin under a fresh id — there is no durable P2P identity to ban on). */
  kick(id: string): void {
    if (!this.isHost) return;
    this.sendTo(id, { t: "kicked" });
    this.dropGuest(id, true); // flush-close so the message survives the teardown
  }

  private dropGuest(id: string, flush = false): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    this.lastSeen.delete(id);
    if (flush) {
      // drain the send buffer first (the just-queued "kicked"), hard-close backstop
      try { conn.close({ flush: true }); } catch { try { conn.close(); } catch { /* dead */ } }
      window.setTimeout(() => { try { conn.close(); } catch { /* already closed */ } }, 2000);
    } else {
      try { conn.close(); } catch { /* already dead */ }
    }
    this.players = this.players.filter((p) => p.id !== id);
    this.broadcast({ t: "pleave", id });
    this.onPeerLeave?.(id);
  }

  /** host → all guests (except skip) */
  broadcast(m: Msg, skip?: string): void {
    for (const [id, c] of this.conns) if (id !== skip && c.open) c.send(m);
  }

  /** host → one guest */
  sendTo(id: string, m: Msg): void {
    const c = this.conns.get(id);
    if (c?.open) c.send(m);
  }

  /** guest → host */
  send(m: Msg): void {
    if (this.isHost) return;
    if (this.hostConn?.open) this.hostConn.send(m);
  }

  leave(): void {
    if (this.liveTimer !== null) { clearInterval(this.liveTimer); this.liveTimer = null; }
    // Tell the other side we're going so they don't wait out the heartbeat timeout: a
    // guest tells the host, the host tells every guest. Best-effort on the unreliable
    // channel and cut short by the destroy below — conn-close + the timeout are backstops.
    if (this.isHost) this.broadcast({ t: "hostleave" });
    else { try { this.hostConn?.send({ t: "leave" }); } catch { /* */ } }
    this.peer?.destroy();
  }

  /** the synced colour a player was assigned (falls back to hash) */
  colorOf(id: string): number {
    return this.players.find((p) => p.id === id)?.color ?? colorFor(id);
  }

  /** real PeerJS id for a player id */
  realId(pid: string): string { return pid === "host" ? PREFIX + this.lobbyCode : pid; }
  /** player id from a real PeerJS id */
  pidOf(realId: string): string { return realId === PREFIX + this.lobbyCode ? "host" : realId; }

  destroy(): void {
    if (this.liveTimer !== null) { clearInterval(this.liveTimer); this.liveTimer = null; }
    this.peer?.destroy();
  }
}

/** distinct, high-contrast player colours (assigned in join order by the host) */
export const COLOR_PALETTE: number[] = [
  0xd8b878, 0x4d8dff, 0xe0553f, 0x5fd08a, 0xc23fff, 0xffd23f,
  0x3fd0ff, 0xff7ab5, 0x9be04d, 0xff9a3f,
];

export function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 0.65, 0.55);
}

function hslToHex(h: number, s: number, l: number): number {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
