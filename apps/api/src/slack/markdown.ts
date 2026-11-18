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

function convertInline(text: string): string {
  const lines = escapeHtml(text).split("\n");
  return lines
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      // Bold markers are placeholders until the italic rule has run, so it can't touch them.
      if (heading?.[1] !== undefined) return `\u0000${stripEmphasis(heading[1])}\u0000`;
      return line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "\u0000$2\u0000")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replaceAll("\u0000", "*");
}

function stripEmphasis(text: string): string {
  return text.replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
    if (cut < limit / 2) cut = limit;
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
