// ─── `.map` format schema (shared by game + editor) ──────────────────────────
// A map is a self-contained, declarative data object (a "MapDef"). Following the
// convention of modern game-engine editors, *everything placed in a map is an
// object* — geometry (box/water/stairs), props, spawns, pickups, power-ups,
// sounds and lights are all `Placement`s of a registered object `type` with a
// full transform (position / rotation / scale) and per-type params. The game's
// loader interprets it; object types (game/objects.ts) turn placements into
// entities/collision/behaviour. Maps live as JSON under `maps/` and are fetched
// at runtime — the same interpreter loads them in the game and in the editor.

export type Tuple3 = [number, number, number];

/** shared PBR material slots every map draws from (loaded once, reused) */
export type MatId = "wall" | "floor" | "crate" | "metal" | "stone" | "dark";

/** a placed object: a registry `type` with a transform + param overrides.
 *  rot is euler degrees; scale defaults to [1,1,1]. For a "box" object the scale
 *  IS its width/height/depth, so the scale gizmo resizes it. */
export interface Placement {
  type: string;
  name?: string;                       // optional user-given label (editor/outliner)
  at: Tuple3;                          // position (world)
  rot?: Tuple3;                        // euler degrees (default [0,0,0])
  scale?: Tuple3;                      // (default [1,1,1])
  params?: Record<string, unknown>;    // shallow-merged over the type's defaults
}

/** skybox + lighting + fog identity for the map */
export interface MapEnv {
  sky: { hdri?: string; solid?: Tuple3 };  // hdri path OR solid rgb (0..1) background
  fog?: { color: Tuple3; start: number; end: number } | null;
  ambient: { color: Tuple3; intensity: number; specular?: number };
  sun: { rot: Tuple3; color: Tuple3; strength: number };
  water?: Tuple3;                          // ambient water-loop source (optional)
}

export interface MapMeta {
  id: string;
  name: string;
  theme: string;
  /** whether this map is part of the random/vote rotation (default true).
   *  false = available (lobby/editor) but never auto-selected into a match. */
  rotate?: boolean;
}

export interface MapDef {
  meta: MapMeta;
  env: MapEnv;
  /** per-map texture palette: slot → folder under public/assets/textures/.
   *  unbound slots fall back to DEFAULT_TEX. this is what makes maps look distinct. */
  textures?: Partial<Record<MatId, string>>;
  /** every placed object, in order (geometry, props, markers, sounds, …) */
  objects: Placement[];
}

// ── transform helpers ────────────────────────────────────────────────────────

export function placeAt(o: Placement): Tuple3 { return o.at; }
export function placeRot(o: Placement): Tuple3 { return o.rot ?? [0, 0, 0]; }
export function placeScale(o: Placement): Tuple3 { return o.scale ?? [1, 1, 1]; }

/** an empty, valid map — the starting point for "New Map" in the editor */
export function emptyMap(id: string, name: string): MapDef {
  return {
    meta: { id, name, theme: "" },
    env: {
      sky: { solid: [0.05, 0.06, 0.08] },
      fog: null,
      ambient: { color: [0.6, 0.62, 0.68], intensity: 0.7, specular: 0.85 },
      sun: { rot: [-50, -35, 0], color: [1.2, 1.15, 1.0], strength: 0.8 },
    },
    textures: {},
    objects: [
      { type: "box", at: [0, -0.5, 0], scale: [40, 1, 40], params: { mat: "floor", tile: [10, 10] } },
      { type: "spawn", at: [0, 0, 0] },
    ],
  };
}

// ── migration: legacy (brushes/spawns/pickups/powerups) → unified objects ─────
// Kept so old maps and the one-time export can be normalized into the new shape.

interface LegacyMapDef {
  meta: MapMeta; env: MapEnv; textures?: Partial<Record<MatId, string>>;
  brushes?: unknown[]; objects?: unknown[]; spawns?: unknown[]; pickups?: unknown[]; powerups?: unknown[];
}

/** normalize any map (legacy or current) into the unified objects-only format */
export function migrateMap(raw: LegacyMapDef): MapDef {
  // already unified: objects present, no legacy arrays
  if (Array.isArray(raw.objects) && !raw.brushes && !raw.spawns && !raw.pickups && !raw.powerups) {
    return { meta: raw.meta, env: raw.env, textures: raw.textures, objects: (raw.objects as Placement[]).map(normPlacement) };
  }
  const objects: Placement[] = [];
  for (const b of (raw.brushes ?? []) as Record<string, unknown>[]) {
    const at = b.at as Tuple3;
    if (b.k === "box") {
      objects.push({ type: "box", at, scale: b.size as Tuple3, params: { mat: b.mat, tile: b.tile ?? [1, 1], solid: b.solid !== false } });
    } else if (b.k === "water") {
      objects.push({ type: "water", at, scale: [b.s as number, 1, b.s as number] });
    } else if (b.k === "stairs") {
      objects.push({ type: "stairs", at, params: { axis: b.axis, rise: b.rise, run: b.run, width: b.width, steps: b.steps ?? 8, mat: b.mat ?? "dark" } });
    }
  }
  for (const o of (raw.objects ?? []) as Record<string, unknown>[]) objects.push(normPlacement(o));
  for (const s of (raw.spawns ?? []) as { at: [number, number]; yaw: number }[]) {
    objects.push({ type: "spawn", at: [s.at[0], 0, s.at[1]], rot: [0, s.yaw, 0] });
  }
  for (const p of (raw.pickups ?? []) as Tuple3[]) objects.push({ type: "pickup", at: p });
  for (const p of (raw.powerups ?? []) as Tuple3[]) objects.push({ type: "powerup", at: p });
  return { meta: raw.meta, env: raw.env, textures: raw.textures, objects };
}

/** coerce a placement's rotation from the legacy `rot: number` (yaw) to a tuple */
function normPlacement(o: unknown): Placement {
  const p = o as Record<string, unknown>;
  const rot = typeof p.rot === "number" ? [0, p.rot, 0] as Tuple3 : (p.rot as Tuple3 | undefined);
  return { type: p.type as string, name: p.name as string | undefined, at: p.at as Tuple3, rot, scale: p.scale as Tuple3 | undefined, params: p.params as Record<string, unknown> | undefined };
}
