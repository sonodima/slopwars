// Vendor the Galacean PhysX runtime into public/physx/ so the game self-hosts it
// (no CDN dependency at runtime). The shipped physx.release.js hardcodes the wasm's
// CDN URL and its Emscripten locateFile naively prepends the script directory, which
// breaks when self-hosted — so we rewrite wasmBinaryFile to a plain relative name,
// resolving to /physx/physx.release.wasm next to the loader.
//
// Re-run after bumping @galacean/engine-physics-physx:  node scripts/vendor-physx.mjs
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// the package is a dependency of the game workspace — resolve from there
const require = createRequire(resolve(root, "apps/game/package.json"));
const pkgDir = dirname(require.resolve("@galacean/engine-physics-physx/package.json"));
const libs = resolve(pkgDir, "libs");
const out = resolve(root, "public/physx");
mkdirSync(out, { recursive: true });

for (const f of ["physx.release.js", "physx.release.wasm", "physx.release.downgrade.js"]) {
  copyFileSync(resolve(libs, f), resolve(out, f));
}

// point the wasm at a local relative filename (see header)
const jsPath = resolve(out, "physx.release.js");
const patched = readFileSync(jsPath, "utf8").replace(
  /wasmBinaryFile="https:\/\/[^"]*\/physx\.release\.wasm"/,
  'wasmBinaryFile="physx.release.wasm"',
);
writeFileSync(jsPath, patched);
console.log("vendored PhysX runtime → public/physx/ (wasm path localised)");
