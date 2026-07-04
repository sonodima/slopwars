// ─── Remote players: avatar, interpolation buffer, hitboxes ──────────────────
import { BlinnPhongMaterial, Color, Engine, Entity, MeshRenderer, PrimitiveMesh } from "@galacean/engine";
import { AABB, rayAABB } from "./map";
import { INTERP_DELAY, PlayerState, Vec3, WeaponId, clamp } from "./types";

interface Sample { time: number; p: [number, number, number]; yaw: number; pitch: number; cr: number }

export class RemotePlayer {
  entity: Entity;
  hp = 100;
  weapon: WeaponId = "ak47";
  pos: Vec3 = { x: 0, y: -100, z: 0 };
  yaw = 0;
  crouched = false;
  alive = true;

  private buf: Sample[] = [];

  constructor(engine: Engine, parent: Entity, public id: string, public name: string, color: number) {
    this.entity = parent.createChild("rp-" + id);
    const c = new Color(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1);
    const mBody = new BlinnPhongMaterial(engine); mBody.baseColor = c;
    const mDark = new BlinnPhongMaterial(engine); mDark.baseColor = new Color(0.15, 0.14, 0.13, 1);
    const mSkin = new BlinnPhongMaterial(engine); mSkin.baseColor = new Color(0.85, 0.65, 0.5, 1);

    const mk = (name: string, x: number, y: number, z: number, w: number, h: number, d: number, m: BlinnPhongMaterial): Entity => {
      const e = this.entity.createChild(name);
      e.transform.setPosition(x, y, z);
      const r = e.addComponent(MeshRenderer);
      r.mesh = PrimitiveMesh.createCuboid(engine, w, h, d);
      r.setMaterial(m);
      r.castShadows = true;
      return e;
    };

    mk("legs", 0, 0.45, 0, 0.5, 0.9, 0.32, mDark);
    mk("torso", 0, 1.22, 0, 0.62, 0.64, 0.36, mBody);
    mk("head", 0, 1.72, 0, 0.3, 0.3, 0.3, mSkin);
    mk("gun", 0.28, 1.3, -0.35, 0.06, 0.08, 0.55, mDark);
    this.entity.isActive = false;
  }

  push(s: PlayerState, time: number): void {
    this.hp = s.hp;
    this.weapon = s.w;
    this.buf.push({ time, p: s.p, yaw: s.yaw, pitch: s.pitch, cr: s.cr });
    if (this.buf.length > 30) this.buf.shift();
  }

  update(now: number): void {
    const t = now - INTERP_DELAY;
    const b = this.buf;
    if (b.length === 0) return;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].time <= t && b[i + 1].time >= t) { a = b[i]; c = b[i + 1]; break; }
    }
    const span = c.time - a.time;
    const k = span > 1e-4 ? clamp((t - a.time) / span, 0, 1) : 1;
    this.pos.x = a.p[0] + (c.p[0] - a.p[0]) * k;
    this.pos.y = a.p[1] + (c.p[1] - a.p[1]) * k;
    this.pos.z = a.p[2] + (c.p[2] - a.p[2]) * k;
    let dy = c.yaw - a.yaw;
    if (dy > Math.PI) dy -= 2 * Math.PI; else if (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw = a.yaw + dy * k;
    this.crouched = c.cr === 1;

    this.entity.isActive = this.alive;
    this.entity.transform.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.entity.transform.setRotation(0, (this.yaw * 180) / Math.PI, 0);
    const s = this.crouched ? 0.72 : 1;
    this.entity.transform.setScale(1, s, 1);
  }

  /** ray test → { dist, head } or null. Ray in world space. */
  hitTest(o: Vec3, d: Vec3, maxDist: number): { dist: number; head: boolean } | null {
    if (!this.alive) return null;
    const sy = this.crouched ? 0.72 : 1;
    // body AABB (world, yaw-agnostic approximation)
    const body: AABB = {
      min: { x: this.pos.x - 0.36, y: this.pos.y, z: this.pos.z - 0.36 },
      max: { x: this.pos.x + 0.36, y: this.pos.y + 1.58 * sy, z: this.pos.z + 0.36 },
    };
    // head sphere
    const hc = { x: this.pos.x, y: this.pos.y + 1.72 * sy, z: this.pos.z };
    const hHit = raySphere(o, d, hc, 0.21, maxDist);
    const bHit = rayAABB(o, d, body, maxDist);
    if (hHit !== null && (bHit === null || hHit <= bHit.dist)) return { dist: hHit, head: true };
    if (bHit) return { dist: bHit.dist, head: false };
    return null;
  }

  gunMuzzle(): Vec3 {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { x: this.pos.x - s * 0.6 + c * 0.28, y: this.pos.y + 1.3, z: this.pos.z - c * 0.6 - s * 0.28 };
  }
}

function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number, maxDist: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < maxDist ? t : null;
}
