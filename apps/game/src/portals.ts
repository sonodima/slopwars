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
// Visuals: an HDR torus ring (bloom halo) around a custom-shader vortex disc —
// spiral arms twisted around a dark event-horizon core, a hot inner rim, all
// animated off the engine's global clock (scene_ElapsedTime, like slop-water) so
// the swirl costs zero per-frame JS — plus a soft additive wisp emitter breathing
// energy out of the surface. Remaining lifespan is legible from every layer: the
// swirl spins faster and flickers, the ring pulses harder and dims, the wisps
// thin out, and the hum fades over the last seconds (ROADMAP §2.2).
//
// Frames: map surfaces are AABB faces, so a portal's normal is axis-aligned. Each
// portal carries a right-handed basis (t, b, n) — n the outward surface normal, b
// the in-plane "up", t = b × n — matching the entity rotation that renders it, so
// the traversal math and the visual agree by construction. Crossing entry→exit is
// the rigid transform t1→−t2, b1→b2, n1→−n2 (you go in the front of one and come
// out the front of the other), applied to offsets, velocities and ray directions.
import {
  BlendFactor, Color, CullMode, Engine, Entity, Material, MeshRenderer, ModelMesh,
  PrimitiveMesh, RenderQueueType, Shader, UnlitMaterial, Vector4,
} from "@galacean/engine";
import { PortalHum, sfx } from "./audio";
import { buildParticles } from "./particles";
import { PlayerBody } from "./player";
import { MOVE, Vec3, clamp } from "./types";

export const PORTAL_LIFE = 45;    // s a portal stays up before auto-despawn
export const PORTAL_HALF_W = 0.75; // oval half-width (t axis)
export const PORTAL_HALF_H = 1.15; // oval half-height (b axis)
export const PORTAL_GAP = 0.06;   // lift off the surface so the ring never z-fights

const REENTRY = 0.3;   // s the pair is inert after a traversal (no teleport ping-pong)
const NEAR = 0.45;     // plane distance at which the owner's body counts as "in"
const HUM_FADE = 6;    // s before expiry over which the hum fades out (ROADMAP §2.2)
const ANIM_DIST = 60;  // m beyond which the per-frame pulse/uniform writes are skipped (culled)

// blue / orange base colours; the ring gets the ×4 HDR boost (bloom picks it up,
// same trick as the powerup gems), the vortex shader shapes its own intensity.
const BASE: [number, number, number][] = [[0.25, 0.62, 1.0], [1.0, 0.45, 0.12]];

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// ── the vortex shader ─────────────────────────────────────────────────────────
// Alpha-composited, double-sided, no depth write: the disc paints a dark void with
// HDR spiral arms over it, so the swirl keeps contrast against bright walls AND
// bloom catches the arms. Everything animates off scene_ElapsedTime; per-frame JS
// only nudges u_portalLive (intensity + urgency).

const PORTAL_VS = /* glsl */ `
attribute vec3 POSITION;
attribute vec2 TEXCOORD_0;
uniform mat4 renderer_MVPMat;
varying vec2 v_uv;
void main() {
  v_uv = TEXCOORD_0;
  gl_Position = renderer_MVPMat * vec4(POSITION, 1.0);
}
`;

