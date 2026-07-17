// ─── Portals: player-bound linked teleport pairs (blue entry / orange exit) ──
// A Portals manager owned by Game, shaped like the Projectiles manager (nades.ts):
// a list of live portals, a per-frame update, spawn/despawn, and FX. Each player
// owns at most one blue (slot 0) + one orange (slot 1) portal; re-firing a colour
// replaces it. Portals are mirrored to every client for rendering, but traversal
// only ever runs for the OWNER: the local player walks through their own pair
// (tryTraverse), their grenades route through it (routeProjectile, called from the
// nade step on every client — deterministic because portals are mirrored), and
// their hitscan rays hop through it (rayThrough, resolveRay's wallbang recursion).
// Remote players simply pass straight through — a portal is never a solid.
//
// Frames: map surfaces are AABB faces, so a portal's normal is axis-aligned. Each
// portal carries a right-handed basis (t, b, n) — n the outward surface normal, b
// the in-plane "up", t = b × n — matching the entity rotation that renders it, so
// the traversal math and the visual agree by construction. Crossing entry→exit is
// the rigid transform t1→−t2, b1→b2, n1→−n2 (you go in the front of one and come
// out the front of the other), applied to offsets, velocities and ray directions.
import { Color, Engine, Entity, MeshRenderer, ModelMesh, PrimitiveMesh, UnlitMaterial } from "@galacean/engine";
import { PortalHum, sfx } from "./audio";
import { PlayerBody } from "./player";
import { MOVE, Vec3, clamp } from "./types";

export const PORTAL_LIFE = 45;    // s a portal stays up before auto-despawn
export const PORTAL_HALF_W = 0.75; // oval half-width (t axis)
export const PORTAL_HALF_H = 1.15; // oval half-height (b axis)
export const PORTAL_GAP = 0.06;   // lift off the surface so the ring never z-fights

const REENTRY = 0.3;   // s the pair is inert after a traversal (no teleport ping-pong)
const NEAR = 0.45;     // plane distance at which the owner's body counts as "in"
const HUM_FADE = 6;    // s before expiry over which the hum fades out (ROADMAP §2.2)
const ANIM_DIST = 60;  // m beyond which the pulse/shimmer animation is skipped (culled)

// blue / orange base colours; the ring gets the ×4 HDR boost (bloom picks it up,
// same trick as the powerup gems), the shimmer disc stays dim + translucent.
const BASE: [number, number, number][] = [[0.25, 0.62, 1.0], [1.0, 0.45, 0.12]];

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

interface Portal {
  owner: string;
  slot: 0 | 1;      // 0 blue · 1 orange
  local: boolean;   // the local player owns it → traversal enabled
  c: Vec3;          // centre (already lifted off the surface)
  n: Vec3;          // outward surface normal (axis-aligned — AABB world)
  t: Vec3;          // in-plane right
  b: Vec3;          // in-plane up
  until: number;    // expiry (perf-clock s)
  cdUntil: number;  // re-entry cooldown after a traversal
  phase: number;    // running pulse phase (rate ramps up as expiry nears)
  root: Entity;
  ringMat: UnlitMaterial;
  discMat: UnlitMaterial;
  ring: Entity;
  hum: PortalHum | null; // spun up lazily when within earshot (see update)
}

export class Portals {
  /** the local owner walked through (at exit `p`) — play the enter cue / feedback */
  onTraverse: ((p: Vec3) => void) | null = null;
  /** a LOCAL portal hit its 45 s expiry — the owner broadcasts the despawn */
  onExpire: ((slot: 0 | 1) => void) | null = null;

  private portals: Portal[] = [];
  private root: Entity;
  private ringMesh: ModelMesh;
  private discMesh: ModelMesh;

  constructor(private engine: Engine, parent: Entity, private rel: (p: Vec3) => { pan: number; dist: number }) {
    this.root = parent.createChild("portals");
    // shared unit meshes, sized per portal by entity scale (zero geometry per spawn).
    // The torus lies in the XY plane (normal +Z) — exactly the portal's local frame.
    this.ringMesh = PrimitiveMesh.createTorus(this.engine, 1, 0.07, 18, 40);
    this.discMesh = PrimitiveMesh.createSphere(this.engine, 1, 14);
  }

