// ─── Shared types, tuning constants, protocol ───────────────────────────────

export type Vec3 = { x: number; y: number; z: number };

export const TICK_RATE = 15; // net state send Hz
export const INTERP_DELAY = 0.12; // s
export const ROUND_TIME = 240; // s
export const ROUNDS_PER_GAME = 4;
export const INTERMISSION = 10; // s
export const DEPLOY_TIME = 6;   // s — pre-round freeze: everyone spawned but locked, picking a class
export const RESPAWN_TIME = 3; // s
export const SPAWN_PROT = 3;   // s of post-spawn invulnerability — ends early on your first shot
export const MAX_HP = 100;

// ─── Host-configurable match rules (set in the lobby, mirrored to guests) ─────
export type BotLevel = "easy" | "normal" | "hard";
export interface MatchConfig {
  bots: number;        // number of AI opponents to add (0 = pure multiplayer)
  difficulty: BotLevel; // bot skill
  rounds: number;      // rounds per match
  roundTime: number;   // seconds per round
  gravity: number;     // gravity scale (1 = normal)
  speed: number;       // movement-speed scale (1 = normal)
  thirdPerson: boolean; // whole match plays in a behind-the-back third-person camera
  aiChat: boolean;     // host runs the on-device LLM for NPC trash-talk (Chrome only)
  startMap?: string;   // host's chosen map for round 1 (undefined → random from rotation)
}
export const DEFAULT_CONFIG: MatchConfig = {
  bots: 0, difficulty: "normal", rounds: ROUNDS_PER_GAME, roundTime: ROUND_TIME, gravity: 1, speed: 1,
  thirdPerson: false, aiChat: false, // opt-in: driven by the host's client setting once the model is ready
};
// slider bounds (shared by lobby UI + clamping)
export const CFG_BOUNDS = {
  bots: [0, 7] as const,
  rounds: [1, 9] as const,
  roundTime: [60, 480] as const, // 1–8 min
  gravity: [0.4, 1.8] as const,
  speed: [0.6, 1.8] as const,
};
export const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
/** per-difficulty bot tuning. Beyond raw hit/damage, these shape *how human* the bot
 *  feels: how fast it can swing its aim (turn), how long before it reacts to a target it
 *  just spotted (react), how wide it can see (fov, half-angle rad), how long it remembers a
 *  target it lost sight of (memory), and how much its aim wobbles (err, rad). Low turn +
 *  real reaction + wobble is what stops a bot from reading as an aimbot. */
export const BOT_TUNING: Record<BotLevel, {
  aim: number;    // base hit probability at point-blank (falls off with range)
  rate: number;   // fire-cadence scale (higher = slower between shots)
  dmg: number;    // damage scale
  turn: number;   // max aim slew speed (rad/s) — caps the instant snap
  react: number;  // reaction delay after (re)spotting a target before it can fire (s)
  fov: number;    // vision half-angle (rad); target outside the cone is unseen unless point-blank
  memory: number; // seconds a lost target's last-known position is remembered / hunted
  err: number;    // aim wobble magnitude (rad) — bigger = shakier, more human tracking
}> = {
  easy:   { aim: 0.42, rate: 1.5,  dmg: 0.7,  turn: 3.4,  react: 0.55, fov: 1.05, memory: 1.0, err: 0.115 },
  normal: { aim: 0.66, rate: 1.0,  dmg: 1.0,  turn: 6.5,  react: 0.32, fov: 1.30, memory: 2.2, err: 0.055 },
  hard:   { aim: 0.86, rate: 0.72, dmg: 1.25, turn: 11.5, react: 0.17, fov: 1.55, memory: 3.6, err: 0.024 },
};

/** weapons a bot may spawn carrying (non-gungame modes), rifle-weighted. AWP/USP/knife
 *  give bots distinct engagement ranges + cadences so not every fight is the same AK duel. */
export const BOT_WEAPONS: { w: WeaponId; weight: number }[] = [
  { w: "ak47",  weight: 56 },
  { w: "usp",   weight: 24 },
  { w: "awp",   weight: 14 },
  { w: "knife", weight: 6 },
];
export function pickBotWeapon(): WeaponId {
  const total = BOT_WEAPONS.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of BOT_WEAPONS) { if ((r -= e.weight) <= 0) return e.w; }
  return "ak47";
}

// movement (quake/krunker style)
export const MOVE = {
  eyeHeight: 1.62,
  height: 1.8,
  radius: 0.38,
  gravity: 19,
  jumpVel: 6.6,
  groundSpeed: 8.6,
  groundAccel: 13,
  friction: 6.0,
  airAccel: 38,
  airWishCap: 1.1,
  stepHeight: 0.55,
  stopSpeed: 1.2,
  sprintFactor: 1.75, // ground max-speed multiplier while sprinting
};

