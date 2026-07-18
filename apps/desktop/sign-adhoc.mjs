// electron-builder afterPack hook: ad-hoc sign the macOS bundle, deterministically.
//
// Why: CI has no signing identity, and electron-builder then SKIPS signing
// entirely — the packed app keeps only the raw linker signature of the Electron
// binary while its resources changed, i.e. a broken bundle seal. Gatekeeper
// reports a downloaded copy of that as "damaged and can't be opened", a dead end
// with no user override. A proper ad-hoc deep-sign (no certificate needed) makes
// the seal valid again, downgrading the friction to the standard unidentified-
// developer flow (System Settings → Privacy & Security → Open Anyway).
// Runs before electron-builder's own signing step, so a real Developer ID —
// if one ever exists in the environment — still wins by signing over this.
import { execSync } from "node:child_process";
import path from "node:path";

export default function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "inherit" });
}
