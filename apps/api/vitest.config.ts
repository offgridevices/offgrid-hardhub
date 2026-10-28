import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // the Worker bundles skills/*.md as text (wrangler "Text" rule); match it
      name: "markdown-as-text",
      transform(_code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
      },
    },
  ],
  resolve: {
    // the Worker runtime's module; tests only need the class to extend
    alias: { "cloudflare:workers": new URL("./test/support/cloudflare-workers.ts", import.meta.url).pathname },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
