// ─── Proximity voice chat: PeerJS media mesh + WebAudio spatialization ───────
import Peer, { MediaConnection } from "peerjs";

export class Voice {
  micOk = false;
  muted = false;
  /** voice is opt-in: `false` until the player turns it on (nothing is acquired before then,
   *  so iOS never enters its "record"/in-call audio session — the source of crackling output
   *  and the on-screen call indicator when the mic is held). */
  active = false;

  private ctx: AudioContext | null = null;
  private mine: MediaStream | null = null;
  private peer: Peer | null = null;
  private callBound = false;
  private toPid: (realId: string) => string = (s) => s;
  private conns = new Set<MediaConnection>();
  private nodes = new Map<string, { gain: GainNode; pan: StereoPannerNode; el: HTMLAudioElement }>();

  /** turn voice ON: acquire the mic and join the media mesh. No-op if already active. Only
   *  called when the player explicitly enables voice — never automatically — so a player who
   *  never touches the mic never grabs it (clean audio + no call indicator, esp. on iOS). */
  async start(peer: Peer, toPid: (realId: string) => string): Promise<boolean> {
    this.peer = peer;
    this.toPid = toPid;
    this.active = true;
    this.ctx = this.ctx ?? new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    try {
      this.mine = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micOk = true;
    } catch {
      // no mic → send silence, still hear others
      this.mine = this.ctx.createMediaStreamDestination().stream;
    }
    // bind the inbound-call answerer exactly once for this peer (re-enabling voice reuses it)
    if (!this.callBound) {
      this.callBound = true;
      peer.on("call", (c) => {
        if (!this.active || !this.mine) return; // ignore calls while voice is off
        c.answer(this.mine);
        this.attach(c);
      });
    }
    return this.micOk;
  }

  /** turn voice OFF: stop + release the mic (this is what lets iOS leave its record/call
   *  session — muting a still-live track does not), tear down every media connection, and
   *  drop all remote audio. Re-enabling calls start() again from scratch. */
  stop(): void {
    this.active = false;
    this.micOk = false;
    this.muted = false;
    this.mine?.getTracks().forEach((t) => t.stop());
    this.mine = null;
    for (const c of this.conns) { try { c.close(); } catch { /* already closed */ } }
    this.conns.clear();
    for (const pid of [...this.nodes.keys()]) this.drop(pid);
  }

  /** place outbound call to a peer's real PeerJS id */
  call(realId: string): void {
    if (!this.peer || !this.mine) return;
    this.attach(this.peer.call(realId, this.mine));
  }

  private attach(c: MediaConnection): void {
    this.conns.add(c);
    c.on("stream", (stream) => {
      const pid = this.toPid(c.peer);
      this.drop(pid);
      // chrome quirk: stream must be attached to a (muted) media element to flow into WebAudio
      const el = new Audio();
      el.srcObject = stream;
      el.muted = true;
      void el.play().catch(() => undefined);
      const ctx = this.ctx!;
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      src.connect(gain).connect(pan).connect(ctx.destination);
      this.nodes.set(pid, { gain, pan, el });
    });
    c.on("close", () => { this.conns.delete(c); this.drop(this.toPid(c.peer)); });
    c.on("error", () => { this.conns.delete(c); this.drop(this.toPid(c.peer)); });
  }

  drop(pid: string): void {
    const n = this.nodes.get(pid);
    if (!n) return;
    n.gain.disconnect();
    n.el.srcObject = null;
    this.nodes.delete(pid);
  }

  /** per-frame: pan [-1,1], dist in units */
  setSpatial(pid: string, panV: number, dist: number): void {
    const n = this.nodes.get(pid);
    if (!n) return;
    const vol = dist > 34 ? 0 : 1.4 / (1 + dist * 0.14);
    n.gain.gain.value = Math.min(1.4, vol);
    n.pan.pan.value = Math.max(-1, Math.min(1, panV));
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.mine?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }
}
