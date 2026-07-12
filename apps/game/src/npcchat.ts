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
type Availability = "unavailable" | "downloadable" | "downloading" | "available";

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

export interface NpcChat {
  readonly ready: boolean;
  line(req: LineReq): Promise<string | null>;
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

/** the live implementation, created only once the model is confirmed usable. */
class LiveNpcChat implements NpcChat {
  ready = true;
  private sessionP: Promise<LMSession> | null = null;  // shared, in-flight session
  private chain: Promise<unknown> = Promise.resolve(); // serialize prompts (one model)
  private lastRun = 0;                                  // wall-clock ms of the last inference

  constructor(
    private factory: LMFactory,
    /** progress sink (0→1) for the first-run model download, if one is needed. */
    private onProgress?: (loaded: number) => void,
  ) {}

  /** provision the model eagerly (rather than lazily on the first line) so a boot
   *  overlay can show download progress. Resolves when ready; rejects on failure. */
  prewarm(): Promise<void> {
    return this.ensureSession().then(() => undefined);
  }

  private ensureSession(): Promise<LMSession> {
    if (this.sessionP) return this.sessionP;
    const onProgress = this.onProgress;
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
  async line() { return null; },
};

/** Progress callbacks for the (potentially minutes-long) first-run model download.
 *  All optional — the model is fully usable without wiring any of them up. */
export interface NpcDownloadHooks {
  /** a first-run model download has started (nothing to show if already cached). */
  onStart?(): void;
  /** download progress, as a fraction 0→1. */
  onProgress?(loaded: number): void;
  /** the model finished downloading and is ready to use. */
  onDone?(): void;
  /** provisioning failed — the overlay should be dismissed. */
  onError?(): void;
}

/** Feature-detect + provision the model. Resolves to a working NpcChat, or the
 *  disabled stub. Safe to call once at boot. When a first-run download is needed it
 *  is kicked off in the background and reported through `hooks`; the returned chat is
 *  usable right away (lines just wait for the download to finish). */
export async function initNpcChat(hooks?: NpcDownloadHooks): Promise<NpcChat> {
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
    const needsDownload = status === "downloadable" || status === "downloading";
    const chat = new LiveNpcChat(factory, needsDownload ? hooks?.onProgress : undefined);
    if (needsDownload) {
      // Provision now (instead of lazily on the first line) so the UI can show a
      // progress overlay while the on-device model streams in — this can take a
      // while, and the player is free to keep using the client meanwhile.
      hooks?.onStart?.();
      void chat.prewarm().then(
        () => hooks?.onDone?.(),
        (e) => { console.warn("[npcchat] model download failed", e); hooks?.onError?.(); },
      );
    }
    console.info(`[npcchat] Prompt API present (status: ${status}) — NPC banter ON`);
    return chat;
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
