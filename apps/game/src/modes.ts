// ─── Game modes: metadata + per-mode tuning shared by host & guests ──────────
import { HillOwner, ModeId, WeaponId } from "./types";

export interface ModeDef {
  id: ModeId;
  name: string;
  blurb: string;
  teams: boolean;      // two-sided (TDM sides / Prop Hunt roles)
  respawn: number;     // respawn delay (s)
}

export const MODES: Record<ModeId, ModeDef> = {
  ffa:      { id: "ffa",      name: "Free for All",    blurb: "Everyone for themselves — most kills wins.",          teams: false, respawn: 3 },
  tdm:      { id: "tdm",      name: "Team Deathmatch", blurb: "Alpha vs Bravo — highest team score wins.",           teams: true,  respawn: 3 },
  gungame:  { id: "gungame",  name: "Gun Game",        blurb: "Every kill upgrades your gun. First to the knife wins.", teams: false, respawn: 2 },
  prophunt: { id: "prophunt", name: "Prop Hunt",       blurb: "Hiders disguise as crates. Seekers hunt them down.",  teams: true,  respawn: 3 },
  hardpoint:{ id: "hardpoint",name: "Hardpoint",       blurb: "Hold the hill to score — it keeps moving. First team to 250 wins.", teams: true, respawn: 3 },
};

export const MODE_LIST: ModeId[] = ["ffa", "tdm", "gungame", "prophunt", "hardpoint"];
export const DEFAULT_MODE: ModeId = "ffa";

export function modeById(id: string): ModeDef {
  return MODES[id as ModeId] ?? MODES.ffa;
}

// ── teams (TDM) ──
export const TEAM_COLORS: [number, number] = [0xe0553f, 0x4d8dff]; // Alpha red · Bravo blue
export const TEAM_NAMES: [string, string] = ["Alpha", "Bravo"];

// ── Gun Game weapon ladder (final tier = knife → instant win) ──
// Every damage-dealing weapon in the roster (flash/smoke/portalgun deal none), running
// autos → precision → sidearms → throwables, so the kit gets harder as you climb.
export const GUNGAME_TIERS: WeaponId[] = [
  "m4a1", "ak47", "suomi", "grease", "shotgun", "awp", "usp", "luger", "he", "mol", "knife",
];
export function tierWeapon(tier: number): WeaponId {
  return GUNGAME_TIERS[Math.min(tier, GUNGAME_TIERS.length - 1)];
}
export const GUNGAME_FINAL = GUNGAME_TIERS.length - 1;

// ── Prop Hunt ──
export const PROPHUNT_PREP = 8;         // s the seekers are frozen while hiders scatter
export const ROLE_SEEK = 0;
export const ROLE_HIDE = 1;
/** number of seekers for a lobby of n players (rest are hiders) */
export function seekerCount(n: number): number { return Math.max(1, Math.floor(n / 3)); }

// ── Hardpoint ──
export const HARDPOINT_TARGET = 250;    // team score that instantly ends the match
export const HARDPOINT_RATE = 1;        // points per second of an uncontested hold
export const HARDPOINT_RADIUS = 6;      // capture-zone radius (m, XZ)
export const HARDPOINT_YTOL = 3;        // vertical slack — a floor above/below doesn't count
export const HARDPOINT_ROTATE = 45;     // s before the hill relocates to the next candidate
export const HARDPOINT_WARN = 5;        // s of "moving soon" warning before it does
export const HARDPOINT_SPOTS = 4;       // max derived hill candidates on maps without markers
export const HILL_NEUTRAL: HillOwner = -1;
export const HILL_CONTESTED: HillOwner = 2;
/** hill tint for an owner state: side colour, white when empty, yellow when contested */
export function hillColor(o: HillOwner): number {
  return o === 0 || o === 1 ? TEAM_COLORS[o] : o === HILL_CONTESTED ? 0xffd23f : 0xffffff;
}
