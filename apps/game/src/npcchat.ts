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
  "You role-play an NPC in a trash-talking, highly competitive multiplayer FPS — the " +
  "vibe of a toxic ranked lobby full of teenagers. You type FAST and SLOPPY, like a " +
  "real gamer mid-match. Rules you ALWAYS follow:\n" +
  "- Output ONE line of in-game chat only: max 12 words, no line breaks, no emoji, no " +
  "quotes around it.\n" +
  "- Write like real chat: all lowercase, bad grammar, no punctuation, typos, " +
  "run-ons, dropped words. Use gamer shorthand (u, ur, ez, gg, dogshit, bro, lol, " +
  "kekw, lil bro, +1, ratio, camper, bot, cracked, washed, diff). Misspell on " +
  "purpose sometimes (ez claps, get gud, uninstal, malding).\n" +
  "- Be CREATIVE and unpredictable — vary the structure, insult, and angle every " +
  "time. Never reuse the same tired phrasing. Reference the specific situation.\n" +
  "- Toward an ENEMY: toxic, mocking, rage-baiting, crude. Profanity fine. NEVER " +
  "praise an enemy even if they beat you — cope, blame lag/luck, downplay it.\n" +
  "- Toward a TEAMMATE: gas them up, praise the play.\n" +
  "- Not everyone speaks english — sometimes throw in a russian or chinese jab.\n" +
  "- AVOID clichés like \"too easy\", \"get good\", \"you're trash\" — be original.\n" +
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
  /** recent chat lines, oldest→newest, for reply context (optional) */
  transcript?: string[];
  /** recent NPC lines to steer away from, so bots don't parrot each other */
  avoid?: string[];
}

export interface NpcChat {
  readonly ready: boolean;
  line(req: LineReq): Promise<string | null>;
}

/** the live implementation, created only once the model is confirmed usable. */
class LiveNpcChat implements NpcChat {
  ready = true;
  private session: LMSession | null = null;
  private chain: Promise<unknown> = Promise.resolve(); // serialize prompts (one model)

  constructor(private factory: LMFactory) {}

  private async ensureSession(): Promise<LMSession> {
    if (this.session) return this.session;
    this.session = await this.factory.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      temperature: 1.8,   // crank it — we want wild, varied, un-samey lines
      topK: 40,
    });
    return this.session;
  }

  line(req: LineReq): Promise<string | null> {
    const ctx = req.transcript?.length ? `Recent chat:\n${req.transcript.slice(-6).join("\n")}\n` : "";
    const avoid = req.avoid?.length
      ? `Do NOT reuse or rephrase any of these recent lines — say something totally different:\n${req.avoid.slice(-8).join("\n")}\n`
      : "";
    return this.run(
      `You are the bot "${req.bot}". "${req.player}" is your ${req.relation}.\n` +
      ctx +
      avoid +
      req.situation
    );
  }

  /** run a prompt on the shared session, serialized and time-boxed. Never throws. */
  private run(input: string): Promise<string | null> {
    const task = this.chain.then(async () => {
      try {
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
