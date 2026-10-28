// The system prompt: the skills, in order. It never changes between
// requests (no dates, no ids), so the provider can cache it with the tools.
import role from "./skills/01-role.md";
import designDoc from "./skills/02-design-document.md";
import parts from "./skills/03-parts.md";
import circuit from "./skills/04-circuit.md";
import layout from "./skills/05-layout.md";
import done from "./skills/06-done.md";

export const SYSTEM_PROMPT = [role, designDoc, parts, circuit, layout, done].map((s) => s.trim()).join("\n\n");
