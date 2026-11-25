// The teammate probe: slice 2.1, part A (`docs/planning/slice-2-1.md`). Before the teammate is
// built, it checks that a session in the teammate's planned environment holds rule 1 (it
// cannot publish) and answers G18 (can it read refs other than `main`, which the start rule
// would not see).
//
//   1. A throwaway environment, vault and agent, all named `hippidy-bot-teammate-probe`. The
//      environment allows MCP servers only by default: no package registries, no hosts. The
//      vault holds only Atlassian's credential. The agent has the bash tool and one read-only
//      Atlassian tool.
//   2. One session with the public repository mounted without a token, as product sessions
//      are today (decision 167), and one turn: run a fixed script with bash, then call the
//      Atlassian tool once. The script tries to fetch `main` and other refs, clone another
//      repository, push a branch, reach public hosts and a package registry.
//   3. The report is read from the tool results in the session's events, not from what the
//      agent says, and judged against the plan.
//   4. Cleanup: the session, agent and environment are archived, the vault deleted, and the
//      push branch deleted if the push was (wrongly) accepted.
//
//   pnpm teammate:probe                  everything (one short session, well under $1)
//   pnpm teammate:probe --cleanup-only   step 4 only, for a run that died half way
//
// Needs ANTHROPIC_API_KEY, ATLASSIAN_SERVICE_KEY, AGENT_GITHUB_TOKEN (only to delete a branch a
// wrongly accepted push made) and GITHUB_REPOSITORY (owner/name). Optional:
// PROBE_ALLOWED_HOSTS (comma-separated), PROBE_PACKAGE_MANAGERS ("true" allows registries).
// Run by hand from the `release` environment by `.github/workflows/teammate-probe.yml`.
import { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readAgentFile } from "./agent-files.ts";
import { ATLASSIAN_MCP_URL } from "./atlassian-probe-lib.ts";
import { clip, describeEvent, dollars } from "./experiment-lib.ts";
import { judge, parseProbeOutput, sandboxScript } from "./teammate-probe-lib.ts";

const NAME = "hippidy-bot-teammate-probe";
const BRANCH_PREFIX = "teammate-probe/";
const ATLASSIAN_TOOL = "getAccessibleAtlassianResources";
const TURN_LIMIT_MINUTES = 20;
const POLL_SECONDS = 10;
const BUDGET_CENTS = 200;

const cleanupOnly = process.argv.includes("--cleanup-only");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const anthropic = new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });
const githubToken = required("AGENT_GITHUB_TOKEN");
const repository = required("GITHUB_REPOSITORY");
const atlassianKey = cleanupOnly ? "" : required("ATLASSIAN_SERVICE_KEY");
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const branch = `${BRANCH_PREFIX}${runId}`;
const allowedHosts = (process.env.PROBE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host !== "");
const allowPackageManagers = process.env.PROBE_PACKAGE_MANAGERS === "true";

// ---------------------------------------------------------------------------------------------
// The report, printed at the end and written to the job summary.

const findings: { question: string; finding: string }[] = [];
function found(question: string, finding: string): void {
  findings.push({ question, finding });
  console.log(`\n>> [${question}] ${finding}\n`);
}

