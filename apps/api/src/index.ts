import { app } from "./http";
import type { Env } from "./env";

export { ProjectRoom } from "./room";
export { EngineContainer } from "./engine";

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
