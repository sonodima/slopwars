// ─── Shared types, tuning constants, protocol ───────────────────────────────

export type Vec3 = { x: number; y: number; z: number };

export const TICK_RATE = 15; // net state send Hz
export const INTERP_DELAY = 0.12; // s
export const ROUND_TIME = 240; // s
export const ROUNDS_PER_GAME = 4;
export const INTERMISSION = 10; // s
export const RESPAWN_TIME = 3; // s
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
}
export const DEFAULT_CONFIG: MatchConfig = {
  bots: 0, difficulty: "normal", rounds: ROUNDS_PER_GAME, roundTime: ROUND_TIME, gravity: 1, speed: 1,
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
/** per-difficulty bot tuning: hit chance base, fire-cadence scale, damage scale */
export const BOT_TUNING: Record<BotLevel, { aim: number; rate: number; dmg: number }> = {
  easy:   { aim: 0.5,  rate: 1.4, dmg: 0.7 },
  normal: { aim: 0.72, rate: 1.0, dmg: 1.0 },
  hard:   { aim: 0.9,  rate: 0.7, dmg: 1.3 },
};

// movement (quake/krunker style)
export const MOVE = {
  eyeHeight: 1.62,
  eyeCrouch: 1.08,
  height: 1.8,
  crouchHeight: 1.25,
  radius: 0.38,
  gravity: 19,
  jumpVel: 6.6,
  groundSpeed: 8.6,
  crouchFactor: 0.55,
  groundAccel: 13,
  friction: 6.0,
  airAccel: 38,
  airWishCap: 1.1,
  stepHeight: 0.55,
  stopSpeed: 1.2,
  sprintFactor: 1.4, // ground max-speed multiplier while sprinting
};

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

export type WeaponId = "knife" | "usp" | "ak47" | "awp" | "he" | "mol";

export interface WeaponDef {
  id: WeaponId;
  name: string;
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
  scope?: boolean;
  melee?: boolean;
  throwable?: boolean;
  auto: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: "knife", name: "Knife", damage: 55, headMult: 1.4, rpm: 150, mag: -1,
    reserve: -1, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 2.3, moveFactor: 1.12, melee: true, auto: false,
  },
  usp: {
    id: "usp", name: "USP-S", damage: 34, headMult: 4, rpm: 352, mag: 12,
    reserve: 48, reloadTime: 2.0, spread: 0.006, spreadMove: 0.02, recoil: 0.9,
    penetration: 0.28, penDamageKeep: 0.5, falloff: [14, 45, 0.55], range: 400, moveFactor: 1.0, auto: false,
  },
  ak47: {
    id: "ak47", name: "AK-47", damage: 34, headMult: 4, rpm: 600, mag: 30,
    reserve: 90, reloadTime: 2.4, spread: 0.008, spreadMove: 0.045, recoil: 1.35,
    penetration: 0.45, penDamageKeep: 0.62, falloff: [20, 60, 0.6], range: 800, moveFactor: 0.92, auto: true,
  },
  awp: {
    id: "awp", name: "AWP", damage: 112, headMult: 2.4, rpm: 41, mag: 5,
    reserve: 15, reloadTime: 3.6, spread: 0.05, spreadMove: 0.08, recoil: 3.2,
    penetration: 0.7, penDamageKeep: 0.75, falloff: [45, 130, 0.82], range: 1200, moveFactor: 0.82, scope: true, auto: false,
  },
  he: {
    id: "he", name: "HE Grenade", damage: 92, headMult: 1, rpm: 55, mag: 2,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
  mol: {
    id: "mol", name: "Molotov", damage: 12, headMult: 1, rpm: 55, mag: 1,
    reserve: 0, reloadTime: 0, spread: 0, spreadMove: 0, recoil: 0,
    penetration: 0, penDamageKeep: 0, falloff: [999, 1000, 1], range: 0, moveFactor: 1.05, throwable: true, auto: false,
  },
};

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

export interface PlayerState {
  id: string;
  p: [number, number, number]; // feet pos
  yaw: number;
  pitch: number;
  cr: 0 | 1; // crouch
  w: WeaponId;
  hp: number;
}

export type GamePhase = "lobby" | "play" | "inter" | "over";

export type ModeId = "ffa" | "tdm" | "gungame" | "prophunt";

export interface GameSnapshot {
  phase: GamePhase;
  round: number;
  timeLeft: number;
  scores: Record<string, { k: number; d: number }>;
  pk: number[]; // pickup respawn timers (0 = available)
  map: string;  // currently loaded map id
  mode: ModeId; // active game mode
  cfg?: MatchConfig; // host match rules
  teams?: Record<string, number>;  // tdm: 0/1 side · prophunt: 0 seeker / 1 hider
  teamScore?: [number, number];    // tdm: side scores · prophunt: [seeker, hider] round wins
  tiers?: Record<string, number>;  // gungame: player → weapon-ladder tier
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
  | { t: "nade"; id: string; k: "he" | "mol"; o: [number, number, number]; v: [number, number, number] }
  | { t: "heal"; v: string; hp: number }
  | { t: "pkup"; i: number }
  | { t: "bhit"; i: number; dmg: number } // guest → host: damaged barrel i
  | { t: "bexp"; i: number }              // host → all: barrel i exploded
  | { t: "pwspawn"; i: number; k: PowerupKind }              // host → all: powerup i appeared
  | { t: "pwtake"; i: number; who: string; k: PowerupKind }  // host → all: player took powerup i
  | { t: "mapvote"; map: string }                            // guest → host: vote for next map
  | { t: "votes"; counts: Record<string, number> }           // host → all: live vote tally
  | { t: "mode"; mode: ModeId }                              // host → all: lobby mode selection
  | { t: "cfg"; cfg: MatchConfig }                           // host → all: lobby match-rules change
  | { t: "role"; role: number; prop: number }                // host → one: prophunt role + disguise
  | { t: "tier"; tier: number }                              // host → one: gungame tier changed
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "leave" };

export function rand(a: number, b: number): number { return a + Math.random() * (b - a); }
export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
