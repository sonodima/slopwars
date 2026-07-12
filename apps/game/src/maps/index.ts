// ─── Map pool: catalog-driven registry of playable maps + selection helpers ──
// Maps are JSON files under the project's `maps/` directory. The asset pipeline's
// Vite plugin scans them into `virtual:map-catalog`; here we fetch each one at
// startup into an in-memory registry so the rest of the game can look maps up
// synchronously (mapById) exactly as before. No map data lives in TS source.
import mapCatalog from "virtual:map-catalog";
import { MapDef, MapMeta, emptyMap } from "@slopwars/shared";
import { logAsset } from "../assets";

const BASE = import.meta.env.BASE_URL;

const BY_ID = new Map<string, MapDef>();
/** every map, in catalog order (loaded by loadMapPool) */
export let MAP_POOL: MapDef[] = [];
/** maps eligible for random selection / the vote (meta.rotate !== false) */
export let ROTATION: MapDef[] = [];
/** default map shown in the lobby before a match picks one */
export let DEFAULT_MAP = "koi";

/** fetch all maps referenced by the catalog into the registry (once, at boot) */
export async function loadMapPool(): Promise<void> {
  const defs = await Promise.all(
    mapCatalog.map(async (e): Promise<MapDef | null> => {
      try {
        logAsset("map", e.file);
        const res = await fetch(`${BASE}${e.file}`);
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()) as MapDef;
      } catch (err) {
        console.warn("[maps] failed to load", e.file, err);
        return null;
      }
    }),
  );
  BY_ID.clear();
  MAP_POOL = defs.filter((d): d is MapDef => d !== null);
  for (const d of MAP_POOL) BY_ID.set(d.meta.id, d);
  ROTATION = MAP_POOL.filter((m) => m.meta.rotate !== false);
  if (ROTATION.length === 0) ROTATION = MAP_POOL.slice();
  DEFAULT_MAP = BY_ID.has("office") ? "office" : (MAP_POOL[0]?.meta.id ?? "koi");
}

export function mapById(id: string): MapDef {
  return BY_ID.get(id) ?? MAP_POOL[0] ?? emptyMap("empty", "Empty");
}

/** metas of maps in the vote rotation (order = card order in the vote UI) */
export function mapMetas(): MapMeta[] {
  return ROTATION.map((m) => m.meta);
}

/** uniformly random map id from the rotation */
export function randomMapId(): string {
  const pool = ROTATION.length ? ROTATION : MAP_POOL;
  return pool[(Math.random() * pool.length) | 0]?.meta.id ?? DEFAULT_MAP;
}

/** plurality winner of a vote tally; random tiebreak; random if nobody voted */
export function pickVotedMap(votes: Record<string, string>): string {
  const counts: Record<string, number> = {};
  for (const id of Object.values(votes)) counts[id] = (counts[id] ?? 0) + 1;
  let best = 0;
  let winners: string[] = [];
  for (const m of ROTATION) {
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