// directional move penalties (classic FPS feel): slower moving backward / sideways
export const MOVE_BACK_FACTOR = 0.72;
export const MOVE_STRAFE_FACTOR = 0.85;

export const PICKUP_HEAL = 25;
export const PICKUP_RESPAWN = 15; // s
export const PICKUP_RADIUS = 1.1;

// ─── Powerups / modifiers (timed buffs, rarity-weighted spawns) ──────────────
export type PowerupKind = "speed" | "rapid" | "quad";
export interface PowerupDef { kind: PowerupKind; name: string; color: number; duration: number; weight: number }
export const POWERUPS: Record<PowerupKind, PowerupDef> = {
  speed: { kind: "speed", name: "Speed",       color: 0x3fd0ff, duration: 8, weight: 60 }, // common
  rapid: { kind: "rapid", name: "Rapid Fire",  color: 0xffd23f, duration: 7, weight: 30 }, // uncommon
  quad:  { kind: "quad",  name: "Quad Damage", color: 0xc23fff, duration: 6, weight: 10 }, // rare
};
export const POWERUP_RADIUS = 1.3;
export const POWERUP_INTERVAL = 16; // s between host spawn attempts
export const SPEED_MULT = 1.6;
export const RAPID_MULT = 0.5; // cooldown scale
export const QUAD_MULT = 4;

/** rarity-weighted random powerup kind */
export function randomPowerup(): PowerupKind {
  const kinds = Object.values(POWERUPS);
  const total = kinds.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of kinds) { if ((r -= p.weight) <= 0) return p.kind; }
  return "speed";
}

export type WeaponId =
  | "knife" | "usp" | "ak47" | "awp" | "he" | "mol"
  | "m4a1" | "shotgun" | "grease" | "suomi" | "luger" | "flash" | "smoke" | "portalgun";

/** Loadout slot a weapon occupies. Drives the class system (one pick per slot) and the
 *  order weapons appear on the HUD / weapon wheel. `utility` holds throwables (a class may
 *  carry more than one), everything else is a single pick. */
export type WeaponCategory = "melee" | "secondary" | "primary" | "utility";

/** the throwable weapons — the subset of WeaponId that spawns a projectile. Shared by the
 *  projectile system and the net protocol so a thrown grenade replicates to every peer. */
export type ThrowableKind = "he" | "mol" | "flash" | "smoke";

