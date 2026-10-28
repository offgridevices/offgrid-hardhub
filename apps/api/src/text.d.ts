// Markdown files are bundled as text (wrangler "Text" rule; a vitest plugin in tests).
declare module "*.md" {
  const text: string;
  export default text;
}
