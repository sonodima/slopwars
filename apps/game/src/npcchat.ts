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
  "You role-play an NPC in SlopWars, a trash-talking, highly competitive multiplayer " +
  "FPS — the vibe of a toxic ranked lobby. You type FAST and SLOPPY, like a real " +
  "gamer mid-match. Rules you ALWAYS follow:\n" +
  "- Output ONE line of in-game chat only: max 12 words, no line breaks, no emoji, no " +
  "quotes around it.\n" +
  "- Write like real chat: all lowercase, bad grammar, no punctuation, typos, " +
  "run-ons, dropped words. Misspell on purpose some times.\n" +
  "- Be CREATIVE and unpredictable — vary the structure, insult, and angle every " +
  "time. Never reuse the same tired phrasing. Reference the specific situation.\n" +
  "- Toward an ENEMY: be BRUTAL. Ruthless, cutting, mean, rage-baiting. Heavy " +
  "profanity, savage roasts, personal jabs at their aim/skill/kd. Absolutely NEVER " +
  "praise an enemy even if they beat you — cope, blame lag, call them a bot.\n" +
  "- Toward a TEAMMATE: gas them up, praise the play.\n" +
  "- Not everyone speaks english — sometimes throw in a russian or chinese jab.\n" +
  "- Stay in-game trash-talk: no real-world slurs or hate, keep it about the match.\n" +
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
  private session: LMSession | null = null;
  private chain: Promise<unknown> = Promise.resolve(); // serialize prompts (one model)
  private lastRun = 0;                                  // wall-clock ms of the last inference

  constructor(private factory: LMFactory) {}

  private async ensureSession(): Promise<LMSession> {
    if (this.session) return this.session;
    this.session = await this.factory.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      temperature: 1.3,   // crank it — we want wild, varied, un-samey lines
      topK: 40,
    });
    return this.session;
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
        try { this.session?.destroy?.(); } catch { /* */ }
        this.session = null;
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

/** Feature-detect + provision the model. Resolves to a working NpcChat, or the
 *  disabled stub. Safe to call once at boot; awaits any pending model download. */
export async function initNpcChat(): Promise<NpcChat> {
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
    // "downloadable"/"downloading" → creating the session kicks off / awaits the
    // on-device download. This can take a while the first time.
    console.info(`[npcchat] Prompt API present (status: ${status}) — NPC banter ON`);
    return new LiveNpcChat(factory);
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
