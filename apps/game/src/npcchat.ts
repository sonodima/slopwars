// ─── Chrome built-in AI (Prompt API) → NPC trash-talk ────────────────────────
// EXPERIMENTAL / host-only. Uses the on-device Gemini Nano model exposed by
// Chrome's Prompt API (the `LanguageModel` global, or the legacy
// `window.ai.languageModel`). Everything here degrades to a silent no-op when the
// API is absent or the model can't be provisioned, so non-Chrome players simply
// never see AI banter — the rest of the game is unaffected.
//
// Two situations produce lines, both driven by the host (bots only exist there):
//   • a human kills the same bot repeatedly  → that bot taunts them by name
//   • a human types in chat                  → one or more bots fire back
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
  "You role-play a cocky NPC bot in a fast-paced multiplayer FPS. You only ever " +
  "produce ONE short line of in-game chat trash-talk: max 12 words, no quotes, no " +
  "emoji, no line breaks, all lowercase, casual gamer slang. Stay playful, never " +
  "slurs or hate. Output only the line itself.";

export interface NpcChat {
  readonly ready: boolean;
  taunt(player: string, bot: string, deaths: number): Promise<string | null>;
  reply(bot: string, playerName: string, playerMsg: string, transcript: string[]): Promise<string | null>;
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
      temperature: 1.1,
      topK: 8,
    });
    return this.session;
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

  taunt(player: string, bot: string, deaths: number): Promise<string | null> {
    return this.run(
      `You are the bot "${bot}". The player "${player}" has now killed you ${deaths} ` +
      `times this match. Fire back one salty line that names ${player}.`,
    );
  }

  reply(bot: string, playerName: string, playerMsg: string, transcript: string[]): Promise<string | null> {
    const ctx = transcript.slice(-6).join("\n");
    return this.run(
      `You are the bot "${bot}" in a match. Recent chat:\n${ctx}\n\n` +
      `The player "${playerName}" just said: "${playerMsg}"\n` +
      `Reply with one short in-character line reacting to them.`,
    );
  }
}

/** a no-op used when the Prompt API isn't available — callers need not branch. */
const DISABLED: NpcChat = {
  ready: false,
  async taunt() { return null; },
  async reply() { return null; },
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
  s = s.split("\n")[0].trim();          // first line only
  s = s.replace(/^["'`]|["'`]$/g, "");  // strip wrapping quotes
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || null;
}
