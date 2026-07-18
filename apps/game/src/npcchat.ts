// ─── Chrome built-in AI (Prompt API) → NPC trash-talk ────────────────────────
// EXPERIMENTAL / host-only. Uses the on-device Gemini Nano model exposed by
// Chrome's Prompt API (the `LanguageModel` global, or the legacy
// `window.ai.languageModel`). Everything here degrades to a silent no-op when the
// API is absent or the model can't be provisioned, so non-Chrome players simply
// never see AI banter — the rest of the game is unaffected.
//
// The rivalry model: this is a competitive shooter, so bots are TOXIC toward
// enemies (mock, rage-bait, never compliment) and only warm toward teammates
// (hype up good plays). The caller decides the relationship + the situation; this
// module just turns that into one tidy line of chat.
//
// The model runs fully on-device: no network, no keys, no data leaves the machine.

// The two known API surfaces expose the same tiny slice we need.
export type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface LMSession {
  prompt(input: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

interface LMFactory {
  availability?(): Promise<Availability>;
  create(opts?: Record<string, unknown>): Promise<LMSession>;
}

/** locate whichever Prompt-API surface this browser ships (or null on non-Chrome). */
function locateFactory(): LMFactory | null {
  const g = globalThis as unknown as {
    LanguageModel?: LMFactory;
    ai?: { languageModel?: LMFactory };
  };
  if (g.LanguageModel?.create) return g.LanguageModel;
  if (g.ai?.languageModel?.create) return g.ai.languageModel;
  return null;
}

const SYSTEM_PROMPT =
  "You are a player in SlopWars, a highly competitive multiplayer FPS." +
  "You are toxic and your language is crude and full of slurs. Rules you ALWAYS follow:\n" +
  "- Output ONE line of in-game chat only: max 12 words, no line breaks, no emoji, no " +
  "quotes around it.\n" +
  "- Write like real chat: all lowercase, bad grammar, no punctuation and typos.\n" +
  "- Toward an ENEMY: be BRUTAL and include profanity.\n" +
  "- Toward a TEAMMATE: gas them up, praise the play.\n" +
  "- NEVER use cringey plays with words, be unoriginal and just crude.\n" +
  "Output only the line, nothing else.";

export type Relation = "enemy" | "teammate";

export interface LineReq {
  /** the bot doing the talking */
  bot: string;
  /** the other human this line is about / aimed at */
  player: string;
  /** the bot's relationship to that human — drives toxic vs friendly tone */
  relation: Relation;
  /** what just happened + what kind of line to produce (caller-authored) */
  situation: string;
  /** game-state facts (mode, round, scores…) to give the bot material to riff on */
  context?: string[];
  /** recent chat lines, oldest→newest, for reply context (optional) */
  transcript?: string[];
}

/** Progress callbacks for the (potentially minutes-long) model download. All
 *  optional — provisioning works without wiring any of them up. */
export interface NpcDownloadHooks {
  /** the on-device model download has started. */
  onStart?(): void;
  /** download progress, as a fraction 0→1. */
  onProgress?(loaded: number): void;
  /** the model finished downloading (or was already cached) and is ready. */
  onDone?(): void;
  /** provisioning failed. */
  onError?(): void;
}

export interface NpcChat {
  /** can produce lines right now (the model is downloaded + a session can run). */
  readonly ready: boolean;
  /** last-known model availability. `"downloadable"` means supported but not yet on
   *  disk — a one-time download is required, which we only start on user consent. */
  readonly status: Availability;
  line(req: LineReq): Promise<string | null>;
  /** download (if needed) + warm up the model, reporting progress through `hooks`.
   *  Resolves true once ready, false if it can't be provisioned. Safe to call again
   *  once ready (returns true immediately). */
  provision(hooks?: NpcDownloadHooks): Promise<boolean>;
}

// ── inference throttle ───────────────────────────────────────────────────────
// On-device inference is GPU/CPU heavy. The Prompt API exposes no way to *slow*
// the model, so we cap its footprint two ways instead: run at most one prompt at a
// time (the chain), and never start two closer together than MIN_GAP_MS. Combined
// with the caller-side cooldowns, sustained load stays low. Bump MIN_GAP_MS to
// throttle harder (fewer, more-spaced generations) at the cost of chattiness.
const MIN_GAP_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** resolve when the main thread is idle (or after `timeout`), so kicking off an
 *  inference never lands in the middle of a busy render frame. */
function whenIdle(timeout = 1500): Promise<void> {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  return ric
    ? new Promise((r) => ric(() => r(), { timeout }))
    : sleep(0);
}

/** the live implementation, created only once the API surface is confirmed present. */
class LiveNpcChat implements NpcChat {
  status: Availability;
  /** true once the model is on disk + a session can be spun up without a big download.
   *  Starts true only when the model was already cached at init (`"available"`). */
  private provisioned: boolean;
  private sessionP: Promise<LMSession> | null = null;  // shared, in-flight session
  private chain: Promise<unknown> = Promise.resolve(); // serialize prompts (one model)
  private lastRun = 0;                                  // wall-clock ms of the last inference

  constructor(private factory: LMFactory, status: Availability) {
    this.status = status;
    this.provisioned = status === "available";
  }

  get ready(): boolean { return this.provisioned; }

  /** download (if needed) + warm up the model. We never do this implicitly — the
   *  caller triggers it on explicit user consent (a prompt, or the Settings toggle). */
  async provision(hooks?: NpcDownloadHooks): Promise<boolean> {
    if (this.status === "unavailable") { hooks?.onError?.(); return false; }
    if (this.provisioned) { hooks?.onDone?.(); return true; }
    hooks?.onStart?.();
    try {
      const session = await this.ensureSession(hooks?.onProgress);
      // Canary against the echo stub: open-Chromium builds beyond the desktop
      // shell (Brave & co.) also "create" a session instantly and then just echo
      // prompts back. One tiny inference is the only reliable tell; on real
      // Chrome it costs a fraction of a second, once per provision.
      const canary = await session.prompt("ping");
      if (canary.toLowerCase().includes("echoing back")) {
        console.info("[npcchat] Prompt API is an echo stub on this browser — banter disabled");
        this.status = "unavailable";
        this.sessionP = null;
        try { session.destroy?.(); } catch { /* */ }
        hooks?.onError?.();
        return false;
      }
      this.provisioned = true;
      this.status = "available";
      hooks?.onDone?.();
      return true;
    } catch (e) {
      console.warn("[npcchat] provisioning failed", e);
      hooks?.onError?.();
      return false;
    }
  }

  private ensureSession(onProgress?: (loaded: number) => void): Promise<LMSession> {
    if (this.sessionP) return this.sessionP;
    // Promise.resolve() so a synchronous throw from create() also lands in .catch
    this.sessionP = Promise.resolve()
      .then(() => this.factory.create({
        initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
        temperature: 0.4,
        topK: 20,
        // Chrome streams the on-device model the first time and reports progress via
        // a `downloadprogress` event (e.loaded: 0→1); forward it to the overlay.
        monitor(m: { addEventListener?(t: string, cb: (e: { loaded: number }) => void): void }) {
          m.addEventListener?.("downloadprogress", (e) => onProgress?.(e.loaded));
        },
      }))
      .catch((err: unknown) => {
        this.sessionP = null; // failed provisioning — let a later call retry clean
        throw err;
      });
    return this.sessionP;
  }

  line(req: LineReq): Promise<string | null> {
    const facts = req.context?.length ? `Match state:\n${req.context.join("\n")}\n` : "";
    const ctx = req.transcript?.length
      ? `Chat log (oldest first; lines starting with "${req.bot}:" are YOUR own past messages):\n` +
        `${req.transcript.slice(-8).join("\n")}\n`
      : "";
    return this.run(
      `You are the bot "${req.bot}". "${req.player}" is your ${req.relation}.\n` +
      facts +
      ctx +
      req.situation
    );
  }

  /** run a prompt on the shared session, serialized and time-boxed. Never throws. */
  private run(input: string): Promise<string | null> {
    const task = this.chain.then(async () => {
      try {
        // hard-space consecutive inferences, then wait for an idle slot so we don't
        // spike load or hitch a frame at kickoff.
        const gap = MIN_GAP_MS - (Date.now() - this.lastRun);
        if (gap > 0) await sleep(gap);
        await whenIdle();
        this.lastRun = Date.now();
        const s = await this.ensureSession();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        try {
          const out = await s.prompt(input, { signal: ctl.signal });
          return clean(out);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.warn("[npcchat] prompt failed", e);
        // a poisoned session won't recover — drop it so the next call rebuilds.
        const dead = this.sessionP;
        this.sessionP = null;
        dead?.then((s) => { try { s.destroy?.(); } catch { /* */ } }, () => { /* */ });
        return null;
      }
    });
    // keep the chain alive even if this task rejected (it can't, but be safe)
    this.chain = task.catch(() => null);
    return task;
  }
}

/** a no-op used when the Prompt API isn't available — callers need not branch. */
const DISABLED: NpcChat = {
  ready: false,
  status: "unavailable",
  async line() { return null; },
  async provision() { return false; },
};

/** Feature-detect the model and report its availability, WITHOUT downloading it.
 *  Resolves to a working NpcChat (whose `.status` tells the caller whether a one-time
 *  download is still needed) or the disabled stub. The heavy download only happens
 *  later, on explicit user consent, via `chat.provision()`. */
export async function initNpcChat(): Promise<NpcChat> {
  // The desktop shell (app://) is open Chromium: it exposes the whole Prompt API
  // surface but as an ECHO STUB — availability() says "downloadable", create()
  // "succeeds" instantly, and prompt() parrots the input behind a disclaimer
  // (verified empirically in the packaged app). Don't tease a toggle that can
  // never produce a real model there.
  if (location.protocol === "app:") {
    console.info("[npcchat] desktop shell (open Chromium) — Prompt API is an echo stub, banter disabled");
    return DISABLED;
  }
  const factory = locateFactory();
  if (!factory) {
    console.info("[npcchat] Prompt API not available — NPC AI banter disabled");
    return DISABLED;
  }
  try {
    let status: Availability = "available";
    if (factory.availability) status = await factory.availability();
    if (status === "unavailable") {
      console.info("[npcchat] model unavailable on this device — banter disabled");
      return DISABLED;
    }
    console.info(`[npcchat] Prompt API present (status: ${status})`);
    return new LiveNpcChat(factory, status);
  } catch (e) {
    console.warn("[npcchat] init failed — banter disabled", e);
    return DISABLED;
  }
}

/** squeeze a model reply into a single tidy chat line. */
function clean(raw: string): string | null {
  let s = (raw || "").trim();
  if (!s) return null;
  // some Chromium builds ship a stub Prompt API that just echoes the input back
  // instead of running a model — never surface that (or a leaked prompt) as chat.
  const lo = s.toLowerCase();
  if (lo.includes("echoing back the input") || lo.includes("role-play an npc")) return null;
  s = s.split("\n")[0].trim();          // first line only
  s = s.replace(/^["'`]|["'`]$/g, "");  // strip wrapping quotes
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || null;
}
