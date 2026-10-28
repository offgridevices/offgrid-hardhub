import { app } from "./http";
import type { Env } from "./env";

export { ProjectRoom } from "./room";
export { EngineContainer } from "./engine";

// On Cloudflare one Worker serves both: the web app's files (the ASSETS
// binding, with every app route falling back to index.html) and the API
// under /api. Locally the API runs on its own port, with or without /api.
export default {
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4) || "/";
      return app.fetch(new Request(url, req), env, ctx);
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
