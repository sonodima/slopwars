// ─── Editor host: live-op bridge to the browser page ─────────────────────────
// Tools that operate on the *live* editing session (the in-memory map, camera,
// viewport, screenshots) can't run server-side — that state lives in the open
// editor page. This is a small command queue: the host enqueues a command, the
// browser long-polls `/__editor/mcp/poll`, runs it, and posts the result back to
// `/__editor/mcp/result`. `exec` resolves when the result arrives (or rejects if
// no page answers in time). Pure file operations do NOT go through here.
interface Pending { id: string; cmd: { op: string; [k: string]: unknown } }

export class Bridge {
  private pending: Pending[] = [];
  private results = new Map<string, unknown>();
  private seq = 0;

  /** drain queued commands for the polling editor page */
  poll(): Pending[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** the page reports a command's result */
  result(id: string, result: unknown): void {
    this.results.set(id, result);
  }

  /** enqueue a command and resolve with the page's result (rejects on timeout) */
  exec(op: string, extra: Record<string, unknown> = {}, timeoutMs = 15000): Promise<unknown> {
    const id = `c${++this.seq}_${Date.now().toString(36)}`;
    this.pending.push({ id, cmd: { op, ...extra } });
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.results.has(id)) {
          clearInterval(timer);
          const r = this.results.get(id);
          this.results.delete(id);
          resolve(r);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          this.pending = this.pending.filter((p) => p.id !== id);
          reject(new Error("editor did not respond — is the editor window open in a browser?"));
        }
      }, 50);
    });
  }

  /** fire-and-forget nudge to an open page (e.g. "reload your catalog"); silently
   *  gives up if no page is connected, so it never blocks headless operations. */
  notify(op: string, extra: Record<string, unknown> = {}): void {
    // reuse exec so the result is consumed and cleaned up; ignore the outcome.
    void this.exec(op, extra, 3000).catch(() => {});
  }
}
