// ─── Poly Haven integration (host side) ──────────────────────────────────────
// Backs the editor's Poly Haven browser pane: a cached proxy for the public
// asset listing, and a server-side importer that downloads the chosen variant
// and lands it in the repo through the exact same code path as a manual import
// (importAsset), so a Poly Haven asset is indistinguishable from a hand-imported
// one. Downloading on the host (not in the page) keeps CORS + multi-megabyte
// base64 uploads out of the browser and lets us write NOTICE.txt provenance
// files (repo convention) atomically with the asset.
//
// Learned the hard way: api.polyhaven.com 403s non-browser User-Agents, so every
// request sends a Mozilla-style UA. Not every asset exists at every resolution
// (e.g. some textures start at 2k), so the requested resolution falls back to
// the nearest available one instead of failing.
//
// Model imports mirror the validated manual workflow: download the .gltf + its
// .bin, import the model (geometryOnlyModel strips textures and creates one
// library material per glTF slot, texture group = slot name), then import each
// slot's diff/nor_gl/rough-or-arm maps as a texture set named exactly after the
// slot — meta.materials wires it all together with no extra bookkeeping. Slot
// names are asset-prefixed upstream ("potted_plant_01_pot"), so no collisions.
import fs from "node:fs";
import path from "node:path";
import { importAsset, sanitize, type ImportFile } from "./files";

const API = "https://api.polyhaven.com";
const UA = "Mozilla/5.0 (SlopWars Editor) AppleWebKit/537.36";

export type PhType = "models" | "textures" | "hdris";

/** slim listing entry sent to the browser pane (the raw API entry is much fatter) */
export interface PhAsset {
  id: string;
  name: string;
  categories: string[];
  tags: string[];
  downloads: number;
  thumb: string;
}

export interface PhImportRequest { type: PhType; id: string; res?: string }
export interface PhImportResult {
  ok?: boolean;
  error?: string;
  name?: string;
  /** resolution actually used (after nearest-available fallback) */
  res?: string;
  /** texture sets created alongside a model (one per material slot) */
  textures?: string[];
}

async function phFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res;
}

async function fetchB64(url: string): Promise<string> {
  return Buffer.from(await (await phFetch(url)).arrayBuffer()).toString("base64");
}

// ── listing (cached — the full per-type list is a few hundred KB upstream) ────

const LIST_TTL = 10 * 60_000;
const listCache = new Map<PhType, { at: number; assets: PhAsset[] }>();

