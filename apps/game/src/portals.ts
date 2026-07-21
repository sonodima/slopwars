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
// Visuals: an HDR torus ring (bloom halo) around a custom-shader nebula disc —
// domain-warped fbm clouds sinking into an accent hue, braided spiral filaments,
// a twinkling starfield, a dark event-horizon core and a hot rim, all animated
// off the engine's global clock (scene_ElapsedTime, like slop-water) so the
// swirl costs zero per-frame JS — plus wisp + nebula-mist emitters breathing
// energy out of the surface. Remaining lifespan is legible from every layer: the
// swirl spins faster and flickers, the ring pulses harder and dims, the wisps
// thin out, and the hum fades over the last seconds.
//
// See-through: the LOCAL pair doubles as a window — renderView() draws the scene
// from behind the linked portal (water-reflection recipe: manual RTT camera,
// oblique near plane at the exit surface) and the disc shows it parallax-correct
// under a thinned nebula film. One extra reduced-res scene render per frame at
// most, none when no local portal is on screen; remote portals stay pure nebula.
//
// Frames: map surfaces are AABB faces, so a portal's normal is axis-aligned. Each
// portal carries a right-handed basis (t, b, n) — n the outward surface normal, b
// the in-plane "up", t = b × n — matching the entity rotation that renders it, so
// the traversal math and the visual agree by construction. Crossing entry→exit is
// the rigid transform t1→−t2, b1→b2, n1→−n2 (you go in the front of one and come
// out the front of the other), applied to offsets, velocities and ray directions.
import {
  BlendFactor, Camera, Color, CullMode, Engine, Entity, Layer, MSAASamples, Material, Matrix,
  MeshRenderer, ModelMesh, PrimitiveMesh, RenderQueueType, RenderTarget, Script, Shader,
  Texture2D, TextureFormat, TextureWrapMode, UnlitMaterial, Vector4,
} from "@galacean/engine";
import { PortalHum, sfx } from "./audio";
import { buildParticles } from "./particles";
import { PlayerBody } from "./player";
import { MOVE, Vec3, clamp } from "./types";
import { NO_REFLECT_LAYER, WATER_LAYER, makeOblique } from "./water";
import { CLOUD_RT_LAYER } from "./clouds";

export const PORTAL_LIFE = 45;    // s a portal stays up before auto-despawn
export const PORTAL_HALF_W = 0.75; // oval half-width (t axis)
export const PORTAL_HALF_H = 1.15; // oval half-height (b axis)
export const PORTAL_GAP = 0.06;   // lift off the surface so the ring never z-fights

const REENTRY = 0.3;   // s the pair is inert after a traversal (no teleport ping-pong)
const NEAR = 0.45;     // plane distance at which the owner's body counts as "in"
const HUM_FADE = 6;    // s before expiry over which the hum fades out
const ANIM_DIST = 60;  // m beyond which the per-frame pulse/uniform writes are skipped (culled)
const VIEW_DIST = 45;  // m within which the see-through view renders (local pair only)
const VIEW_BIAS = 0.02; // oblique clip lift off the exit plane (< PORTAL_GAP — keeps the wall out)

// blue / orange base colours; the ring gets the ×4 HDR boost (bloom picks it up,
// same trick as the powerup gems), the vortex shader shapes its own intensity.
const BASE: [number, number, number][] = [[0.25, 0.62, 1.0], [1.0, 0.45, 0.12]];
// nebula depth accents — the colour the clouds sink into (violet / crimson)
const ACCENT: [number, number, number][] = [[0.45, 0.15, 0.95], [0.95, 0.10, 0.30]];
// someone ELSE's portals: both of the pair render hostile red (you can't tell an
// enemy's entry from its exit — and you can't use either), over an opaque void.
const HOSTILE_BASE: [number, number, number] = [1.0, 0.16, 0.12];
const HOSTILE_ACCENT: [number, number, number] = [0.55, 0.04, 0.10];

/** portal discs live on their own layer so the see-through camera can cull them:
 *  a disc must never sample the render target it is being drawn into (feedback),
 *  and it caps recursion — through a portal, other portals show ring + wisps only. */