function printReport(): void {
  const lines = [
    `## Teammate probe, run ${runId}${cleanupOnly ? " (cleanup only)" : ""}`,
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
// GitHub, from the runner.

/** The sha of `main`, read without a token (the repository is public). */
function mainSha(): string | undefined {
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", `https://github.com/${repository}.git`, "refs/heads/main"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const sha = out.split(/\s/)[0] ?? "";
    return sha === "" ? undefined : sha;
  } catch {
    return undefined;
  }
}

/** Deletes every `teammate-probe/` branch: only a push that should have been refused makes one. */
async function cleanUpGitHub(): Promise<void> {
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": NAME,
  };
  const refs = await fetch(
    `https://api.github.com/repos/${repository}/git/matching-refs/heads/${BRANCH_PREFIX}`,
    { headers },
  );
  const list: unknown = await refs.json();
  if (!Array.isArray(list)) return;
  for (const ref of list as { ref?: unknown }[]) {
    const name = String(ref.ref).replace(/^refs\//, "");
    const deleted = await fetch(`https://api.github.com/repos/${repository}/git/refs/${name}`, {
      method: "DELETE",
      headers,
    });
    console.log(`${name}: delete -> HTTP ${String(deleted.status)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Anthropic: the throwaway environment, vault, agent and session.

async function cleanUpAnthropic(): Promise<void> {
  for await (const session of anthropic.beta.sessions.list()) {
    if (session.title?.startsWith(NAME) === true && session.archived_at === null) {
      await anthropic.beta.sessions.archive(session.id).catch((error: unknown) => {
        console.log(`session ${session.id}: archive failed: ${String(error)}`);
      });
      console.log(`session ${session.id}: archived`);
    }
  }
  for await (const agent of anthropic.beta.agents.list()) {
    if (agent.name === NAME && agent.archived_at === null) {
      await anthropic.beta.agents.archive(agent.id);
      console.log(`agent ${agent.id}: archived`);
    }
  }
  for await (const environment of anthropic.beta.environments.list()) {
    if (environment.name === NAME && environment.archived_at === null) {
      await anthropic.beta.environments.archive(environment.id);
      console.log(`environment ${environment.id}: archived`);
    }
  }
  for await (const vault of anthropic.beta.vaults.list()) {
    if (vault.display_name === NAME && vault.archived_at === null) {
      await anthropic.beta.vaults.delete(vault.id);
      console.log(`vault ${vault.id}: deleted`);
    }
  }
}

const SYSTEM = `You run a technical probe of your own sandbox for the team that builds you. Do exactly what the message asks, in order, with no other tool calls, and do not change or shorten any command you are given.`;

async function createEverything(): Promise<{
  agentId: string;
  environmentId: string;
  vaultId: string;
}> {
  const environment = await anthropic.beta.environments.create({
    name: NAME,
    description: "Throwaway environment for slice 2.1's teammate probe.",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allow_package_managers: allowPackageManagers,
        allow_mcp_servers: true,
        allowed_hosts: allowedHosts,
      },
    },
  });
  found(
    "The environment",
    `package registries ${allowPackageManagers ? "allowed" : "off"}; MCP servers allowed; ` +
      `hosts: ${allowedHosts.join(", ") || "none"}`,
  );

  const vault = await anthropic.beta.vaults.create({ display_name: NAME });
  await anthropic.beta.vaults.credentials.create(vault.id, {
    display_name: "Atlassian (service account key)",
    auth: { type: "static_bearer", mcp_server_url: ATLASSIAN_MCP_URL, token: atlassianKey },
  });

  const agent = await anthropic.beta.agents.create({
    name: NAME,
    description: "Throwaway agent for slice 2.1's teammate probe.",
    model: readAgentFile("agents/product.md").model,
    system: SYSTEM,
    mcp_servers: [{ type: "url", name: "atlassian", url: ATLASSIAN_MCP_URL }],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false, permission_policy: { type: "always_allow" } },
        configs: [{ name: "bash", enabled: true }],
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "atlassian",
        default_config: { enabled: false },
        configs: [
          { name: ATLASSIAN_TOOL, enabled: true, permission_policy: { type: "always_allow" } },
        ],
      },
    ],
  });
  console.log(`environment ${environment.id}, vault ${vault.id}, agent ${agent.id}: created`);
  return { agentId: agent.id, environmentId: environment.id, vaultId: vault.id };
}

type Event = BetaManagedAgentsSessionEvent;

async function listEvents(sessionId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of anthropic.beta.sessions.events.list(sessionId, { order: "asc" })) {
    events.push(event);
  }
  return events;
}

/** Waits for the turn to end. A tool call that waits for approval is denied (decision 119). */
async function waitForTurn(sessionId: string): Promise<Event[]> {
  const deadline = Date.now() + TURN_LIMIT_MINUTES * 60_000;
  const printed = new Set<string>();
  const denied = new Set<string>();
  while (Date.now() < deadline) {
    await sleep(POLL_SECONDS * 1000);
    const events = await listEvents(sessionId);
    for (const event of events) {
      if (printed.has(event.id) || event.type === "span.model_request_start") continue;
      if (event.processed_at === null || event.processed_at === undefined) continue;
      printed.add(event.id);
      console.log(`  ${describeEvent(event as unknown as Parameters<typeof describeEvent>[0])}`);
    }
    const pending = events.some(
      (event) => event.type === "user.message" && (event.processed_at ?? null) === null,
    );
    const lastStatus = events.findLast((event) => event.type.startsWith("session.status_"));
    if (lastStatus?.type === "session.status_terminated") return events;
    if (pending || lastStatus?.type !== "session.status_idle") continue;
    if (lastStatus.stop_reason.type === "requires_action") {
      const waiting = lastStatus.stop_reason.event_ids.filter((id) => !denied.has(id));
      if (waiting.length > 0) {
        await anthropic.beta.sessions.events.send(sessionId, {
          events: waiting.map((id) => ({
            type: "user.tool_confirmation" as const,
            tool_use_id: id,
            result: "deny" as const,
            deny_message: "Tool calls cannot be approved here.",
          })),
        });
        for (const id of waiting) denied.add(id);
      }
      continue;
    }
    return events;
  }
  throw new Error(`The turn did not end within ${String(TURN_LIMIT_MINUTES)} minutes.`);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n");
}

async function runSession(ids: {
  agentId: string;
  environmentId: string;
  vaultId: string;
}): Promise<void> {
  const session = await anthropic.beta.sessions.create({
    agent: ids.agentId,
    environment_id: ids.environmentId,
    vault_ids: [ids.vaultId],
    title: `${NAME} ${runId}`,
    metadata: { probe: runId },
    budget: { type: "limit", max_list_cost: { amount: String(BUDGET_CENTS), currency: "USD" } },
    // Mounted without a token, as product sessions are today (decision 167).
    resources: [{ type: "github_repository", url: `https://github.com/${repository}` }],
  });
  console.log(`session ${session.id}: created`);

  const script = sandboxScript(branch);
  await anthropic.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text:
              "1. Run this command once with your bash tool, exactly as written:\n\n" +
              `\`\`\`bash\n${script}\`\`\`\n\n` +
              `2. Then call the Atlassian tool \`${ATLASSIAN_TOOL}\` once.\n\n` +
              "3. Then reply with the single word: done.",
          },
        ],
      },
    ],
  });
  const events = await waitForTurn(session.id);

  // The bash call, and whether it ran the script as given.
  const bashCall = events.find((event) => event.type === "agent.tool_use" && event.name === "bash");
  const bashInput =
    bashCall?.type === "agent.tool_use" ? (bashCall.input as { command?: unknown }) : undefined;
  found(
    "The script ran as given",
    bashCall === undefined
      ? "**no**: the agent made no bash call"
      : bashInput?.command === script
        ? "yes"
        : `**no, the command differs**: ${clip(String(bashInput?.command), 300)}`,
  );
  const bashResult = events.find(
    (event) => event.type === "agent.tool_result" && event.tool_use_id === bashCall?.id,
  );
  const output = bashResult?.type === "agent.tool_result" ? textOf(bashResult.content) : "";
  const results = parseProbeOutput(output);
  for (const [name, line] of results) found(`Sandbox: ${name}`, `${line.outcome} ${line.detail}`);

  // Rule 1's other half: the MCP connection still works with no hosts allowed.
  const mcpCall = events.find(
    (event) => event.type === "agent.mcp_tool_use" && event.name === ATLASSIAN_TOOL,
  );
  const mcpResult = events.find(
    (event) => event.type === "agent.mcp_tool_result" && event.mcp_tool_use_id === mcpCall?.id,
  );
  found(
    "Atlassian's MCP server works in this environment",
    mcpResult?.type !== "agent.mcp_tool_result"
      ? "**no result**: the tool was not called or did not answer"
      : mcpResult.is_error === true
        ? `**error**: ${clip(textOf(mcpResult.content), 300)}`
        : `yes: ${clip(textOf(mcpResult.content), 200)}`,
  );
  const errors = events.filter((event) => event.type === "session.error");
  if (errors.length > 0)
    found("Session errors", errors.map((event) => clip(JSON.stringify(event), 300)).join("\n"));

  const sha = mainSha();
  const verdict = judge(results, sha);
  found(
    "Rule 1: the session cannot publish",
    verdict.cannotPublish ? "holds" : "**does not hold**",
  );
  found("Reads refs other than main", verdict.readsOtherRefs ? "**yes**" : "no");
  found("G18", verdict.g18);
  found(
    "Against the plan",
    verdict.problems.length === 0
      ? "as planned"
      : verdict.problems.map((p) => `**${p}**`).join("\n"),
  );

  const final = await anthropic.beta.sessions.retrieve(session.id);
  found(
    "Cost",
    `$${dollars(final.usage.list_cost?.amount).toFixed(2)}, ${String(Math.round(final.usage.active_seconds ?? 0))} s active`,
  );
  if (verdict.problems.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (cleanupOnly) {
    await cleanUpAnthropic();
    await cleanUpGitHub();
    return;
  }
  await cleanUpAnthropic(); // leftovers of an earlier run
  try {
    const ids = await createEverything();
    await runSession(ids);
  } finally {
    console.log("\n=== Cleanup ===");
    await cleanUpAnthropic().catch((error: unknown) => {
      console.error(`Anthropic cleanup failed; run with --cleanup-only: ${String(error)}`);
    });
    await cleanUpGitHub().catch((error: unknown) => {
      console.error(`GitHub cleanup failed; run with --cleanup-only: ${String(error)}`);
    });
  }
}

try {
  await main();
} catch (error) {
  found("Run", `**stopped early**: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  printReport();
}
