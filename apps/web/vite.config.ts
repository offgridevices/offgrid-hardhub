/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Preload the two body-text font files so the first paint already has them
// and text does not shift when they arrive.
function preloadFonts(names: string[]): Plugin {
  return {
    name: "hardhub:preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => f.endsWith(".woff2") && names.some((n) => f.includes(n)));
        return files.map((f) => ({
          tag: "link",
          attrs: { rel: "preload", href: `/${f}`, as: "font", type: "font/woff2", crossorigin: "" },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

// The app is static files; it talks to the API at VITE_API_URL
// (default http://localhost:8787, where `wrangler dev` serves it).
export default defineConfig({
  plugins: [react(), preloadFonts(["instrument-sans-latin-400-normal", "instrument-sans-latin-500-normal"])],
  server: { host: "0.0.0.0", port: 5173 },
  preview: { host: "0.0.0.0", port: 5173 },
  worker: { format: "es" },
  build: {
    target: "es2022",
    // three.js is one lazy chunk, loaded only by the 3D tab
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes("node_modules/three") ? "three" : undefined) },
    },
  },
  test: { environment: "jsdom", include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
});