export const PORTAL_SURF_LAYER = Layer.Layer28;

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// ── the nebula shader ─────────────────────────────────────────────────────────
// Alpha-composited, double-sided, no depth write. Two personalities in one program
// (a uniform branch — no extra shader permutation):
//  · nebula mode — a domain-warped fbm nebula (accent-coloured depths under base-
//    coloured cloud tops), braided spiral filaments, a twinkling starfield, a dark
//    event-horizon core and an HDR rim. Everything animates off scene_ElapsedTime,
//    so a calm portal costs zero per-frame JS.
//  · window mode (u_portalLive.z > 0) — the local pair only: the disc samples a
//    render target drawn from behind the linked portal (parallax-correct, see
//    Portals.renderView), and the nebula thins to a breathing film over the view,
//    dense at the rim, clear at the centre. Crossing then reads seamless: what you
//    saw *in* the portal is what you see *after* the teleport.

const PORTAL_VS = /* glsl */ `
attribute vec3 POSITION;
attribute vec2 TEXCOORD_0;
uniform mat4 renderer_MVPMat;
varying vec2 v_uv;
varying vec4 v_clip;   // main-camera clip pos → screen UV for the see-through sample
void main() {
  v_uv = TEXCOORD_0;
  gl_Position = renderer_MVPMat * vec4(POSITION, 1.0);
  v_clip = gl_Position;
}
`;

