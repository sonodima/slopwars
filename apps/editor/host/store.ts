// ─── Asset store: one browsable list over pluggable CC0 sources ──────────────
// The editor's store pane talks to THIS module only; each source is an adapter
// with the same PhAsset/PhImportResult contract (see polyhaven.ts), registered
// in SOURCES below — adding a library is one adapter + one registry entry, the
// pane and the routes never change. Listing merges every source's popularity-
// sorted list by rank interleave — first place of each source, then second
// place of each, … — so sources with incomparable raw download counts can't
// drown each other out. Imports are dispatched to the asset's source, carried
// on each entry.
import { phImport, phList, type PhAsset, type PhImportRequest, type PhImportResult, type PhType } from "./polyhaven";

export type StoreSource = "polyhaven";
export interface StoreAsset extends PhAsset { source: StoreSource }
export interface StoreImportRequest extends PhImportRequest { source: StoreSource }

interface SourceAdapter {
  list: (type: PhType) => Promise<PhAsset[]>;
  import: (root: string, req: PhImportRequest) => Promise<PhImportResult>;
}

const SOURCES: Record<StoreSource, SourceAdapter> = {
  polyhaven: { list: phList, import: phImport },
};

/** merged listing. One source failing (network hiccup, API down) degrades to the
 *  others' results instead of an empty pane; all failing surfaces the error. */
export async function storeList(type: PhType): Promise<StoreAsset[]> {
  const names = Object.keys(SOURCES) as StoreSource[];
  const settled = await Promise.allSettled(names.map((n) => SOURCES[n].list(type)));
  if (settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  const lists = names.map((n, i) => {
    const s = settled[i];
    return s.status === "fulfilled" ? s.value.map((x): StoreAsset => ({ ...x, source: n })) : [];
  });
  const out: StoreAsset[] = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

export async function storeImport(root: string, req: StoreImportRequest): Promise<PhImportResult> {
  const src = SOURCES[req.source];
  if (!src) return { error: `unknown asset source: ${String(req.source)}` };
  return src.import(root, req);
}
