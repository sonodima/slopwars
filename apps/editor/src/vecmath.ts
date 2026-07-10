// ─── Shared editor math + gizmo geometry ─────────────────────────────────────
// Small, dependency-free vector helpers and the transform-gizmo axis constants used
// by BOTH interactive scenes: the map viewport (viewport.ts) and the preview /
// collision scene (previewscene.ts). These were copy-pasted (and had begun to drift)
// between the two files; keeping one copy here means the two gizmos stay in lock-step
// — same axis colours, same picking maths, same rotation snap.
import type { Tuple3 } from "@slopwars/shared";

export function dot(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a: number[], b: number[]): number[] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function norm(a: number[]): number[] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

/** shortest distance from point (px,py) to the segment (ax,ay)-(bx,by) */
export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp((wx * vx + wy * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** rotate a vector about world axis `idx` (0=x,1=y,2=z) by `rad` (right-handed) */
export function rotateAxis(v: Tuple3, idx: number, rad: number): Tuple3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  if (idx === 0) return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  if (idx === 1) return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** Shift-snap increment (degrees) for the rotate gizmo, in both the map viewport and
 *  the collision editor — hold Shift while rotating to lock to multiples of this. */
export const ROT_SNAP_DEG = 30;

// ── gizmo handle geometry (an axis, or the all-axes centre) ──────────────────
/** which transform-gizmo handle a drag grabbed: an axis, or `xyz` (screen-plane
 *  move / uniform scale). */
export type GizmoHandle = "x" | "y" | "z" | "xyz";
/** the three axis handles + their world directions (the centre `xyz` handle is
 *  special-cased by each scene, so it isn't in this list). */
export const GIZMO_AXES: { h: GizmoHandle; dir: Tuple3 }[] = [
  { h: "x", dir: [1, 0, 0] }, { h: "y", dir: [0, 1, 0] }, { h: "z", dir: [0, 0, 1] },
];
/** axis handle → its overlay colour (x red, y green, z blue, centre grey) */
export const GIZMO_COL: Record<GizmoHandle, string> = { x: "#e5484d", y: "#5bd15b", z: "#3b82f6", xyz: "#d6d6d6" };
/** axis handle → component index it drives (0=x,1=y,2=z; `xyz` maps to 0) */
export const AXIS_IDX: Record<GizmoHandle, number> = { x: 0, y: 1, z: 2, xyz: 0 };
/** axis handle → its unit world direction (`xyz` is the zero vector) */
export const AXIS_DIR: Record<GizmoHandle, Tuple3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], xyz: [0, 0, 0] };
