// ─── Proximity voice chat: PeerJS media mesh + WebAudio spatialization ───────
import Peer, { MediaConnection } from "peerjs";

export class Voice {
  micOk = false;
  muted = false;

  private ctx: AudioContext | null = null;
  private mine: MediaStream | null = null;
  private peer: Peer | null = null;
  private toPid: (realId: string) => string = (s) => s;
  private nodes = new Map<string, { gain: GainNode; pan: StereoPannerNode; el: HTMLAudioElement }>();

  async start(peer: Peer, toPid: (realId: string) => string): Promise<boolean> {
    this.peer = peer;
    this.toPid = toPid;
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
    peer.on("call", (c) => {
      c.answer(this.mine!);
      this.attach(c);
    });
    return this.micOk;
  }

  /** place outbound call to a peer's real PeerJS id */
  call(realId: string): void {
    if (!this.peer || !this.mine) return;
    this.attach(this.peer.call(realId, this.mine));
  }

  private attach(c: MediaConnection): void {
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
    c.on("close", () => this.drop(this.toPid(c.peer)));
    c.on("error", () => this.drop(this.toPid(c.peer)));
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
