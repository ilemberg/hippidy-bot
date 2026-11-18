/**
 * Converts the agent's Markdown to Slack's mrkdwn. Covers what the agent is told to use:
 * bold, italics, strikethrough, inline code, code blocks, links, headings and lists.
 * Code is left untouched; everything else is escaped as Slack requires (&, <, >).
 */
export function markdownToSlack(markdown: string): string {
  const parts = markdown.replace(/\r\n/g, "\n").split(/(```[\s\S]*?(?:```|$))/);
  return parts
    .map((part, index) => (index % 2 === 1 ? convertCodeBlock(part) : convertText(part)))
    .join("")
    .trim();
}

function convertCodeBlock(block: string): string {
  // Drop the language tag after the opening fence; Slack shows it as text otherwise.
  const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
  return "```\n" + escapeHtml(body.replace(/\n$/, "")) + "\n```";
}

function convertText(text: string): string {
  // Inline code first, so nothing inside it is converted.
  return text
    .split(/(`[^`\n]+`)/)
    .map((piece, index) => (index % 2 === 1 ? escapeHtml(piece) : convertInline(piece)))
    .join("");
}

/** Marks where a protected link goes back in; a control character never typed by people. */
const LINK_PLACEHOLDER = new RegExp(String.raw`\u0001(\d+)\u0001`, "g");

function convertInline(text: string): string {
  // Links become placeholders first, so emphasis rules never touch a URL.
  const links: string[] = [];
  const protectedText = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => {
      links.push(`<${escapeHtml(url)}|${escapeHtml(label)}>`);
      return `\u0001${links.length - 1}\u0001`;
    },
  );
  const lines = escapeHtml(protectedText).split("\n");
  return lines
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      // Bold markers are placeholders until the italic rule has run, so it can't touch them.
      if (heading?.[1] !== undefined) return `\u0000${stripEmphasis(heading[1])}\u0000`;
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "\u0000$2\u0000")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replaceAll("\u0000", "*")
    .replace(LINK_PLACEHOLDER, (_match, index: string) => links[Number(index)] ?? "");
}

function stripEmphasis(text: string): string {
  return text.replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A cut at `limit` that does not fall inside an escape (`&amp;`) or a link (`<url|text>`). */
function safeHardCut(text: string, limit: number): number {
  const head = text.slice(0, limit);
  const openLink = head.lastIndexOf("<");
  if (openLink > head.lastIndexOf(">") && openLink > 0) return openLink;
  const amp = head.lastIndexOf("&");
  if (amp > head.length - 6 && !head.slice(amp).includes(";") && amp > 0) return amp;
  return limit;
}

/** Slack accepts long messages, but they read badly; replies are split well below the limit. */
export const SLACK_CHUNK_CHARS = 3500;

/**
 * Splits a converted message into chunks of at most `limit` characters, at paragraph or line
 * breaks where possible. A code block cut in two is closed and reopened, so both halves render.
 */
export function splitForSlack(text: string, limit = SLACK_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = safeHardCut(rest, limit);
    let chunk = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\n+/, "");
    if ((chunk.match(/```/g) ?? []).length % 2 === 1) {
      chunk += "\n```";
      rest = "```\n" + rest;
    }
    chunks.push(chunk);
  }
  if (rest.trim() !== "") chunks.push(rest);
  return chunks;
}
