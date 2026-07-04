import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single inlined HTML output → dist/index.html (the shareable serverless build).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2020",
    // one self-contained file: no separate asset requests
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: 4096,
  },
});