const PORTAL_FS = /* glsl */ `
#include <common>
uniform vec4 scene_ElapsedTime;  // (t, sin t, cos t, 0) — engine global clock
uniform vec4 u_portalColor;      // rgb: base colour · a: phase seed (desyncs pairs)
uniform vec4 u_portalLive;       // x: intensity (dims toward expiry) · y: urgency 0→1
varying vec2 v_uv;

void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  float r = length(p);
  float t = scene_ElapsedTime.x + u_portalColor.a;
  float urgency = u_portalLive.y;

  // spiral arms: angle twisted by radius, spinning faster as expiry nears, with a
  // counter-rotating filament layer so the eye never locks onto one rotation
  float ang = atan(p.y, p.x);
  float twist = ang + t * (1.4 + urgency * 3.0) + (1.0 - r) * 5.5;
  float arms = pow(0.5 + 0.5 * sin(twist * 3.0), 2.2);
  float fil = 0.5 + 0.5 * sin(twist * 9.0 - t * (3.0 + urgency * 5.0));

  // radial profile: dark event-horizon core → glowing body → hot rim at the ring
  float core = smoothstep(0.06, 0.55, r);
  float body = (arms * 0.85 + fil * 0.22) * core;
  float rim = pow(smoothstep(0.5, 1.0, r) * smoothstep(1.0, 0.85, r), 1.5) * 3.2;

  // expiry flicker: calm portals barely breathe, dying ones strobe
  float pulse = 1.0 + (0.06 + urgency * 0.4) * sin(t * (5.0 + urgency * 16.0));
  float edge = smoothstep(1.02, 0.96, r); // clean oval cutoff just inside the torus
  vec3 col = u_portalColor.rgb * (body * 1.6 + rim) * pulse;
  // white-hot spark at the singularity
  col += vec3(0.9) * pow(max(0.0, 1.0 - r * 3.0), 3.0) * (0.7 + 0.3 * sin(t * 4.6));
  // alpha-composited, not additive: the gaps between the arms stay a dark void (you
  // can't see through a portal), which is what gives the swirl its contrast against
  // bright walls — while the arm colours run HDR (>1) so bloom still catches them.
  float alpha = edge * clamp(u_portalLive.x, 0.0, 1.0) * (0.62 + body * 0.38);
  gl_FragColor = outputSRGBCorrection(vec4(col * u_portalLive.x, alpha));
}
`;