export async function phList(type: PhType): Promise<PhAsset[]> {
  const hit = listCache.get(type);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.assets;
  const raw = await (await phFetch(`${API}/assets?type=${type}`)).json() as Record<string, {
    name?: string; categories?: string[]; tags?: string[]; download_count?: number; thumbnail_url?: string;
  }>;
  const assets: PhAsset[] = Object.entries(raw).map(([id, a]) => ({
    id,
    name: a.name ?? id,
    categories: a.categories ?? [],
    tags: a.tags ?? [],
    downloads: a.download_count ?? 0,
    thumb: a.thumbnail_url ?? `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
  })).sort((a, b) => b.downloads - a.downloads);   // most-used first, like their site
  listCache.set(type, { at: Date.now(), assets });
  return assets;
}

// ── import ────────────────────────────────────────────────────────────────────

/** the requested resolution if the asset has it, else the nearest available one
 *  (by ratio, ties toward the smaller — a game asset should err light) */
function pickRes<T>(byRes: Record<string, T>, want: string): { res: string; entry: T } | null {
  const keys = Object.keys(byRes).filter((k) => /^\d+k$/.test(k));
  if (!keys.length) return null;
  const n = (k: string): number => parseInt(k, 10);
  const target = n(want) || 1;
  keys.sort((a, b) => {
    const d = Math.abs(Math.log2(n(a) / target)) - Math.abs(Math.log2(n(b) / target));
    return d !== 0 ? d : n(a) - n(b);
  });
  return { res: keys[0], entry: byRes[keys[0]] };
}

/** provenance note (repo convention: NOTICE.txt beside any asset we didn't author) */
function noticeText(id: string, what: string, res: string): string {
  return `${what} — imported from Poly Haven (https://polyhaven.com/a/${id}).\n`
    + `License: CC0 (public domain). Downloaded via the editor's Poly Haven\n`
    + `browser (${res} variant) on ${new Date().toISOString().slice(0, 10)}.\n`;
}

function writeNotice(root: string, rel: string, text: string): void {
  const abs = path.join(root, "public", "assets", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

interface FileEntry { url: string; size?: number }

/** one downloadable format of one map at one resolution — prefer jpg (small, the
 *  game's material pipeline gains nothing from png here) */
function mapFile(entry: Record<string, FileEntry> | undefined): FileEntry | null {
  if (!entry) return null;
  return entry.jpg ?? entry.png ?? null;
}

// the Poly Haven map name for each of our PBR slots. `arm` is their packed
// AO/rough/metal map — exactly our arm semantics; nearly every texture has one.
const TEX_MAPS: { ph: string; slot: "color" | "normal" | "arm" }[] = [
  { ph: "Diffuse", slot: "color" },
  { ph: "nor_gl", slot: "normal" },
  { ph: "arm", slot: "arm" },
];

async function importTexture(root: string, id: string, want: string): Promise<PhImportResult> {
  const files = await (await phFetch(`${API}/files/${id}`)).json() as Record<string, Record<string, Record<string, FileEntry>>>;
  if (!files.Diffuse) return { error: `"${id}" has no diffuse map` };
  const picked = pickRes(files.Diffuse, want);
  if (!picked) return { error: `"${id}" has no downloadable resolutions` };
  const payload: ImportFile[] = [];
  for (const { ph, slot } of TEX_MAPS) {
    const byRes = files[ph];
    if (!byRes) continue;
    // keep every map at the SAME resolution as the diffuse pick when possible
    const f = mapFile(byRes[picked.res] ?? pickRes(byRes, picked.res)?.entry);
    if (!f) continue;
    payload.push({ name: path.basename(new URL(f.url).pathname), slot, data: await fetchB64(f.url) });
  }
  if (!payload.length) return { error: `"${id}" has no importable maps` };
  const r = importAsset(root, { kind: "texture", name: sanitize(id), files: payload });
  if (r.error || !r.name) return { error: r.error ?? "import failed" };
  writeNotice(root, `textures/${r.name}/NOTICE.txt`, noticeText(id, `Texture set "${r.name}"`, picked.res));
  return { ok: true, name: r.name, res: picked.res };
}

async function importHdri(root: string, id: string, want: string): Promise<PhImportResult> {
  const files = await (await phFetch(`${API}/files/${id}`)).json() as { hdri?: Record<string, Record<string, FileEntry>> };
  if (!files.hdri) return { error: `"${id}" has no HDRI files` };
  const picked = pickRes(files.hdri, want);
  const f = picked && (picked.entry.hdr ?? picked.entry.exr);
  if (!picked || !f) return { error: `"${id}" has no downloadable .hdr` };
  const ext = f === picked.entry.hdr ? "hdr" : "exr";
  const r = importAsset(root, {
    kind: "hdri", name: sanitize(id),
    files: [{ name: `${sanitize(id)}.${ext}`, data: await fetchB64(f.url) }],
  });
  if (r.error || !r.name) return { error: r.error ?? "import failed" };
  // hdri/ is a flat dir (no per-asset folder), so provenance rides a sidecar the
  // catalog scanner ignores (it only picks up .hdr/.exr).
  writeNotice(root, `hdri/${r.name}.NOTICE.txt`, noticeText(id, `HDRI "${r.name}"`, picked.res));
  return { ok: true, name: r.name, res: picked.res };
}

// minimal glTF shapes we read for the per-slot texture wiring
interface GltfTexRef { index: number }
interface GltfMaterial {
  name?: string;
  normalTexture?: GltfTexRef;
  occlusionTexture?: GltfTexRef;
  pbrMetallicRoughness?: { baseColorTexture?: GltfTexRef; metallicRoughnessTexture?: GltfTexRef };
}
interface Gltf {
  materials?: GltfMaterial[];
  textures?: { source: number }[];
  images?: { uri?: string }[];
}

async function importModel(root: string, id: string, want: string): Promise<PhImportResult> {
  const files = await (await phFetch(`${API}/files/${id}`)).json() as {
    gltf?: Record<string, { gltf: FileEntry & { include?: Record<string, FileEntry> } }>;
  };
  if (!files.gltf) return { error: `"${id}" has no glTF download` };
  const picked = pickRes(files.gltf, want);
  if (!picked) return { error: `"${id}" has no downloadable resolutions` };
  const main = picked.entry.gltf;
  const include = main.include ?? {};

  const gltfName = path.basename(new URL(main.url).pathname);
  const gltfText = await (await phFetch(main.url)).text();
  const gltf = JSON.parse(gltfText) as Gltf;

  // the model itself: the .gltf plus every included .bin buffer
  const payload: ImportFile[] = [{ name: gltfName, data: Buffer.from(gltfText).toString("base64") }];
  for (const [rel, f] of Object.entries(include)) {
    if (rel.toLowerCase().endsWith(".bin")) payload.push({ name: path.basename(rel), data: await fetchB64(f.url) });
  }
  const r = importAsset(root, { kind: "model", name: sanitize(id), files: payload });
  if (r.error || !r.name) return { error: r.error ?? "import failed" };

  // one texture set per material slot, named after the slot so the materials that
  // geometryOnlyModel just created (texture group = slot name) resolve immediately.
  // arm slot: their gltf wires the packed arm — or plain rough — as metallicRoughness.
  const uriOf = (ref?: GltfTexRef): string | undefined =>
    ref == null ? undefined : gltf.images?.[gltf.textures?.[ref.index]?.source ?? -1]?.uri;
  const textures: string[] = [];
  for (const m of gltf.materials ?? []) {
    const slot = sanitize(m.name ?? "");
    if (!slot) continue;
    const pbr = m.pbrMetallicRoughness ?? {};
    const wanted: { slot: "color" | "normal" | "arm"; uri?: string }[] = [
      { slot: "color", uri: uriOf(pbr.baseColorTexture) },
      { slot: "normal", uri: uriOf(m.normalTexture) },
      { slot: "arm", uri: uriOf(pbr.metallicRoughnessTexture) ?? uriOf(m.occlusionTexture) },
    ];
    const texFiles: ImportFile[] = [];
    for (const w of wanted) {
      const f = w.uri ? include[w.uri] : undefined;
      if (f) texFiles.push({ name: path.basename(w.uri!), slot: w.slot, data: await fetchB64(f.url) });
    }
    if (!texFiles.length) continue;
    const tr = importAsset(root, { kind: "texture", name: slot, files: texFiles });
    if (tr.name) {
      writeNotice(root, `textures/${tr.name}/NOTICE.txt`, noticeText(id, `Texture set "${tr.name}" (for model "${r.name}")`, picked.res));
      textures.push(tr.name);
    }
  }
  writeNotice(root, `models/${r.name}/NOTICE.txt`, noticeText(id, `Model "${r.name}"`, picked.res)
    + (textures.length ? `Companion texture sets: ${textures.join(", ")}.\n` : ""));
  return { ok: true, name: r.name, res: picked.res, textures };
}

export async function phImport(root: string, req: PhImportRequest): Promise<PhImportResult> {
  const id = String(req.id ?? "");
  const want = /^\d+k$/.test(String(req.res)) ? String(req.res) : "1k";
  if (!id) return { error: "missing asset id" };
  try {
    if (req.type === "textures") return await importTexture(root, id, want);
    if (req.type === "hdris") return await importHdri(root, id, want);
    if (req.type === "models") return await importModel(root, id, want);
    return { error: `unknown Poly Haven type: ${String(req.type)}` };
  } catch (e) {
    return { error: String(e) };
  }
}
