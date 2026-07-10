// Vendor the Galacean PhysX runtime from the installed npm package into
// public/physx/ so the game self-hosts it (no CDN dependency at runtime — the
// default CDN is a third-party host that isn't always reachable). The wasm and its
// loader ship inside @galacean/engine-physics-physx/libs; we copy them out at
// build/dev time so nothing binary is committed to the repo (public/physx is
// gitignored). The shipped physx.release.js hardcodes the wasm's CDN URL and its
// Emscripten locateFile naively prepends the script directory, which breaks when
// self-hosted — so we rewrite wasmBinaryFile to a plain relative name, resolving to
// /physx/physx.release.wasm next to the loader.
//
// Invoked automatically by the game's Vite config (buildStart), and runnable by hand:
//   node scripts/vendor-physx.mjs
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = ["physx.release.js", "physx.release.wasm", "physx.release.downgrade.js"];

/** copy + patch the PhysX runtime into <root>/public/physx. Idempotent + cheap: skips
 *  when the outputs already exist and are newer than the source. */
export function vendorPhysx(root) {
  const require = createRequire(resolve(root, "apps/game/package.json"));
  const libs = resolve(dirname(require.resolve("@galacean/engine-physics-physx/package.json")), "libs");
  const out = resolve(root, "public/physx");
  const jsOut = resolve(out, "physx.release.js");
  // up-to-date? (loader exists, newer than its source) → nothing to do
  if (existsSync(jsOut) && statSync(jsOut).mtimeMs >= statSync(resolve(libs, "physx.release.js")).mtimeMs) return false;

  mkdirSync(out, { recursive: true });
  for (const f of RUNTIME) copyFileSync(resolve(libs, f), resolve(out, f));
  // point the wasm at a local relative filename (see header)
  const patched = readFileSync(jsOut, "utf8").replace(
    /wasmBinaryFile="https:\/\/[^"]*\/physx\.release\.wasm"/,
    'wasmBinaryFile="physx.release.wasm"',
  );
  writeFileSync(jsOut, patched);
  return true;
}

// run directly (CLI)
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const did = vendorPhysx(root);
  console.log(did ? "vendored PhysX runtime → public/physx/ (wasm path localised)" : "PhysX runtime already up to date");
}
