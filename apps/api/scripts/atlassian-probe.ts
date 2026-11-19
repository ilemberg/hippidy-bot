// The Atlassian probe (decisions 151 and 159): before Jira and Confluence are chosen for the
// project workflow (E1), check from a runner, with no agent and no cost, that Atlassian's MCP
// server accepts a service account key as a bearer token, the only kind of credential the
// agent's vault holds (`static_bearer`, decision 122), and what it can do with it.
//
//   1. Connect to the server with `Authorization: Bearer <key>` and list its tools.
//   2. Who the key is (`atlassianUserInfo`) and which sites and scopes it reaches
//      (`getAccessibleAtlassianResources`).
//   3. Read Jira (projects, one issue search) and Confluence (spaces).
//   4. With --writes: create one Jira issue and one Confluence page, both marked as made by
//      the probe, and comment on each. Atlassian's server has no tool that deletes, so they
//      stay; delete them by hand.
//
//   pnpm atlassian:probe            steps 1 to 3
//   pnpm atlassian:probe --writes   steps 1 to 4 (needs ATLASSIAN_PROBE_PROJECT and _SPACE)
//
// Needs ATLASSIAN_SERVICE_KEY. Optional: ATLASSIAN_SITE (the site's address, when the key
// reaches more than one), ATLASSIAN_MCP_URL, ATLASSIAN_PROBE_PROJECT (a Jira project key) and
// ATLASSIAN_PROBE_SPACE (a Confluence space key). Run by hand from the `release` environment
// by `.github/workflows/atlassian-probe.yml`. The key is never printed.
import { appendFileSync } from "node:fs";
import {
  ATLASSIAN_MCP_URL,
  coverage,
  findString,
  parseSites,
  redact,
  spaceIdForKey,
  toolText,
  type AtlassianSite,
} from "./atlassian-probe-lib.ts";
import { clip, readJsonRpcResponse } from "./experiment-lib.ts";

const NAME = "hippidy-bot-atlassian-probe";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const key = required("ATLASSIAN_SERVICE_KEY");
const url = optional("ATLASSIAN_MCP_URL") ?? ATLASSIAN_MCP_URL;
const siteWanted = optional("ATLASSIAN_SITE");
const projectKey = optional("ATLASSIAN_PROBE_PROJECT");
const spaceKey = optional("ATLASSIAN_PROBE_SPACE");
const writes = process.argv.includes("--writes");
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());

// ---------------------------------------------------------------------------------------------
// The report: findings per question, printed at the end and written to the job summary.

const findings: { question: string; finding: string }[] = [];
function found(question: string, finding: string): void {
  const safe = redact(finding, key);
  findings.push({ question, finding: safe });
  console.log(`\n>> [${question}] ${safe}\n`);
}

function printReport(): void {
  const lines = [
    `## Atlassian probe, run ${runId}${writes ? " (with writes)" : ""}`,
    "",
    `Server: \`${url}\``,
    "",
    "| Question | Finding |",
    "|---|---|",
    ...findings.map(
      ({ question, finding }) =>
        `| ${question} | ${finding.replace(/\|/g, "\\|").replace(/\n/g, "<br>")} |`,
    ),
    "",
  ];
  console.log(`\n${lines.join("\n")}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") appendFileSync(summary, lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------
// The MCP server, called directly (Streamable HTTP), as the agent's vault would: a bearer key.

let sessionId: string | undefined;
let nextId = 1;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rpc(method: string, params: unknown, notify = false): Promise<unknown> {
  const id = notify ? undefined : nextId++;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      "User-Agent": NAME,
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(
      id === undefined
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params },
    ),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) {
    const challenge = response.headers.get("www-authenticate");
    throw new HttpError(
      response.status,
      `HTTP ${String(response.status)}${challenge === null ? "" : ` (WWW-Authenticate: ${clip(challenge, 200)})`}: ${clip(redact(body, key), 300)}`,
    );
  }
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (id === undefined) return undefined;
  return readJsonRpcResponse(response.headers.get("content-type") ?? "", body, id);
}

interface Tool {
  name: string;
  required: string[];
}

async function listTools(): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await rpc("tools/list", cursor === undefined ? {} : { cursor });
    const record = typeof result === "object" && result !== null ? result : {};
    const list = "tools" in record && Array.isArray(record.tools) ? record.tools : [];
    for (const tool of list as unknown[]) {
      if (typeof tool !== "object" || tool === null || !("name" in tool)) continue;
      const schema = "inputSchema" in tool ? tool.inputSchema : undefined;
      const required =
        typeof schema === "object" &&
        schema !== null &&
        "required" in schema &&
        Array.isArray(schema.required)
          ? schema.required.map(String)
          : [];
      tools.push({ name: String(tool.name), required });
    }
    const next = "nextCursor" in record ? record.nextCursor : undefined;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  return tools;
}

let tools: Tool[] = [];

/** Calls a tool and reports the outcome; returns the text, or undefined when it failed. */
async function call(
  question: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    found(question, `not served: the server has no tool \`${name}\``);
    return undefined;
  }
  const missing = tool.required.filter((field) => !(field in args));
  try {
    const result = toolText(await rpc("tools/call", { name, arguments: args }));
    const text = redact(result.text, key);
    const isError = result.isError;
    if (isError) {
      found(
        question,
        `\`${name}\` returned an error${missing.length > 0 ? ` (it requires ${missing.join(", ")}, not given)` : ""}: ${clip(text, 400)}`,
      );
      return undefined;
    }
    found(question, `yes: \`${name}\` returned ${clip(text, 400)}`);
    return text;
  } catch (error) {
    found(question, `\`${name}\` failed: ${describeError(error)}`);
    return undefined;
  }
}