  /** spawn (or replace) `owner`'s portal `slot` at centre `c` on a surface facing `n` */
  place(owner: string, slot: 0 | 1, c: Vec3, n: Vec3, local: boolean): void {
    this.removeAt(this.portals.findIndex((p) => p.owner === owner && p.slot === slot));
    // right-handed frame: in-plane up is world-up on walls; on floors/ceilings it
    // falls along ∓Z (matching the ±90° X entity rotation below)
    const b = Math.abs(n.y) > 0.9 ? { x: 0, y: 0, z: n.y > 0 ? -1 : 1 } : { x: 0, y: 1, z: 0 };
    const t = cross(b, n);

    const root = this.root.createChild("portal");
    root.transform.setPosition(c.x, c.y, c.z);
    if (Math.abs(n.y) > 0.9) root.transform.setRotation(n.y > 0 ? -90 : 90, 0, 0);
    else root.transform.setRotation(0, (Math.atan2(n.x, n.z) * 180) / Math.PI, 0);

    const [br, bg, bb] = BASE[slot];
    const ringMat = new UnlitMaterial(this.engine);
    ringMat.baseColor = new Color(br * 4, bg * 4, bb * 4, 1); // HDR → bloom halo
    const ring = root.createChild("ring");
    const rr = ring.addComponent(MeshRenderer);
    rr.mesh = this.ringMesh;
    rr.setMaterial(ringMat);
    rr.castShadows = false;
    rr.receiveShadows = false;
    ring.transform.setScale(PORTAL_HALF_W, PORTAL_HALF_H, 1);

    // shimmer: a translucent flattened sphere filling the oval (reads from both sides)
    const discMat = new UnlitMaterial(this.engine);
    discMat.baseColor = new Color(br * 0.9, bg * 0.9, bb * 0.9, 0.32);
    discMat.isTransparent = true;
    const disc = root.createChild("disc");
    const dr = disc.addComponent(MeshRenderer);
    dr.mesh = this.discMesh;
    dr.setMaterial(discMat);
    dr.castShadows = false;
    dr.receiveShadows = false;
    disc.transform.setScale(PORTAL_HALF_W * 0.82, PORTAL_HALF_H * 0.82, 0.05);

    const now = performance.now() / 1000;
    this.portals.push({
      owner, slot, local, c: { ...c }, n: { ...n }, t, b,
      until: now + PORTAL_LIFE, cdUntil: now + 0.2, phase: 0,
      root, ringMat, discMat, ring, hum: null,
    });
  }

  remove(owner: string, slot: 0 | 1): void {
    this.removeAt(this.portals.findIndex((p) => p.owner === owner && p.slot === slot));
  }

  clearOwner(owner: string): void {
    for (let i = this.portals.length - 1; i >= 0; i--) if (this.portals[i].owner === owner) this.removeAt(i);
  }

  clear(): void {
    for (let i = this.portals.length - 1; i >= 0; i--) this.removeAt(i);
  }

  private removeAt(i: number): void {
    if (i < 0) return;
    const p = this.portals[i];
    p.hum?.stop();
    p.root.destroy();
    this.portals.splice(i, 1);
  }

  /** the other end of `p`'s pair, or null while only one colour is placed */
  private linked(p: Portal): Portal | null {
    return this.portals.find((q) => q.owner === p.owner && q.slot !== p.slot) ?? null;
  }

  /** per-frame: expiry, and the visual + audible lifespan cues — the ring pulses
   *  faster and dims as expiry nears, the hum fades over the last seconds. Animation
   *  is skipped beyond ANIM_DIST of the camera (like the avatar's culling); the hum
   *  handles its own earshot cutoff. */
  update(dt: number, now: number, cam: Vec3): void {
    for (let i = this.portals.length - 1; i >= 0; i--) {
      const p = this.portals[i];
      const left = p.until - now;
      if (left <= 0) {
        if (p.local) this.onExpire?.(p.slot);
        this.removeAt(i);
        continue;
      }
      const lifeFrac = left / PORTAL_LIFE;
      p.phase += dt * (2 + (1 - lifeFrac) * 9); // calm breathing → urgent flutter
      const fade = clamp(left / HUM_FADE, 0, 1);
      const r = this.rel(p.c);
      // the hum only exists while within earshot — no oscillators for far portals
      if (r.dist <= 30) (p.hum ??= sfx.portalHum()).set(r.pan, r.dist, fade * (0.8 + 0.2 * Math.sin(p.phase * 2)));
      else if (p.hum) { p.hum.stop(); p.hum = null; }
      const dx = p.c.x - cam.x, dy = p.c.y - cam.y, dz = p.c.z - cam.z;
      if (dx * dx + dy * dy + dz * dz > ANIM_DIST * ANIM_DIST) continue;
      const pulse = 1 + 0.05 * Math.sin(p.phase * 2);
      p.ring.transform.setScale(PORTAL_HALF_W * pulse, PORTAL_HALF_H * pulse, 1);
      // emissive dims toward expiry (mutate + reassign to flag the material dirty)
      const k = (0.3 + 0.7 * lifeFrac) * 4;
      const [br, bg, bb] = BASE[p.slot];
      const rc = p.ringMat.baseColor;
      rc.r = br * k; rc.g = bg * k; rc.b = bb * k;
      p.ringMat.baseColor = rc;
      const dc = p.discMat.baseColor;
      dc.a = 0.22 + 0.12 * Math.sin(p.phase * 3.4);
      p.discMat.baseColor = dc;
    }
  }

