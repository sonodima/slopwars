// One-shot: evaluate the legacy TypeScript map modules and serialize each to
// maps/<id>.json. After this the JSON files are the source of truth and the TS
// map modules are removed. Kept in-repo as a record of the migration.
import esbuild from "../node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const gameSrc = path.resolve("apps/game/src/maps");
const shared = path.resolve("packages/shared/src/index.ts");
const outDir = path.resolve("maps");
fs.mkdirSync(outDir, { recursive: true });

// map file -> export name, and whether it stays in the match rotation.
const MAPS = [
  { file: "koi.ts", name: "KOI", rotate: true },
  { file: "office.ts", name: "OFFICE", rotate: false },
  { file: "waterfall.ts", name: "WATERFALL", rotate: false },
  { file: "neon.ts", name: "NEON_GRAVEYARD", rotate: false },
];

for (const m of MAPS) {
  const entry = path.join(gameSrc, m.file);
  if (!fs.existsSync(entry)) { console.warn("skip missing", m.file); continue; }
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    alias: { "@slopwars/shared": shared },
  });
  const tmp = path.join(os.tmpdir(), `map-${m.name}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);
  const def = mod[m.name];
  if (!def) { console.error("no export", m.name, "in", m.file); continue; }
  def.meta.rotate = m.rotate;
  fs.writeFileSync(path.join(outDir, `${def.meta.id}.json`), JSON.stringify(def, null, 2) + "\n");
  console.log("wrote maps/" + def.meta.id + ".json");
}