/** An error's message and, for a failed fetch, its cause (the DNS or TLS error). */
function describeError(error: unknown): string {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return clip(redact(`${String(error)}${cause}`, key), 500);
}

function json(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Does the server take the key as a bearer token at all?
  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: NAME, version: "0" },
    });
    await rpc("notifications/initialized", {}, true);
    found(
      "Bearer key accepted",
      `yes, so far: initialize answered; the rows below show whether calls work too (server ${clip(JSON.stringify(findString(init, ["name"]) ?? "unnamed"), 80)})`,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      found(
        "Bearer key accepted",
        `no${error.status === 401 || error.status === 403 ? " (refused)" : ""}: ${clip(error.message, 500)}`,
      );
    } else if (error instanceof Error && error.message.startsWith("JSON-RPC error")) {
      found(
        "Bearer key accepted",
        `no (the server answered with an error): ${describeError(error)}`,
      );
    } else {
      found("Bearer key accepted", `unknown: could not reach the server: ${describeError(error)}`);
    }
    return;
  }

  try {
    tools = await listTools();
    found(
      "Tools served",
      `${String(tools.length)}: ${tools.map((tool) => tool.name).join(", ") || "none"}`,
    );
  } catch (error) {
    found("Tools served", `tools/list failed: ${describeError(error)}`);
    return;
  }
  for (const { group, present, missing } of coverage(tools.map((tool) => tool.name))) {
    found(
      `Wanted tools: ${group}`,
      `${present.length > 0 ? `served: ${present.join(", ")}` : "none served"}${missing.length > 0 ? `; not served: ${missing.join(", ")}` : ""}`,
    );
  }

  // 2. Who the key is, and where it reaches.
  await call("Identity", "atlassianUserInfo", {});
  const sites: AtlassianSite[] = parseSites(
    (await call("Sites and scopes", "getAccessibleAtlassianResources", {})) ?? "",
  );
  const wanted =
    siteWanted === undefined
      ? undefined
      : sites.find((candidate) => candidate.url.includes(siteWanted));
  if (siteWanted !== undefined && wanted === undefined && sites.length > 0) {
    found("Site wanted", `${siteWanted} is not among the sites the key reaches; using the first`);
  }
  const site = wanted ?? sites[0];
  const cloudId = site?.id ?? siteWanted;
  if (site !== undefined) {
    found(
      "Site used",
      `${site.url} (${String(sites.length)} reachable); scopes: ${site.scopes.join(", ") || "none listed"}`,
    );
  } else if (cloudId === undefined) {
    found("Site used", "none: no site was listed and ATLASSIAN_SITE is not set; reads skipped");
    return;
  } else {
    found("Site used", `none listed; trying ATLASSIAN_SITE (${cloudId}) as the cloud id`);
  }

  // 3. Reads.
  await call("Jira: read projects", "getVisibleJiraProjects", { cloudId });
  await call("Jira: search issues", "searchJiraIssuesUsingJql", {
    cloudId,
    // Jira Cloud's search rejects a query with no restriction ("unbounded").
    jql: "created >= -3650d ORDER BY created DESC",
    maxResults: 1,
  });
  const spacesText = await call("Confluence: read spaces", "getConfluenceSpaces", { cloudId });

  if (!writes) {
    found("Writes", "not tried (run with writes to create one issue and one page)");
    return;
  }

  // 4. Writes, each marked as the probe's.
  const stamp = `Made by the hippidy-bot Atlassian probe, run ${runId}. Safe to delete.`;
  if (projectKey === undefined) {
    found("Jira: write", "not tried: ATLASSIAN_PROBE_PROJECT is not set");
  } else {
    const issueText = await call("Jira: create an issue", "createJiraIssue", {
      cloudId,
      projectKey,
      issueTypeName: "Task",
      summary: `hippidy-bot probe ${runId}`,
      description: stamp,
    });
    const issueKey = findString(json(issueText), ["key"]);
    if (issueText !== undefined && issueKey === undefined) {
      found("Jira: comment on it", "not tried: no issue key found in the create result");
    } else if (issueKey !== undefined) {
      await call("Jira: comment on it", "addCommentToJiraIssue", {
        cloudId,
        issueIdOrKey: issueKey,
        commentBody: `Comment by the probe, run ${runId}.`,
      });
    }
  }
  if (spaceKey === undefined) {
    found("Confluence: write", "not tried: ATLASSIAN_PROBE_SPACE is not set");
  } else {
    // The read above returns one page of spaces; on a larger site, ask for this one by key.
    const spaceId =
      spaceIdForKey(spacesText ?? "", spaceKey) ??
      spaceIdForKey(
        (await call("Confluence: find the space by key", "getConfluenceSpaces", {
          cloudId,
          keys: [spaceKey],
        })) ?? "",
        spaceKey,
      );
    if (spaceId === undefined) {
      found("Confluence: write", `not tried: no space with key ${spaceKey} in the spaces read`);
      return;
    }
    const pageText = await call("Confluence: create a page", "createConfluencePage", {
      cloudId,
      spaceId,
      title: `hippidy-bot probe ${runId}`,
      body: stamp,
    });
    const pageId = findString(json(pageText), ["id"]);
    if (pageText !== undefined && pageId === undefined) {
      found("Confluence: comment on it", "not tried: no page id found in the create result");
    } else if (pageId !== undefined) {
      await call("Confluence: comment on it", "createConfluenceFooterComment", {
        cloudId,
        pageId,
        body: `Comment by the probe, run ${runId}.`,
      });
    }
  }
}

try {
  await main();
} catch (error) {
  found("Probe", `stopped: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  printReport();
}
