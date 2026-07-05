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

  private conns = new Map<string, DataConnection>(); // host: guests by id
  private hostConn: DataConnection | null = null; // guest: to host

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
    p.on("open", () => this.onReady?.());
    p.on("error", (e) => this.onError?.(String((e as Error).message ?? e)));
    p.on("connection", (conn) => {
      conn.on("data", (raw) => {
        const m = raw as Msg;
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
      const conn = p.connect(PREFIX + this.lobbyCode, { reliable: false });
      this.hostConn = conn;
      conn.on("open", () => {
        conn.send({ t: "hello", name: myName } satisfies Msg);
        this.onReady?.();
      });
      conn.on("data", (raw) => this.onMessage?.(raw as Msg, "host"));
      conn.on("close", () => this.onError?.("Lost connection to host"));
      conn.on("error", () => this.onError?.("Connection failed"));
    });
  }

  private dropGuest(id: string): void {
    if (!this.conns.has(id)) return;
    this.conns.delete(id);
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
    if (!this.isHost) { try { this.hostConn?.send({ t: "leave" }); } catch { /* */ } }
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

  destroy(): void { this.peer?.destroy(); }
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
