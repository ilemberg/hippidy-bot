// The pure parts of the Atlassian probe (`atlassian-probe.ts`, decisions 151 and 159), kept
// apart so they can be tested without the network.

/** Atlassian's remote MCP server (`stack-and-tools.md`, slice 5 candidates). */
export const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v2/mcp";

/**
 * The tools the project workflow would use (`projects.md`, "Two agents, one bot"), by the
 * names Atlassian's server is documented to use. The probe reports which of them it serves;
 * a name it does not serve is a finding, not a failure.
 */
export const WANTED_TOOLS = {
  identity: ["atlassianUserInfo", "getAccessibleAtlassianResources"],
  jira: [
    "getVisibleJiraProjects",
    "searchJiraIssuesUsingJql",
    "getJiraIssue",
    "createJiraIssue",
    "editJiraIssue",
    "addCommentToJiraIssue",
    "getTransitionsForJiraIssue",
    "transitionJiraIssue",
  ],
  confluence: [
    "getConfluenceSpaces",
    "getConfluencePage",
    "createConfluencePage",
    "updateConfluencePage",
    "createConfluenceFooterComment",
  ],
} as const;

/** Which wanted tools the server serves, and which it does not, per group. */
export function coverage(served: readonly string[]): {
  group: keyof typeof WANTED_TOOLS;
  present: string[];
  missing: string[];
}[] {
  const names = new Set(served);
  return (Object.keys(WANTED_TOOLS) as (keyof typeof WANTED_TOOLS)[]).map((group) => ({
    group,
    present: WANTED_TOOLS[group].filter((tool) => names.has(tool)),
    missing: WANTED_TOOLS[group].filter((tool) => !names.has(tool)),
  }));
}

/** The text of an MCP `tools/call` result, and whether the server marked it an error. */
export function toolText(result: unknown): { text: string; isError: boolean } {
  const record = typeof result === "object" && result !== null ? result : {};
  const content = "content" in record ? record.content : undefined;
  const text = Array.isArray(content)
    ? content
        .map((block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string"
            ? block.text
            : "",
        )
        .join("\n")
    : "";
  return { text, isError: "isError" in record && record.isError === true };
}

export interface AtlassianSite {
  id: string;
  url: string;
  scopes: string[];
}

/**
 * The sites in `getAccessibleAtlassianResources`' text: a JSON array of `{ id, url, scopes }`.
 * Anything else gives an empty list, which the probe reports.
 */
export function parseSites(text: string): AtlassianSite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const id = "id" in entry && typeof entry.id === "string" ? entry.id : undefined;
    const url = "url" in entry && typeof entry.url === "string" ? entry.url : "";
    const scopes =
      "scopes" in entry && Array.isArray(entry.scopes)
        ? entry.scopes.filter((scope: unknown): scope is string => typeof scope === "string")
        : [];
    return id === undefined ? [] : [{ id, url, scopes }];
  });
}

/**
 * The id of the Confluence space with the given key, from `getConfluenceSpaces`' text (the
 * Confluence REST shape: `{ results: [{ id, key }] }`). Creating a page takes the id.
 */
export function spaceIdForKey(text: string, key: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const results =
    typeof parsed === "object" && parsed !== null && "results" in parsed ? parsed.results : parsed;
  if (!Array.isArray(results)) return undefined;
  for (const space of results as unknown[]) {
    if (
      typeof space === "object" &&
      space !== null &&
      "key" in space &&
      space.key === key &&
      "id" in space &&
      (typeof space.id === "string" || typeof space.id === "number")
    ) {
      return String(space.id);
    }
  }
  return undefined;
}

/** The first string found under any of the keys, searching nested objects. */
export function findString(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const key of keys) {
    if (key in value) {
      const found = (value as Record<string, unknown>)[key];
      if (typeof found === "string" || typeof found === "number") return String(found);
    }
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Removes the secret from text before it is printed, wherever it appears. */
export function redact(text: string, secret: string): string {
  return secret.length < 8 ? text : text.split(secret).join("[redacted]");
}