  // ── traversal math ──────────────────────────────────────────────────────────

  /** map an in-plane offset (lx along t1, ly along b1) + any vector through the pair's
   *  rigid transform: t1→−t2, b1→b2, n1→−n2 (in the front, out the front). */
  private mapPoint(out: Portal, lx: number, ly: number, alongN: number): Vec3 {
    return {
      x: out.c.x - out.t.x * lx + out.b.x * ly + out.n.x * alongN,
      y: out.c.y - out.t.y * lx + out.b.y * ly + out.n.y * alongN,
      z: out.c.z - out.t.z * lx + out.b.z * ly + out.n.z * alongN,
    };
  }
  private mapVec(inP: Portal, out: Portal, v: Vec3): Vec3 {
    const vt = dot(v, inP.t), vb = dot(v, inP.b), vn = dot(v, inP.n);
    return {
      x: -out.t.x * vt + out.b.x * vb - out.n.x * vn,
      y: -out.t.y * vt + out.b.y * vb - out.n.y * vn,
      z: -out.t.z * vt + out.b.z * vb - out.n.z * vn,
    };
  }

  /** is (lx, ly) inside the oval? `slack` loosens it a touch for the player capsule */
  private inOval(lx: number, ly: number, slack = 1): boolean {
    const a = PORTAL_HALF_W * slack, b = PORTAL_HALF_H * slack;
    return (lx * lx) / (a * a) + (ly * ly) / (b * b) <= 1;
  }

  /** owner-only, per-frame: walk the local player through their pair. Momentum carries
   *  (velocity is rotated between the frames), the camera yaw rotates by the same delta
   *  so you exit facing "through", pitch is untouched. fwd/right are the raw move inputs
   *  — the wish direction also counts as "approaching" so a player pinned against the
   *  wall (velocity zeroed by collision) still goes through. */
  tryTraverse(body: PlayerBody, fwd: number, right: number, now: number): void {
    for (const p of this.portals) {
      if (!p.local || now < p.cdUntil) continue;
      const out = this.linked(p);
      if (!out) return; // one colour placed — nothing to link to yet
      // probe the part of the body that meets the portal plane: mid-body on walls,
      // feet on a floor portal, head under a ceiling one (mid-body never gets within
      // NEAR of a floor plane while standing, so a uniform probe would miss those)
      const py = p.n.y > 0.9 ? body.pos.y + 0.1 : p.n.y < -0.9 ? body.pos.y + MOVE.height - 0.1 : body.pos.y + MOVE.height * 0.5;
      const mid = { x: body.pos.x, y: py, z: body.pos.z };
      const rel = { x: mid.x - p.c.x, y: mid.y - p.c.y, z: mid.z - p.c.z };
      const s = dot(rel, p.n);
      if (s < -0.1 || s > NEAR) continue;
      const lx = dot(rel, p.t), ly = dot(rel, p.b);
      if (!this.inOval(lx, ly, 1.1)) continue;
      const sy = Math.sin(body.yaw), cy = Math.cos(body.yaw);
      const wish = { x: -sy * fwd + cy * right, y: 0, z: -cy * fwd - sy * right };
      if (dot(body.vel, p.n) > -0.4 && dot(wish, p.n) > -0.4) continue; // not moving in

      // exit feet: in front of a wall portal at its mid-height; on top of a floor
      // portal; dropped clear of a ceiling one.
      let feet: Vec3;
      if (out.n.y > 0.9) feet = { x: out.c.x, y: out.c.y + 0.05, z: out.c.z };
      else if (out.n.y < -0.9) feet = { x: out.c.x, y: out.c.y - MOVE.height - 0.1, z: out.c.z };
      else {
        const off = MOVE.radius + 0.15;
        feet = { x: out.c.x + out.n.x * off, y: out.c.y - MOVE.height * 0.5, z: out.c.z + out.n.z * off };
      }
      const vel = this.mapVec(p, out, body.vel);
      // exit yaw from the remapped facing; a mostly-vertical result (wall → floor
      // portal) has no horizontal bearing, so keep the current yaw there
      const f = this.mapVec(p, out, { x: -sy, y: 0, z: -cy });
      const keepPitch = body.pitch;
      const yaw = Math.hypot(f.x, f.z) > 0.2 ? Math.atan2(-f.x, -f.z) : body.yaw;
      body.teleport(feet, (yaw * 180) / Math.PI); // zeroes vel/pitch — restore below
      body.pitch = keepPitch;
      body.vel = vel;
      p.cdUntil = now + REENTRY;
      out.cdUntil = now + REENTRY;
      this.onTraverse?.(feet);
      return;
    }
  }