function portalShader(): Shader {
  return Shader.find("slop-portal") ?? Shader.create("slop-portal", PORTAL_VS, PORTAL_FS);
}

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
  live: Vector4;    // u_portalLive backing store (mutated in place — shaderData keeps the ref)
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
    this.discMesh = PrimitiveMesh.createPlane(this.engine, 2, 2); // XZ plane, uv 0..1
  }

  /** the vortex material: alpha-blended dark-void + HDR swirl — no depth write, both faces */
  private vortexMaterial(slot: 0 | 1, live: Vector4): Material {
    const m = new Material(this.engine, portalShader());
    m.renderState.renderQueueType = RenderQueueType.Transparent;
    m.renderState.depthState.writeEnabled = false;
    m.renderState.rasterState.cullMode = CullMode.Off;
    const tb = m.renderState.blendState.targetBlendState;
    tb.enabled = true;
    tb.sourceColorBlendFactor = BlendFactor.SourceAlpha;
    tb.destinationColorBlendFactor = BlendFactor.OneMinusSourceAlpha;
    tb.sourceAlphaBlendFactor = BlendFactor.One;
    tb.destinationAlphaBlendFactor = BlendFactor.OneMinusSourceAlpha;
    const [br, bg, bb] = BASE[slot];
    m.shaderData.setVector4("u_portalColor", new Vector4(br, bg, bb, Math.random() * 20)); // a = phase seed
    m.shaderData.setVector4("u_portalLive", live);
    return m;
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

    // vortex disc: the shared XZ plane stood up into the portal's XY frame
    // (rot +90° X maps local Z → −Y, so scale is W along X, H along local Z)
    const live = new Vector4(1, 0, 0, 0);
    const disc = root.createChild("disc");
    disc.transform.setRotation(90, 0, 0);
    disc.transform.setScale(PORTAL_HALF_W, 1, PORTAL_HALF_H);
    const dr = disc.addComponent(MeshRenderer);
    dr.mesh = this.discMesh;
    dr.setMaterial(this.vortexMaterial(slot, live));
    dr.castShadows = false;
    dr.receiveShadows = false;

    // wisps: soft additive motes breathing out of the surface (cone → local +Y,
    // so pitching the emitter +90° X aims it along the portal normal, +Z)
    const wisps = buildParticles(this.engine, root, 0, 0, 0.05, {
      rate: 14, lifetime: 1.3, speed: 0.5, size: 0.09, growth: 0.3, spread: 55,
      emitRadius: 0.8, gravity: 0, color: [br * 2.5, bg * 2.5, bb * 2.5], opacity: 0.85,
      additive: true, world: false,
    });
    wisps.transform.setRotation(90, 0, 0);

    const now = performance.now() / 1000;
    this.portals.push({
      owner, slot, local, c: { ...c }, n: { ...n }, t, b,
      until: now + PORTAL_LIFE, cdUntil: now + 0.2, phase: 0,
      root, ringMat, live, ring, hum: null,
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

  /** per-frame: expiry, and the visual + audible lifespan cues — the vortex spins
   *  faster + flickers (urgency uniform), the ring pulses harder and dims, the hum
   *  fades over the last seconds. Per-frame writes are skipped beyond ANIM_DIST of
   *  the camera (like the avatar's culling) — the shader keeps animating on its own
   *  clock; the hum handles its own earshot cutoff. */
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
      const pulse = 1 + (0.03 + 0.08 * (1 - lifeFrac)) * Math.sin(p.phase * 2);
      p.ring.transform.setScale(PORTAL_HALF_W * pulse, PORTAL_HALF_H * pulse, 1);
      // vortex urgency + brightness (shaderData holds the ref — mutate in place)
      p.live.x = 0.35 + 0.65 * lifeFrac;
      p.live.y = 1 - lifeFrac;
      // ring emissive dims toward expiry (mutate + reassign to flag the material dirty)
      const k = (0.3 + 0.7 * lifeFrac) * 4;
      const [br, bg, bb] = BASE[p.slot];
      const rc = p.ringMat.baseColor;
      rc.r = br * k; rc.g = bg * k; rc.b = bb * k;
      p.ringMat.baseColor = rc;
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

  /** owner-only, called BEFORE body.update each frame: walk the local player through
   *  their pair. Running pre-move with a velocity lookahead is what preserves
   *  momentum — the frame that would slam the capsule into the wall (zeroing the
   *  approach velocity) instead teleports with that velocity intact, remapped into
   *  the exit frame. The camera yaw rotates by the frame delta so you exit facing
   *  "through"; pitch is untouched. fwd/right are the raw move inputs — the wish
   *  direction also counts as "approaching" so a player already pinned against the
   *  wall still goes through (their velocity reads zero). */
  tryTraverse(body: PlayerBody, fwd: number, right: number, now: number, dt: number): void {
    for (const p of this.portals) {
      if (!p.local || now < p.cdUntil) continue;
      const out = this.linked(p);
      if (!out) return; // one colour placed — nothing to link to yet
      // probe the part of the body that meets the portal plane: mid-body on walls,
      // feet on a floor portal, head under a ceiling one (mid-body never gets within
      // NEAR of a floor plane while standing, so a uniform probe would miss those)
      const py = p.n.y > 0.9 ? body.pos.y + 0.1 : p.n.y < -0.9 ? body.pos.y + MOVE.height - 0.1 : body.pos.y + MOVE.height * 0.5;
      const rel = { x: body.pos.x - p.c.x, y: py - p.c.y, z: body.pos.z - p.c.z };
      const s = dot(rel, p.n);
      if (s < -0.1 || s > 1.4) continue; // 1.4 covers one clamped-dt step at bhop speed
      const lx = dot(rel, p.t), ly = dot(rel, p.b);
      if (!this.inOval(lx, ly, 1.1)) continue;
      const sy = Math.sin(body.yaw), cy = Math.cos(body.yaw);
      const wish = { x: -sy * fwd + cy * right, y: 0, z: -cy * fwd - sy * right };
      const vn = dot(body.vel, p.n);
      // entering = this frame's motion reaches the plane zone (momentum path), or
      // already inside the band and pressing/moving in (pinned-against-wall path)
      const entering = (vn < -0.4 && s + vn * dt <= 0.34)
        || (s <= NEAR && (vn < -0.4 || dot(wish, p.n) < -0.4));
      if (!entering) continue;

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

  /** compile the portal shaders (vortex + HDR ring + wisp particles) during the
   *  loading screen, so the first placement doesn't hitch — same pattern as the
   *  weapon/tracer/nade prewarms. Rendered far underground, then torn down. */
  prewarm(): void {
    this.place("__warm", 0, { x: 0, y: -120, z: 0 }, { x: 0, y: 0, z: 1 }, false);
    window.setTimeout(() => this.clearOwner("__warm"), 400);
  }
}
