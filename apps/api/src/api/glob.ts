// A small glob matcher for areas' paths (slice 3.1, from its review): `*` (any characters but
// `/`), `**` (any characters, `/` included) and `?` (one character but `/`); everything else is
// literal. It runs in time proportional to the pattern times the path, whatever the pattern, so
// no pattern a person writes can hang routing, as Node's `matchesGlob` can with braces or
// extglobs.

type Token =
  { kind: "char"; char: string } | { kind: "star" } | { kind: "globstar" } | { kind: "one" };

function tokens(pattern: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*" && pattern.charAt(i + 1) === "*") {
      out.push({ kind: "globstar" });
      i++;
      // `**/` also matches nothing at all: `a/**/b` matches `a/b`.
      if (pattern.charAt(i + 1) === "/") i++;
      // Repeated stars mean the same.
      while (pattern.charAt(i + 1) === "*") i++;
    } else if (char === "*") {
      out.push({ kind: "star" });
    } else if (char === "?") {
      out.push({ kind: "one" });
    } else {
      out.push({ kind: "char", char });
    }
  }
  return out;
}

/** Whether all of `path` matches all of `pattern`. */
function matchWhole(path: string, pattern: Token[]): boolean {
  // reach[j]: the first i tokens can match the first j characters of the path.
  let reach: boolean[] = new Array<boolean>(path.length + 1).fill(false);
  reach[0] = true;
  for (const token of pattern) {
    const next: boolean[] = new Array<boolean>(path.length + 1).fill(false);
    if (token.kind === "star" || token.kind === "globstar") {
      for (let j = 0; j <= path.length; j++) {
        if (reach[j] === true) next[j] = true;
        else if (
          j > 0 &&
          next[j - 1] === true &&
          (token.kind === "globstar" || path[j - 1] !== "/")
        ) {
          next[j] = true;
        }
      }
    } else {
      for (let j = 1; j <= path.length; j++) {
        if (reach[j - 1] !== true) continue;
        const c = path.charAt(j - 1);
        next[j] = token.kind === "one" ? c !== "/" : c === token.char;
      }
    }
    reach = next;
  }
  return reach[path.length] === true;
}

/**
 * Whether a repository path falls under a pattern, like a CODEOWNERS line: a pattern matches
 * the path or anything under it (`apps/web` covers `apps/web/src/x.ts`), and a pattern with no
 * `/` matches at any depth (`*.sql` covers `supabase/migrations/x.sql`).
 */
export function globMatches(path: string, pattern: string): boolean {
  const clean = pattern.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (clean === "") return false;
  const anywhere = clean.includes("/") ? clean : `**/${clean}`;
  const parsed = tokens(anywhere);
  return matchWhole(path, parsed) || matchWhole(path, [...parsed, ...tokens("/**")]);
}

/** The characters a pattern may hold: no braces, brackets or extglobs, which this does not read. */
export const SAFE_GLOB = /^[A-Za-z0-9._\-/*?@+ ]+$/;