  /** grenade step: if `owner`'s projectile at `pos` is about to enter one of their
   *  portals, translate pos + vel into the exit frame IN PLACE — the nade glides
   *  through with no bounce at the boundary. Called at the TOP of each fixed step
   *  (`step` = its dt) so the route wins over the wall bounce behind the portal, and
   *  the lookahead means a fast projectile can't skip the trigger band in one step.
   *  Runs on every client (portals are mirrored), so each local sim routes the same
   *  throw the same way. */
  routeProjectile(owner: string, pos: Vec3, vel: Vec3, step: number): boolean {
    for (const p of this.portals) {
      if (p.owner !== owner) continue;
      const rel = { x: pos.x - p.c.x, y: pos.y - p.c.y, z: pos.z - p.c.z };
      const s = dot(rel, p.n);
      const vn = dot(vel, p.n);
      if (vn > -0.5) continue;                    // grazing, not entering
      if (s < -0.05 || s + vn * step > 0.15) continue; // this step won't reach the plane yet
      const lx = dot(rel, p.t), ly = dot(rel, p.b);
      if (!this.inOval(lx, ly)) continue;
      const out = this.linked(p);
      if (!out) return false;
      const q = this.mapPoint(out, lx, ly, 0.3); // clear of the exit surface
      const v = this.mapVec(p, out, vel);
      pos.x = q.x; pos.y = q.y; pos.z = q.z;
      vel.x = v.x; vel.y = v.y; vel.z = v.z;
      return true;
    }
    return false;
  }

  /** hitscan: nearest of `shooter`'s own portals the ray enters within `maxDist`,
   *  with the re-emitted origin + direction out of the linked portal. resolveRay
   *  recurses once from here, guarded by its existing wallbang depth cap. */
  rayThrough(shooter: string, o: Vec3, d: Vec3, maxDist: number): { dist: number; o2: Vec3; d2: Vec3 } | null {
    let best: { dist: number; p: Portal; out: Portal; lx: number; ly: number } | null = null;
    for (const p of this.portals) {
      if (p.owner !== shooter) continue;
      const denom = dot(d, p.n);
      if (denom > -1e-6) continue; // parallel or from behind
      const s0 = dot({ x: o.x - p.c.x, y: o.y - p.c.y, z: o.z - p.c.z }, p.n);
      if (s0 <= 0) continue;
      const dist = s0 / -denom;
      if (dist <= 0 || dist >= (best ? best.dist : maxDist)) continue;
      const q = { x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist };
      const rel = { x: q.x - p.c.x, y: q.y - p.c.y, z: q.z - p.c.z };
      const lx = dot(rel, p.t), ly = dot(rel, p.b);
      if (!this.inOval(lx, ly)) continue;
      const out = this.linked(p);
      if (!out) continue;
      best = { dist, p, out, lx, ly };
    }
    if (!best) return null;
    return {
      dist: best.dist,
      o2: this.mapPoint(best.out, best.lx, best.ly, PORTAL_GAP),
      d2: this.mapVec(best.p, best.out, d),
    };
  }

  /** compile the portal materials' shader variants (HDR unlit ring + transparent disc)
   *  during the loading screen, so the first placement doesn't hitch — same pattern as
   *  the weapon/tracer/nade prewarms. Rendered far underground, then torn down. */
  prewarm(): void {
    this.place("__warm", 0, { x: 0, y: -120, z: 0 }, { x: 0, y: 0, z: 1 }, false);
    window.setTimeout(() => this.clearOwner("__warm"), 400);
  }
}
