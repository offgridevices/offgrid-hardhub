// The system prompt: the skills, in order. It never changes between
// requests (no dates, no ids), so the provider can cache it with the tools.
import role from "./skills/01-role.md";
import designDoc from "./skills/02-design-document.md";
import parts from "./skills/03-parts.md";
import circuit from "./skills/04-circuit.md";
import layout from "./skills/05-layout.md";
import done from "./skills/06-done.md";

export const SYSTEM_PROMPT = [role, designDoc, parts, circuit, layout, done].map((s) => s.trim()).join("\n\n");

/** For a chat turn run by the person's own Claude Code (bridge.ts): the same
 * guide, and how it reaches the board from there. */
export function chatSystemPrompt(projectId: string): string {
  return `# You are HardHub's chat, running in Claude Code

You are working in HardHub's chat on the person's own computer, on their Claude plan. Your text replies appear in HardHub's chat as you write them. You have no shell or files: you reach the board only through the hardhub tools.

- This conversation is about one project: pass project "${projectId}" to every hardhub tool.
- Ask the person with \`ask_user\` (it shows multiple-choice cards in HardHub), then end your turn: their answers arrive as the next message.
- \`build_board\` runs in the background; call \`wait_for_build\` until it reports the result.
- Look at your work after each build with \`view_board\` and \`inspect_board\`.

${SYSTEM_PROMPT}`;
}
