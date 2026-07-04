// ─── Map pool: registry of playable maps + selection helpers ─────────────────
import { MapDef, MapMeta } from "./schema";
import { KOI } from "./koi";
import { WATERFALL } from "./waterfall";
import { NEON_GRAVEYARD } from "./neon";
import { OVERGROWTH } from "./overgrowth";

/** every map available in rotation (order = card order in the vote UI) */
export const MAP_POOL: MapDef[] = [KOI, WATERFALL, NEON_GRAVEYARD, OVERGROWTH];

const BY_ID = new Map(MAP_POOL.map((m) => [m.meta.id, m]));

/** default map shown in the lobby before a match picks one */
export const DEFAULT_MAP = KOI.meta.id;

export function mapById(id: string): MapDef {
  return BY_ID.get(id) ?? KOI;
}

export function mapMetas(): MapMeta[] {
  return MAP_POOL.map((m) => m.meta);
}

/** uniformly random map id from the pool */
export function randomMapId(): string {
  return MAP_POOL[(Math.random() * MAP_POOL.length) | 0].meta.id;
}

/** plurality winner of a vote tally; random tiebreak; random if nobody voted */
export function pickVotedMap(votes: Record<string, string>): string {
  const counts: Record<string, number> = {};
  for (const id of Object.values(votes)) counts[id] = (counts[id] ?? 0) + 1;
  let best = 0;
  let winners: string[] = [];
  for (const m of MAP_POOL) {
    const n = counts[m.meta.id] ?? 0;
    if (n > best) { best = n; winners = [m.meta.id]; }
    else if (n === best && n > 0) winners.push(m.meta.id);
  }
  if (best === 0 || winners.length === 0) return randomMapId();
  return winners[(Math.random() * winners.length) | 0];
}

/** vote tally by map id (for the live vote HUD) */
export function tallyVotes(votes: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of Object.values(votes)) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}
