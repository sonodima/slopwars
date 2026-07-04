import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import { DEPLOY_PUBLIC_ASSETS } from "./src/model-manifest";

function copyToDist(root: string, outDir: string, relPath: string): void {
  const from = resolve(root, "public", relPath);
  const to = resolve(root, outDir, relPath);
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export default defineConfig({
  publicDir: false,
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
  plugins: [
    (() => {
      let buildRoot = "";
      let buildOutDir = "dist";
      return {
        name: "copy-public-assets",
        apply: "build",
        configResolved(config) {
          buildRoot = config.root;
          buildOutDir = config.build.outDir;
        },
        closeBundle() {
          for (const relPath of DEPLOY_PUBLIC_ASSETS) copyToDist(buildRoot, buildOutDir, relPath);
        },
      };
    })(),
  ],
  server: {
    allowedHosts: true
  }
});
