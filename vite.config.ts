import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    allowedHosts: true
  }
});