export interface WeaponDef {
  id: WeaponId;
  name: string;
  category: WeaponCategory;
  damage: number;
  headMult: number;
  rpm: number;
  mag: number;
  reserve: number;
  reloadTime: number;
  spread: number; // base rad
  spreadMove: number; // extra at full speed
  recoil: number; // camera pitch kick deg
  penetration: number; // max wall thickness (m), 0 = none
  penDamageKeep: number; // damage kept after wallbang
  falloff: [number, number, number]; // [startDist, endDist, minFactor]
  range: number;
  moveFactor: number;
  pellets?: number; // >1 = one trigger pull fires this many spread rays (shotgun)
  scope?: boolean;
  melee?: boolean;
  throwable?: boolean;
  portal?: boolean; // fires portal placements (portals.ts) instead of rays/projectiles
  auto: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: "knife", name: "Knife", category: "melee", damage: 55, headMult: 1.4, rpm: 150, mag: -1,
    reserve: -1, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 2.3, moveFactor: 1.12, melee: true, auto: false,
  },
  usp: {
    id: "usp", name: "USP-S", category: "secondary", damage: 34, headMult: 4, rpm: 352, mag: 12,
    reserve: 48, reloadTime: 1.5, spread: 0.006, spreadMove: 0.02, recoil: 0.9,
    penetration: 0.28, penDamageKeep: 0.5, falloff: [14, 45, 0.55], range: 400, moveFactor: 1.0, auto: false,
  },
  luger: {
    id: "luger", name: "Luger P08", category: "secondary", damage: 30, headMult: 4, rpm: 400, mag: 8,
    reserve: 48, reloadTime: 1.4, spread: 0.007, spreadMove: 0.022, recoil: 1.0,
    penetration: 0.25, penDamageKeep: 0.5, falloff: [13, 42, 0.52], range: 380, moveFactor: 1.0, auto: false,
  },
  ak47: {
    id: "ak47", name: "AK-47", category: "primary", damage: 34, headMult: 4, rpm: 600, mag: 30,
    reserve: 90, reloadTime: 1.8, spread: 0.008, spreadMove: 0.045, recoil: 1.35,
    penetration: 0.45, penDamageKeep: 0.62, falloff: [20, 60, 0.6], range: 800, moveFactor: 0.92, auto: true,
  },
  m4a1: {
    id: "m4a1", name: "M4A1", category: "primary", damage: 30, headMult: 4, rpm: 666, mag: 30,
    reserve: 90, reloadTime: 1.9, spread: 0.006, spreadMove: 0.04, recoil: 1.05,
    penetration: 0.4, penDamageKeep: 0.6, falloff: [22, 64, 0.62], range: 800, moveFactor: 0.93, auto: true,
  },
  suomi: {
    id: "suomi", name: "Suomi KP/-31", category: "primary", damage: 22, headMult: 3, rpm: 750, mag: 36,
    reserve: 108, reloadTime: 2.0, spread: 0.016, spreadMove: 0.06, recoil: 0.8,
    penetration: 0.18, penDamageKeep: 0.4, falloff: [10, 34, 0.45], range: 260, moveFactor: 1.04, auto: true,
  },
  grease: {
    id: "grease", name: "M3 Grease Gun", category: "primary", damage: 26, headMult: 3, rpm: 450, mag: 30,
    reserve: 90, reloadTime: 1.9, spread: 0.014, spreadMove: 0.05, recoil: 0.9,
    penetration: 0.2, penDamageKeep: 0.45, falloff: [12, 40, 0.5], range: 300, moveFactor: 1.02, auto: true,
  },
  shotgun: {
    id: "shotgun", name: "Shotgun", category: "primary", damage: 40, headMult: 2, rpm: 70, mag: 6,
    reserve: 24, reloadTime: 2.5, spread: 0.2, spreadMove: 0.05, recoil: 3.0,
    penetration: 0, penDamageKeep: 0, falloff: [6, 22, 0.25], range: 45, moveFactor: 0.9, pellets: 8, auto: false,
  },
  awp: {
    id: "awp", name: "AWP", category: "primary", damage: 112, headMult: 2.4, rpm: 41, mag: 5,
    reserve: 15, reloadTime: 2.7, spread: 0.05, spreadMove: 0.08, recoil: 3.2,
    penetration: 0.7, penDamageKeep: 0.75, falloff: [45, 130, 0.82], range: 1200, moveFactor: 0.82, scope: true, auto: false,
  },
  he: {
    id: "he", name: "HE Grenade", category: "utility", damage: 92, headMult: 1, rpm: 55, mag: 2,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
  mol: {
    id: "mol", name: "Molotov", category: "utility", damage: 12, headMult: 1, rpm: 55, mag: 1,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
  flash: {
    id: "flash", name: "Flashbang", category: "utility", damage: 0, headMult: 1, rpm: 55, mag: 2,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
  smoke: {
    id: "smoke", name: "Smoke Grenade", category: "utility", damage: 0, headMult: 1, rpm: 55, mag: 1,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
  // fires no rays: each trigger pull places the next portal of the blue/orange pair
  // (see main.firePortal / portals.ts). `range` is the placement raycast reach; the
  // -1 mag is the melee-style "infinite" sentinel — a portal gun never runs dry.
  portalgun: {
    id: "portalgun", name: "Portal Gun", category: "utility", damage: 0, headMult: 1, rpm: 75, mag: -1,
    reserve: -1, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 48, moveFactor: 1.05, portal: true, auto: false,
  },
};

/** every weapon that exists, in canonical order (viewmodels + weapon-wheel ordering).
 *  A player's *active* inventory is a per-class subset — see classes.ts / WeaponSystem. */
export const ALL_WEAPONS: WeaponId[] = [
  "knife", "usp", "luger", "ak47", "m4a1", "suomi", "grease", "shotgun", "awp", "he", "mol", "flash", "smoke", "portalgun",
];

/** the default inventory used before a class is applied (and by the gungame ladder /
 *  bots as a safe fallback). Kept to the classic six so nothing that reads it breaks. */
export const LOADOUT: WeaponId[] = ["knife", "usp", "ak47", "awp", "he", "mol"];

/** what killed a player: a weapon, or an environmental cause (an exploding barrel).
 *  Kept distinct from WeaponId so the loadout/weapon systems stay weapon-only while
 *  the kill feed + stats can still attribute environmental deaths correctly. Extend
 *  this union (and deathCauseLabel) as new hazards are added (fall, fire pit…). */
export type DeathCause = WeaponId | "barrel";

/** display name for a death cause, used by the kill feed */
export function deathCauseLabel(c: DeathCause): string {
  return c === "barrel" ? "Barrel" : WEAPONS[c].name;
}

// ─── Net protocol ────────────────────────────────────────────────────────────

export interface PlayerInfo { id: string; name: string; color: number }

/** The input device a player is currently using. Shown as an icon in player lists /
 *  leaderboards. A player can switch device mid-match (mouse → gamepad → touch), so this
 *  is live state, not fixed at join. `bot` is the AI opponents' pseudo-platform. */
export type Platform = "keyboard" | "gamepad" | "touch" | "bot";

export interface PlayerState {
  id: string;
  p: [number, number, number]; // feet pos
  yaw: number;
  pitch: number;
  w: WeaponId;
  hp: number;
  g?: boolean; // onGround — drives the remote's jump/fall animation (undefined → infer from motion)
}

export type GamePhase = "lobby" | "deploy" | "play" | "inter" | "over";

export type ModeId = "ffa" | "tdm" | "gungame" | "prophunt" | "hardpoint";

/** who holds the hardpoint hill: -1 empty · 0/1 the capturing side · 2 both inside (contested) */
export type HillOwner = -1 | 0 | 1 | 2;

export interface GameSnapshot {
  phase: GamePhase;
  round: number;
  timeLeft: number;
  scores: Record<string, { k: number; d: number }>;
  pk: number[]; // pickup respawn timers (0 = available)
  map: string;  // currently loaded map id
  mode: ModeId; // active game mode
  cfg?: MatchConfig; // host match rules
  teams?: Record<string, number>;  // tdm/hardpoint: 0/1 side · prophunt: 0 seeker / 1 hider
  teamScore?: [number, number];    // tdm/hardpoint: side scores · prophunt: [seeker, hider] round wins
  tiers?: Record<string, number>;  // gungame: player → weapon-ladder tier
  props?: Record<string, number>;  // prophunt: player → disguise roll (host-rolled per round; mod pool length at use)
  hill?: { i: number; owner: HillOwner; progress: number }; // hardpoint: active spot, holder, 0..1 of the rotate window
  platforms?: Record<string, Platform>; // per-player current input device (icons in lists)
}

export type Msg =
  | { t: "hello"; name: string }
  | { t: "init"; id: string; players: PlayerInfo[]; game: GameSnapshot }
  | { t: "pjoin"; p: PlayerInfo }
  | { t: "pleave"; id: string }
  | { t: "state"; s: PlayerState }
  | { t: "snap"; ps: PlayerState[]; time: number }
  | { t: "shot"; id: string; o: [number, number, number]; d: [number, number, number]; w: WeaponId }
  | { t: "hit"; v: string; dmg: number; hs: 0 | 1; w: DeathCause }
  | { t: "dmg"; v: string; hp: number; a: string; from: [number, number, number] }
  | { t: "kill"; k: string; v: string; w: DeathCause; hs: 0 | 1 }
  | { t: "spawn"; id: string; p: [number, number, number]; yaw: number }
  | { t: "game"; g: GameSnapshot }
  | { t: "start" }
  | { t: "chat"; id: string; txt: string }
  | { t: "nade"; id: string; k: ThrowableKind; o: [number, number, number]; v: [number, number, number] }
  | { t: "heal"; v: string; hp: number }
  | { t: "pkup"; i: number }
  | { t: "bhit"; i: number; dmg: number } // guest → host: damaged barrel i
  | { t: "bexp"; i: number }              // host → all: barrel i exploded
  | { t: "pwspawn"; i: number; k: PowerupKind }              // host → all: powerup i appeared
  | { t: "pwtake"; i: number; who: string; k: PowerupKind }  // host → all: player took powerup i
  | { t: "portal"; id: string; s: 0 | 1; o: [number, number, number]; n: [number, number, number] } // player id placed portal s (0 blue / 1 orange) at o with surface normal n
  | { t: "pgone"; id: string; s: 0 | 1 }                     // player id's portal s expired (death/leave are inferred locally)
  | { t: "mapvote"; map: string }                            // guest → host: vote for next map
  | { t: "votes"; counts: Record<string, number> }           // host → all: live vote tally
  | { t: "mode"; mode: ModeId }                              // host → all: lobby mode selection
  | { t: "cfg"; cfg: MatchConfig }                           // host → all: lobby match-rules change
  | { t: "role"; role: number; prop: number }                // host → one: prophunt role + disguise
  | { t: "tier"; tier: number }                              // host → one: gungame tier changed
  | { t: "hill"; i: number }                                 // host → all: hardpoint hill relocated to spot i
  | { t: "plat"; id: string; plat: Platform }                // any → all: player switched input device
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "leave" }              // guest → host: I'm leaving
  | { t: "hostleave" }          // host → all: I'm closing the lobby
  | { t: "reject"; reason: "version"; hostV: string } // host → one: join refused (guest knows its own version)
  | { t: "kicked" };            // host → one: you were removed from the lobby/match

export function rand(a: number, b: number): number { return a + Math.random() * (b - a); }
export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