const PORTAL_FS = /* glsl */ `
#include <common>
uniform vec4 scene_ElapsedTime;  // (t, sin t, cos t, 0) — engine global clock
uniform vec4 u_portalColor;      // rgb: base colour · a: phase seed (desyncs pairs)
uniform vec4 u_portalColor2;     // rgb: nebula depth accent
uniform vec4 u_portalLive;       // x: intensity · y: urgency 0→1 · z: window mix 0→1
uniform sampler2D u_portalViewTex; // exit-side scene (bound for all; sampled when z>0)
varying vec2 v_uv;
varying vec4 v_clip;             // main-camera clip pos → screen UV into the RT

float ph(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ph(i), ph(i + vec2(1.0, 0.0)), u.x),
             mix(ph(i + vec2(0.0, 1.0)), ph(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * pnoise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }
  return s;
}

void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float t = scene_ElapsedTime.x + u_portalColor.a;
  float urgency = u_portalLive.y;

  // ── nebula clouds: polar-space fbm, swirled inward and warped by its own noise ──
  float spin = t * (0.22 + urgency * 0.55);
  vec2 np = vec2(ang * 0.9 + (1.0 - r) * 3.2 + spin, r * 2.6 - t * 0.12);
  float neb1 = fbm(np * 2.2);
  float neb2 = fbm(np * 4.6 + vec2(neb1 * 1.7, -t * 0.2));
  float clouds = smoothstep(0.28, 0.85, neb1 * 0.72 + neb2 * 0.45);

  // spiral filaments braided through the clouds, counter-phased so the eye never locks
  float twist = ang + t * (1.1 + urgency * 3.0) + (1.0 - r) * 5.5;
  float arms = pow(0.5 + 0.5 * sin(twist * 3.0), 2.6);
  float fil = pow(0.5 + 0.5 * sin(twist * 9.0 - t * (2.6 + urgency * 5.0)), 3.0);

  // radial profile: event-horizon core → nebula body → hot HDR rim → oval cutoff
  float core = smoothstep(0.02, 0.5, r);
  float rim = pow(smoothstep(0.42, 1.0, r) * smoothstep(1.0, 0.86, r), 1.4) * 3.4;
  float edge = smoothstep(1.02, 0.96, r);

  // starfield: sparse cells drifting with the swirl, each twinkling on its own phase
  vec2 sp = p * 7.0 + vec2(spin * 2.0, 0.0);
  vec2 sc = floor(sp);
  float star = step(0.93, ph(sc)) * pow(max(0.0, 1.0 - 2.0 * length(fract(sp) - 0.5)), 4.0);
  star *= 0.5 + 0.5 * sin(t * 3.0 + ph(sc.yx) * 31.0);

  vec3 base = u_portalColor.rgb;
  vec3 accent = u_portalColor2.rgb;
  float pulse = 1.0 + (0.05 + urgency * 0.35) * sin(t * (5.0 + urgency * 16.0));

  // depths sink into the accent, cloud tops catch the base colour, filaments run HDR
  vec3 neb = mix(accent * 0.55, base * 1.25, clouds) * (clouds * 0.85 + 0.18) * core;
  vec3 col = neb + base * (arms * 0.9 + fil * 0.5) * core * 1.5 + base * rim;
  col += vec3(1.0, 0.98, 0.92) * star * core * (0.8 + urgency);
  col += vec3(0.9) * pow(max(0.0, 1.0 - r * 3.0), 3.0) * (0.7 + 0.3 * sin(t * 4.6));
  col *= pulse;

  float live = clamp(u_portalLive.x, 0.0, 1.0);
  float window = u_portalLive.z;
  float solid = u_portalLive.w;   // hostile portals: opaque void — nothing shows through
  float alpha;
  if (window > 0.001) {
    // window mode: the RT was rendered from the virtual (through-portal) camera with
    // the MAIN camera's projection, so this fragment samples it at its own on-screen
    // position — a true window, no reprojection. The nebula recedes to a film: dense
    // at the oval rim, wisps drifting across the middle, the centre kept clear to aim.
    vec2 ruv = clamp(v_clip.xy / v_clip.w * 0.5 + 0.5, vec2(0.002), vec2(0.998));
    vec3 view = texture2D(u_portalViewTex, ruv).rgb;
    float film = clamp(clouds * 0.30 * smoothstep(0.25, 0.9, r)
                     + smoothstep(0.72, 1.0, r) * 0.8 + rim * 0.08, 0.0, 1.0);
    vec3 windowed = mix(view, col, film) + base * rim * 0.35 + base * fil * core * 0.15;
    col = mix(col, windowed, window);
    alpha = edge * live * mix(0.55 + clouds * 0.30 + arms * 0.15, 1.0, window);
  } else {
    // nebula mode: alpha-composited (not additive) so the gaps stay a dark void and
    // the swirl keeps contrast against bright walls, while the HDR bits feed bloom.
    alpha = edge * live * (0.55 + clouds * 0.30 + arms * 0.15);
    // hostile: the void is a black backdrop — full coverage inside the oval (still
    // fading out with the portal's own life so expiry doesn't pop)
    alpha = max(alpha, edge * live * solid);
  }
  gl_FragColor = outputSRGBCorrection(vec4(col * live, alpha));
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
  base: [number, number, number]; // ring/nebula base colour (own slot colour · hostile red)
  root: Entity;
  ringMat: UnlitMaterial;
  live: Vector4;    // u_portalLive backing store (mutated in place — shaderData keeps the ref)
  discMat: Material; // the nebula/window material (gets u_portalVP when this is the view portal)
  ring: Entity;
  hum: PortalHum | null; // spun up lazily when within earshot (see update)
}

/** drives Portals.renderView from the engine's script pipeline (onLateUpdate runs
 *  after all game logic and right before the main camera renders — same slot the
 *  water reflection uses), so the RT is always this frame's view. */
class PortalViewDriver extends Script {
  portals!: Portals;
  override onLateUpdate(): void { this.portals.renderView(); }
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

  // ── see-through view (local pair only): one RT + one camera, at most one extra
  // scene render per frame, of the most view-relevant portal ──
  private viewCam: Camera;
  private viewTex: Texture2D;
  private viewP: Portal | null = null; // the portal currently rendered as a window
  private tmpPinv = new Matrix();
  private tmpView = new Matrix();
  private tmpProj = new Matrix();
  private tmpInv = new Matrix();

  constructor(private engine: Engine, parent: Entity, private mainCam: Camera, private rel: (p: Vec3) => { pan: number; dist: number }) {
    this.root = parent.createChild("portals");
    // shared unit meshes, sized per portal by entity scale (zero geometry per spawn).
    // The torus lies in the XY plane (normal +Z) — exactly the portal's local frame.
    this.ringMesh = PrimitiveMesh.createTorus(this.engine, 1, 0.07, 18, 40);
    this.discMesh = PrimitiveMesh.createPlane(this.engine, 2, 2); // XZ plane, uv 0..1

    // the view camera — the water-reflection recipe: manual render, no post/HDR/MSAA,
    // culling out the layers that would break it (water samples camera textures this
    // camera doesn't produce; discs must not sample the RT they're drawn into).
    const e = this.root.createChild("portal-view");
    const cam = e.addComponent(Camera);
    cam.enabled = false; // rendered manually from renderView
    cam.cullingMask = (Layer.Everything & ~(WATER_LAYER | NO_REFLECT_LAYER | PORTAL_SURF_LAYER | CLOUD_RT_LAYER)) as Layer;
    cam.farClipPlane = mainCam.farClipPlane;
    cam.enablePostProcess = false;
    cam.enableHDR = false;
    cam.opaqueTextureEnabled = false;
    cam.msaaSamples = MSAASamples.None;
    const size = Math.max(engine.canvas.width, engine.canvas.height) >= 1600 ? 1024 : 512;
    const tex = new Texture2D(engine, size, size, TextureFormat.R8G8B8A8, false);
    tex.wrapModeU = TextureWrapMode.Clamp;
    tex.wrapModeV = TextureWrapMode.Clamp;
    cam.renderTarget = new RenderTarget(engine, size, size, tex);
    this.viewCam = cam;
    this.viewTex = tex;
    const drv = this.root.addComponent(PortalViewDriver);
    drv.portals = this;
  }

  /** the nebula material: alpha-blended void + HDR nebula — no depth write, both faces */
  private vortexMaterial(base: [number, number, number], accent: [number, number, number], live: Vector4): Material {
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
    const [br, bg, bb] = base;
    const [ar, ag, ab] = accent;
    m.shaderData.setVector4("u_portalColor", new Vector4(br, bg, bb, Math.random() * 20)); // a = phase seed
    m.shaderData.setVector4("u_portalColor2", new Vector4(ar, ag, ab, 0));
    m.shaderData.setVector4("u_portalLive", live);
    // bound for every portal so the sampler is never dangling; only sampled while
    // live.z > 0, which renderView grants to at most one portal at a time
    m.shaderData.setTexture("u_portalViewTex", this.viewTex);
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

    // your own pair keeps its blue/orange identity; anyone else's reads hostile red —
    // both colours, over an opaque black void (no window, and you can't use it anyway)
    const base = local ? BASE[slot] : HOSTILE_BASE;
    const accent = local ? ACCENT[slot] : HOSTILE_ACCENT;
    const [br, bg, bb] = base;
    const ringMat = new UnlitMaterial(this.engine);
    ringMat.baseColor = new Color(br * 4, bg * 4, bb * 4, 1); // HDR → bloom halo
    const ring = root.createChild("ring");
    const rr = ring.addComponent(MeshRenderer);
    rr.mesh = this.ringMesh;
    rr.setMaterial(ringMat);
    rr.castShadows = false;
    rr.receiveShadows = false;
    ring.transform.setScale(PORTAL_HALF_W, PORTAL_HALF_H, 1);

    // nebula disc: the shared XZ plane stood up into the portal's XY frame
    // (rot +90° X maps local Z → −Y, so scale is W along X, H along local Z)
    const live = new Vector4(1, 0, 0, local ? 0 : 1); // w: hostile → opaque void
    const disc = root.createChild("disc");
    disc.layer = PORTAL_SURF_LAYER; // culled from the see-through camera (no feedback)
    disc.transform.setRotation(90, 0, 0);
    disc.transform.setScale(PORTAL_HALF_W, 1, PORTAL_HALF_H);
    const dr = disc.addComponent(MeshRenderer);
    dr.mesh = this.discMesh;
    const discMat = this.vortexMaterial(base, accent, live);
    dr.setMaterial(discMat);
    dr.castShadows = false;
    dr.receiveShadows = false;

    // wisps: soft additive motes breathing out of the surface (cone → local +Y,
    // so pitching the emitter +90° X aims it along the portal normal, +Z)
    const wisps = buildParticles(this.engine, root, 0, 0, 0.05, {
      rate: 16, lifetime: 1.3, speed: 0.5, size: 0.09, growth: 0.3, spread: 55,
      emitRadius: 0.8, gravity: 0, color: [br * 2.5, bg * 2.5, bb * 2.5], opacity: 0.85,
      additive: true, world: false,
    });
    wisps.transform.setRotation(90, 0, 0);
    // nebula mist: slower, larger accent-coloured billows drifting off the disc —
    // the same emitter recipe, tuned soft, so the rift reads as leaking nebula
    const [ar, ag, ab] = accent;
    const mist = buildParticles(this.engine, root, 0, 0, 0.08, {
      rate: 6, lifetime: 2.4, speed: 0.22, size: 0.24, growth: 0.9, spread: 70,
      emitRadius: 0.9, gravity: 0, color: [ar * 1.8, ag * 1.8, ab * 1.8], opacity: 0.4,
      additive: true, world: false,
    });
    mist.transform.setRotation(90, 0, 0);

    const now = performance.now() / 1000;
    this.portals.push({
      owner, slot, local, c: { ...c }, n: { ...n }, t, b,
      until: now + PORTAL_LIFE, cdUntil: now + 0.2, phase: 0, base,
      root, ringMat, live, discMat, ring, hum: null,
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
    if (this.viewP === p) this.viewP = null;
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
      // window fade: eases toward 1 while this is the see-through portal (renderView
      // picks it), toward 0 otherwise — so the rift "resolves" instead of popping
      const zt = this.viewP === p ? 1 : 0;
      p.live.z += (zt - p.live.z) * Math.min(dt * 7, 1);
      if (p.live.z < 0.005) p.live.z = 0;
      const dx = p.c.x - cam.x, dy = p.c.y - cam.y, dz = p.c.z - cam.z;
      if (dx * dx + dy * dy + dz * dz > ANIM_DIST * ANIM_DIST) continue;
      const pulse = 1 + (0.03 + 0.08 * (1 - lifeFrac)) * Math.sin(p.phase * 2);
      p.ring.transform.setScale(PORTAL_HALF_W * pulse, PORTAL_HALF_H * pulse, 1);
      // nebula urgency + brightness (shaderData holds the ref — mutate in place)
      p.live.x = 0.35 + 0.65 * lifeFrac;
      p.live.y = 1 - lifeFrac;
      // ring emissive dims toward expiry (mutate + reassign to flag the material dirty)
      const k = (0.3 + 0.7 * lifeFrac) * 4;
      const [br, bg, bb] = p.base;
      const rc = p.ringMat.baseColor;
      rc.r = br * k; rc.g = bg * k; rc.b = bb * k;
      p.ringMat.baseColor = rc;
    }
  }

  // ── see-through view ────────────────────────────────────────────────────────

  /** Render the exit-side scene for the most view-relevant LOCAL portal into the
   *  shared RT — the parallax-correct "window" the disc shader samples. Runs from
   *  PortalViewDriver.onLateUpdate (after game logic, before the main camera), so
   *  the window always shows this frame's world.
   *
   *  Cost model: at most ONE extra scene render per frame (reduced res, no post, no
   *  HDR, no MSAA, water + viewmodel + discs culled), and none at all when no local
   *  pair is on screen — remote players' portals stay pure nebula, so the cost is
   *  independent of the player count. */
  renderView(): void {
    const camT = this.mainCam.entity.transform;
    const e = camT.worldPosition;
    const f = camT.worldForward;

    // pick the local, linked portal most worth a window: in range, front side
    // toward the camera, and roughly in view (generous — the disc has extent)
    let best: Portal | null = null;
    let bestScore = 0;
    for (const p of this.portals) {
      if (!p.local || !this.linked(p)) continue;
      const dx = p.c.x - e.x, dy = p.c.y - e.y, dz = p.c.z - e.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > VIEW_DIST * VIEW_DIST || d2 < 1e-6) continue;
      const dist = Math.sqrt(d2);
      if ((-dx * p.n.x - dy * p.n.y - dz * p.n.z) < 0.02) continue; // camera behind it
      const facing = (dx * f.x + dy * f.y + dz * f.z) / dist;       // is it where you look?
      if (facing < 0.1 && dist > 5) continue;
      const score = (facing + 0.4) / d2;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    this.viewP = best;
    if (!best) return;
    const out = this.linked(best)!;

    // ── virtual view: V' = V_main · P⁻¹, where P is the entry→exit rigid transform
    // (t1→−t2, b1→b2, n1→−n2 — the same mapping traversal uses, so what the window
    // shows is exactly where a crossing lands). P⁻¹ = T(c1) · Rᵀ · T(−c2), with
    // Rᵀ v = −t1(t2·v) + b1(b2·v) − n1(n2·v). Proper rotation (det +1): winding
    // survives, no mirror flip needed.
    const p1 = best, p2 = out;
    const m = this.tmpPinv.elements;
    const col = (o: number, vx: number, vy: number, vz: number): void => {
      m[o] = -p1.t.x * vx + p1.b.x * vy - p1.n.x * vz;
      m[o + 1] = -p1.t.y * vx + p1.b.y * vy - p1.n.y * vz;
      m[o + 2] = -p1.t.z * vx + p1.b.z * vy - p1.n.z * vz;
      m[o + 3] = 0;
    };
    col(0, p2.t.x, p2.b.x, p2.n.x);  // Rᵀ · ex
    col(4, p2.t.y, p2.b.y, p2.n.y);  // Rᵀ · ey
    col(8, p2.t.z, p2.b.z, p2.n.z);  // Rᵀ · ez
    // translation: c1 − Rᵀ·c2
    const c2t = dot(p2.c, p2.t), c2b = dot(p2.c, p2.b), c2n = dot(p2.c, p2.n);
    m[12] = p1.c.x - (-p1.t.x * c2t + p1.b.x * c2b - p1.n.x * c2n);
    m[13] = p1.c.y - (-p1.t.y * c2t + p1.b.y * c2b - p1.n.y * c2n);
    m[14] = p1.c.z - (-p1.t.z * c2t + p1.b.z * c2b - p1.n.z * c2n);
    m[15] = 1;
    Matrix.multiply(this.mainCam.viewMatrix, this.tmpPinv, this.tmpView);

    // ── projection: main frustum with the near plane clipped to the exit portal
    // plane, so geometry between the virtual eye (inside the wall) and the exit
    // surface can't haunt the window. Lift by VIEW_BIAS (< the disc's own GAP).
    this.tmpProj.copyFrom(this.mainCam.projectionMatrix);
    Matrix.invert(this.tmpView, this.tmpInv);
    const ie = this.tmpInv.elements;
    const nx = p2.n.x, ny = p2.n.y, nz = p2.n.z;
    const w = -(nx * p2.c.x + ny * p2.c.y + nz * p2.c.z) + VIEW_BIAS;
    makeOblique(
      this.tmpProj,
      nx * ie[0] + ny * ie[1] + nz * ie[2] + w * ie[3],
      nx * ie[4] + ny * ie[5] + nz * ie[6] + w * ie[7],
      nx * ie[8] + ny * ie[9] + nz * ie[10] + w * ie[11],
      nx * ie[12] + ny * ie[13] + nz * ie[14] + w * ie[15],
    );

    // seat the entity at the virtual eye (render-queue distance sorting), hand the
    // camera its matrices, render. The disc samples this RT in screen space (the RT
    // shares the main projection), so no VP needs publishing to the material.
    const rel = { x: e.x - p1.c.x, y: e.y - p1.c.y, z: e.z - p1.c.z };
    const eye = this.mapPoint(p2, dot(rel, p1.t), dot(rel, p1.b), -dot(rel, p1.n));
    this.viewCam.entity.transform.setPosition(eye.x, eye.y, eye.z);
    this.viewCam.viewMatrix = this.tmpView;
    this.viewCam.projectionMatrix = this.tmpProj;
    this.viewCam.render();
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
      // portal; dropped clear of a ceiling one. Wall exits preserve the horizontal
      // entry offset (mapped through the frame: enter left of centre, exit on the
      // matching side), clamped so the capsule stays inside the oval — crossing
      // off-centre then reads as walking through a doorway, not snapping to it.
      let feet: Vec3;
      if (out.n.y > 0.9) feet = { x: out.c.x, y: out.c.y + 0.05, z: out.c.z };
      else if (out.n.y < -0.9) feet = { x: out.c.x, y: out.c.y - MOVE.height - 0.1, z: out.c.z };
      else {
        const off = MOVE.radius + 0.15;
        const margin = PORTAL_HALF_W - MOVE.radius - 0.05;
        const lxc = clamp(lx, -margin, margin);
        feet = {
          x: out.c.x - out.t.x * lxc + out.n.x * off,
          y: out.c.y - MOVE.height * 0.5,
          z: out.c.z - out.t.z * lxc + out.n.z * off,
        };
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
