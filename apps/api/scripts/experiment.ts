// The experiment that opens slice 4 (decision 118). It answers what the docs cannot settle
// before the agent gets the repo (`docs/planning/slice-4.md`, "Experiment first"):
//
//   1. Probes from this runner, with the agent's GitHub token and no agent: what the token
//      can reach (repo, check runs, job logs), that it cannot push a change to
//      `.github/workflows`, and which address of GitHub's MCP server serves the four tools.
//   2. Its own throwaway agent, environment and vault, all named `hippidy-bot-experiment`,
//      with the settings planned for pull request C. Whether an agent update with nothing
//      changed makes a new version.
//   3. One session on a clone of this repo, in three turns: a report on the sandbox (what the
//      agent sees without being told, Node, pnpm, git, the checks); a plain question with an
//      outcome; the demo change with an outcome, ending in a pull request. While the first
//      turn runs, a message is queued to see whether a list of events filtered by time
//      includes it (decision 95).
//   4. Cleanup: the pull request is closed without merging, every `experiment/` branch is
//      deleted, the vault is deleted, and the agent, environment and session are archived
//      (still readable in the Console).
//
//   pnpm agent:experiment                  everything
//   pnpm agent:experiment --probes-only    step 1 only (no Anthropic calls, no cost)
//   pnpm agent:experiment --cleanup-only   step 4 only, for a run that died half way
//
// Needs ANTHROPIC_API_KEY, AGENT_GITHUB_TOKEN and GITHUB_REPOSITORY (owner/name). Run by hand
// from the `release` environment by `.github/workflows/experiment.yml`.
import { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readAgentFile } from "./agent-files.ts";
import {
  MCP_CANDIDATES,
  chooseMcpServers,
  clip,
  describeEvent,
  dollars,
  mcpAgentConfig,
  readJsonRpcResponse,
  type McpServerPlan,
} from "./experiment-lib.ts";

const NAME = "hippidy-bot-experiment";
const BRANCH_PREFIX = "experiment/";
const TURN_LIMIT_MINUTES = 50;
const POLL_SECONDS = 15;

const mode = process.argv.includes("--cleanup-only")
  ? "cleanup"
  : process.argv.includes("--probes-only")
    ? "probes"
    : "full";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const githubToken = required("AGENT_GITHUB_TOKEN");
const repository = required("GITHUB_REPOSITORY");
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const allowedHosts = (process.env.EXPERIMENT_ALLOWED_HOSTS ?? "github.com,nodejs.org")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host !== "");
const budgetUsd = Number(process.env.EXPERIMENT_BUDGET_USD ?? "10");
const anthropic =
  mode === "probes" ? undefined : new Anthropic({ apiKey: required("ANTHROPIC_API_KEY") });

const baseBranch = `${BRANCH_PREFIX}base-${runId}`;
const demoBranch = `${BRANCH_PREFIX}demo-${runId}`;
const codeword = `PERIWINKLE-${runId}`;

// ---------------------------------------------------------------------------------------------
// The report: findings per question, printed at the end and written to the job summary.

const findings: { question: string; finding: string }[] = [];
function found(question: string, finding: string): void {
  findings.push({ question, finding });
  console.log(`\n>> [${question}] ${finding}\n`);
}

function printReport(): void {
  const lines = [
    `## Slice 4 experiment, run ${runId} (${mode})`,
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
// GitHub, with the agent's token.

async function github(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hippidy-bot-experiment",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: response.status, json, headers: response.headers };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** What GitHub says a refused call needed, from its `x-accepted-github-permissions` header. */
function needed(headers: Headers): string {
  const accepted = headers.get("x-accepted-github-permissions");
  return accepted === null ? "" : ` (GitHub accepts: ${accepted})`;
}

/** Runs git with the token as a header, so it never appears in a URL or in the log. */
function git(cwd: string, args: string[]): string {
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  return execFileSync(
    "git",
    [
      "-c",
      `http.https://github.com/.extraheader=Authorization: Basic ${basic}`,
      "-c",
      "user.name=hippidy-bot experiment",
      "-c",
      "user.email=hippidy-bot-experiment@users.noreply.github.com",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function gitError(error: unknown): string {
  const stderr = field(error, "stderr");
  return clip(typeof stderr === "string" ? stderr : String(error), 400);
}

async function probeToken(): Promise<void> {
  const repo = await github("GET", `/repos/${repository}`);
  found(
    "122: token reaches the repo",
    repo.status === 200
      ? `yes; permissions ${JSON.stringify(field(repo.json, "permissions"))}`
      : `no: HTTP ${String(repo.status)}${needed(repo.headers)}`,
  );

  // Only a finished CI job has a log; this run's own job is on main too, still running.
  const checks = await github(
    "GET",
    `/repos/${repository}/commits/main/check-runs?per_page=20&status=completed&check_name=${encodeURIComponent("Lint, typecheck, test")}`,
  );
  const runs = field(checks.json, "check_runs");
  const firstRun = Array.isArray(runs) ? (runs[0] as unknown) : undefined;
  found(
    "116, 122: token reads check runs",
    checks.status === 200
      ? `yes; ${String(field(checks.json, "total_count"))} on main, e.g. "${String(field(firstRun, "name"))}" id ${String(field(firstRun, "id"))}`
      : `no: HTTP ${String(checks.status)}${needed(checks.headers)}`,
  );

  const jobId = field(firstRun, "id");
  if (typeof jobId === "number") {
    const logs = await github("GET", `/repos/${repository}/actions/jobs/${String(jobId)}/logs`);
    // GitHub answers 302 to a short-lived download link, which fetch follows.
    found(
      "116, 122: a check run's id works as a job id for its log",
      logs.status === 200
        ? `yes; ${String(typeof logs.json === "string" ? logs.json.length : 0)} characters of log`
        : `no: HTTP ${String(logs.status)}${needed(logs.headers)}`,
    );
  }
}

/** Pushes the base branch the session checks out: main plus a probe skill (D4). */
function pushBaseAndProbeWorkflows(): void {
  const dir = mkdtempSync(join(tmpdir(), "experiment-"));
  try {
    git(dir, [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      "main",
      `https://github.com/${repository}.git`,
      "repo",
    ]);
    const repo = join(dir, "repo");

    // A change to a workflow must be refused (decision 122).
    const workflowBranch = `${BRANCH_PREFIX}workflow-probe-${runId}`;
    git(repo, ["checkout", "--quiet", "-b", workflowBranch]);
    writeFileSync(
      join(repo, ".github/workflows/experiment-probe.yml"),
      "# Pushed by the slice 4 experiment to check the agent's token cannot change workflows.\n" +
        "name: Experiment probe\non: workflow_dispatch\njobs: {}\n",
    );
    git(repo, ["add", "."]);
    git(repo, [
      "commit",
      "--quiet",
      "-m",
      "Experiment: a workflow change the token should not push",
    ]);
    try {
      git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${workflowBranch}`]);
      found(
        "122: token cannot push a workflow change",
        "**NO: the push was accepted.** The branch is deleted at cleanup. Remove the Workflows permission from the token.",
      );
    } catch (error) {
      found("122: token cannot push a workflow change", `yes, refused: ${gitError(error)}`);
    }

    // The base branch: main plus a skill whose description holds a codeword.
    git(repo, ["checkout", "--quiet", "-B", baseBranch, "origin/main"]);
    const skillDir = join(repo, ".claude/skills/experiment-probe");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: experiment-probe",
        `description: A probe from the slice 4 experiment. If you can see this, the codeword is ${codeword}.`,
        "---",
        "",
        "This skill does nothing. It only shows whether skills in the mounted repo are loaded.",
        "",
      ].join("\n"),
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "Experiment: a probe skill"]);
    try {
      git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/${baseBranch}`]);
      found("122: token pushes an ordinary change with git", `yes (branch ${baseBranch})`);
    } catch (error) {
      found("122: token pushes an ordinary change with git", `no: ${gitError(error)}`);
      throw new Error("Cannot push the base branch; stopping.", { cause: error });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub's MCP server, called directly (Streamable HTTP).

async function mcpCall(
  url: string,
  sessionId: string | undefined,
  id: number | undefined,
  method: string,
  params: unknown,
): Promise<{ result: unknown; sessionId: string | undefined }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(
      id === undefined
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params },
    ),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${clip(body, 200)}`);
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  if (id === undefined) return { result: undefined, sessionId: nextSession };
  return {
    result: readJsonRpcResponse(response.headers.get("content-type") ?? "", body, id),
    sessionId: nextSession,
  };
}

async function listMcpTools(url: string): Promise<string[]> {
  let { sessionId } = await mcpCall(url, undefined, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: NAME, version: "0" },
  });
  ({ sessionId } = await mcpCall(url, sessionId, undefined, "notifications/initialized", {}));
  const names: string[] = [];
  let cursor: string | undefined;
  for (let id = 2; id < 20; id++) {
    const { result } = await mcpCall(
      url,
      sessionId,
      id,
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );
    const tools = field(result, "tools");
    if (Array.isArray(tools))
      names.push(...tools.map((tool: unknown) => String(field(tool, "name"))));
    const next = field(result, "nextCursor");
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  return names;
}

async function probeMcp(): Promise<McpServerPlan[]> {
  const listed = new Map<string, string[]>();
  for (const url of MCP_CANDIDATES) {
    try {
      const names = await listMcpTools(url);
      listed.set(url, names);
      console.log(`MCP ${url}: ${String(names.length)} tools: ${names.join(", ")}`);
    } catch (error) {
      console.log(`MCP ${url}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  found(
    "D11, 116: tools per address",
    MCP_CANDIDATES.map((url) => {
      const names = listed.get(url);
      return `${url}: ${names === undefined ? "failed" : `${String(names.length)} tools`}`;
    }).join("\n"),
  );
  const { servers, missing } = chooseMcpServers(listed);
  found(
    "D11, 116: the address to use",
    `${servers.map((server) => `${server.url} for ${server.tools.join(", ")}`).join("; ")}${
      missing.length > 0 ? `. **Not served anywhere: ${missing.join(", ")}**` : ""
    }`,
  );
  return servers;
}

// ---------------------------------------------------------------------------------------------
// Anthropic: the throwaway agent, environment, vault and session.

function client(): Anthropic {
  if (anthropic === undefined) throw new Error("No Anthropic client in this mode");
  return anthropic;
}

const SYSTEM = `You are hippidy-bot, an AI teammate for a product engineering team. People talk to you in Slack threads; each message starts with a line saying who sent it.

You work in a clone of the hippidy-bot repository, which is your own code. Its project instructions are in CLAUDE.md at the root of the clone: read it before you change anything, and follow it.

When you are asked to change the code:
- Make the change on a new branch from the latest origin/main, never on main.
- Run what CLAUDE.md lists before calling a change done (lint, format check, typecheck, tests) and fix what fails.
- Commit, push the branch and open a pull request against main with the GitHub tools you have. The pull request says what changed and how it was checked.
- Wait for the pull request's checks to finish (read them with pull_request_read, method get_check_runs, every minute or so, for up to about ten minutes). If one fails, read its log with get_job_logs (the check run's id is the job id), fix it and push again.
- End your turn with one short message for the thread: what you did and the pull request's link.

You cannot merge, and you must never push to main.

When you are only asked a question, answer it the way a thoughtful colleague would in Slack: direct, and no longer than the question needs.`;

async function cleanUpAnthropic(): Promise<void> {
  const api = client();
  for await (const session of api.beta.sessions.list()) {
    if (session.title?.startsWith(NAME) === true && session.archived_at === null) {
      await api.beta.sessions.archive(session.id).catch((error: unknown) => {
        console.log(`session ${session.id}: archive failed: ${String(error)}`);
      });
      console.log(`session ${session.id}: archived`);
    }
  }
  for await (const agent of api.beta.agents.list()) {
    if (agent.name === NAME && agent.archived_at === null) {
      await api.beta.agents.archive(agent.id);
      console.log(`agent ${agent.id}: archived`);
    }
  }
  for await (const environment of api.beta.environments.list()) {
    if (environment.name === NAME && environment.archived_at === null) {
      await api.beta.environments.archive(environment.id);
      console.log(`environment ${environment.id}: archived`);
    }
  }
  for await (const vault of api.beta.vaults.list()) {
    if (vault.display_name === NAME && vault.archived_at === null) {
      await api.beta.vaults.delete(vault.id);
      console.log(`vault ${vault.id}: deleted`);
    }
  }
}

async function cleanUpGitHub(): Promise<void> {
  const pulls = await github("GET", `/repos/${repository}/pulls?state=open&per_page=100`);
  if (Array.isArray(pulls.json)) {
    for (const pull of pulls.json as unknown[]) {
      const ref = field(field(pull, "head"), "ref");
      if (typeof ref === "string" && ref.startsWith(BRANCH_PREFIX)) {
        const number = String(field(pull, "number"));
        const closed = await github("PATCH", `/repos/${repository}/pulls/${number}`, {
          state: "closed",
        });
        console.log(`pull request ${number} (${ref}): close -> HTTP ${String(closed.status)}`);
      }
    }
  }
  const refs = await github("GET", `/repos/${repository}/git/matching-refs/heads/${BRANCH_PREFIX}`);
  if (Array.isArray(refs.json)) {
    for (const ref of refs.json as unknown[]) {
      const name = String(field(ref, "ref")).replace(/^refs\//, "");
      const deleted = await github("DELETE", `/repos/${repository}/git/refs/${name}`);
      console.log(`${name}: delete -> HTTP ${String(deleted.status)}`);
    }
  }
}

async function createEverything(
  servers: McpServerPlan[],
): Promise<{ agentId: string; environmentId: string; vaultId: string }> {
  const api = client();
  const production = readAgentFile("agents/hippidy.md");

  const environment = await api.beta.environments.create({
    name: NAME,
    description: "Throwaway environment for the slice 4 experiment.",
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allow_package_managers: true,
        allow_mcp_servers: true,
        allowed_hosts: allowedHosts,
      },
    },
  });
  console.log(
    `environment ${environment.id}: created, allowed hosts ${allowedHosts.join(", ") || "none"}`,
  );

  const vault = await api.beta.vaults.create({ display_name: NAME });
  for (const server of servers) {
    await api.beta.vaults.credentials.create(vault.id, {
      display_name: `${server.name} (GitHub token)`,
      auth: { type: "static_bearer", mcp_server_url: server.url, token: githubToken },
    });
  }
  console.log(`vault ${vault.id}: created with ${String(servers.length)} credential(s)`);

  const { mcp_servers, toolsets } = mcpAgentConfig(servers);
  const body = {
    name: NAME,
    description: "Throwaway agent for the slice 4 experiment.",
    model: production.model,
    system: SYSTEM,
    mcp_servers,
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
        configs: [
          { name: "web_search" as const, enabled: false },
          { name: "web_fetch" as const, enabled: false },
        ],
      },
      ...toolsets,
    ],
  };
  const agent = await api.beta.agents.create(body);
  console.log(
    `agent ${agent.id}: created, version ${String(agent.version)}, model ${production.model}`,
  );

  // Decision 121: does an update with nothing changed make a new version?
  const again = await api.beta.agents.update(agent.id, { ...body, version: agent.version });
  found(
    "121: agent update with nothing changed",
    again.version === agent.version
      ? `no new version (stays ${String(agent.version)}): the sync need not compare first`
      : `**makes a new version** (${String(agent.version)} -> ${String(again.version)}): the sync must keep comparing`,
  );
  found("121: agent tools as Anthropic stores them", clip(JSON.stringify(again.tools), 1500));

  return { agentId: agent.id, environmentId: environment.id, vaultId: vault.id };
}

type Event = BetaManagedAgentsSessionEvent;

async function listEvents(sessionId: string, query: Record<string, string> = {}): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of client().beta.sessions.events.list(sessionId, {
    order: "asc",
    ...query,
  })) {
    events.push(event);
  }
  return events;
}

const printed = new Set<string>();
function printNew(events: readonly Event[]): void {
  for (const event of events) {
    if (printed.has(event.id) || event.type === "span.model_request_start") continue;
    if (event.processed_at === null || event.processed_at === undefined) continue;
    printed.add(event.id);
    console.log(`  ${describeEvent(event as unknown as Parameters<typeof describeEvent>[0])}`);
  }
}

/**
 * Waits until every message sent has been processed and the session is idle after the last
 * of them for a reason other than a tool call waiting. A waiting call is denied (decision 119).
 */
async function waitForTurn(sessionId: string, sent: ReadonlySet<string>): Promise<Event[]> {
  const deadline = Date.now() + TURN_LIMIT_MINUTES * 60_000;
  const denied = new Set<string>();
  while (Date.now() < deadline) {
    await sleep(POLL_SECONDS * 1000);
    const events = await listEvents(sessionId);
    printNew(events);
    const pending = events.some(
      (event) =>
        event.type === "user.message" &&
        sent.has(event.id) &&
        (event.processed_at ?? null) === null,
    );
    const lastStatus = events.findLast((event) => event.type.startsWith("session.status_"));
    if (lastStatus?.type === "session.status_terminated") return events;
    if (pending || lastStatus?.type !== "session.status_idle") continue;
    if (lastStatus.stop_reason.type === "requires_action") {
      const waiting = lastStatus.stop_reason.event_ids.filter((id) => !denied.has(id));
      if (waiting.length > 0) {
        found("119: a tool call waited for approval", `denied ${waiting.join(", ")}`);
        await client().beta.sessions.events.send(sessionId, {
          events: waiting.map((id) => ({
            type: "user.tool_confirmation" as const,
            tool_use_id: id,
            result: "deny" as const,
            deny_message: "Tool calls cannot be approved here. Carry on without it.",
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

interface Usage {
  costUsd: number;
  activeSeconds: number;
}

async function usage(sessionId: string): Promise<Usage> {
  const session = await client().beta.sessions.retrieve(sessionId);
  return {
    costUsd: dollars(session.usage.list_cost?.amount),
    activeSeconds: session.usage.active_seconds ?? 0,
  };
}

/** Sends a turn (with an outcome if given), waits for it and reports its cost and time. */
async function turn(
  sessionId: string,
  label: string,
  text: string,
  outcome?: { description: string; rubric: string },
  whileRunning?: () => Promise<void>,
): Promise<Event[]> {
  console.log(`\n=== Turn: ${label} ===`);
  const before = await usage(sessionId);
  const started = Date.now();
  const sent = await client().beta.sessions.events.send(sessionId, {
    events: [
      ...(outcome === undefined
        ? []
        : [
            {
              type: "user.define_outcome" as const,
              description: outcome.description,
              rubric: { type: "text" as const, content: outcome.rubric },
            },
          ]),
      {
        type: "user.message" as const,
        content: [{ type: "text" as const, text: `From: experiment script\n${text}` }],
      },
    ],
  });
  const sentIds = new Set(
    (sent.data ?? []).filter((event) => event.type === "user.message").map((event) => event.id),
  );
  if (whileRunning !== undefined) {
    await whileRunning();
    for (const id of queuedIds) sentIds.add(id);
  }
  const events = await waitForTurn(sessionId, sentIds);
  const after = await usage(sessionId);
  const minutes = (Date.now() - started) / 60_000;

  const evaluations = events.filter((event) => event.type === "span.outcome_evaluation_end");
  const latest = evaluations.at(-1);
  const graderTokens = evaluations.reduce((sum, event) => {
    const u = field(event, "usage");
    return sum + Number(field(u, "input_tokens") ?? 0) + Number(field(u, "output_tokens") ?? 0);
  }, 0);
  const lastAgentMessage = events.findLast((event) => event.type === "agent.message");
  found(
    `D13: ${label}`,
    `$${(after.costUsd - before.costUsd).toFixed(2)}, ${minutes.toFixed(1)} min wall, ` +
      `${String(Math.round(after.activeSeconds - before.activeSeconds))} s active` +
      (outcome === undefined
        ? ""
        : `; grader: ${String(evaluations.length)} evaluation(s), ${String(graderTokens)} tokens, last verdict ${latest?.type === "span.outcome_evaluation_end" ? latest.result : "none"}`),
  );
  if (lastAgentMessage?.type === "agent.message") {
    const text = lastAgentMessage.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    console.log(`\n--- ${label}: the agent's last message ---\n${text}\n---`);
  }
  return events;
}

/** Message ids sent by the queue probe, added to the turn it runs in. */
const queuedIds: string[] = [];

/** Decision 95: does a list filtered by time include a message still waiting in the queue? */
async function probeQueue(sessionId: string): Promise<void> {
  const api = client();
  // Wait for the turn to be running, so the next message has to wait in the queue.
  for (let i = 0; i < 20; i++) {
    const events = await listEvents(sessionId);
    if (events.some((event) => event.type === "session.status_running")) break;
    await sleep(3000);
  }
  await sleep(10_000);
  const before = await listEvents(sessionId);
  const lastProcessed = before.findLast((event) => (event.processed_at ?? null) !== null);
  const sent = await api.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: "From: experiment script\nThis message only tests the event queue. It needs no answer and no action: carry on with the task above.",
          },
        ],
      },
    ],
  });
  const id = sent.data?.[0]?.id;
  if (id === undefined) {
    found("95: queued message in a filtered list", "inconclusive: the send returned no event id");
    return;
  }
  queuedIds.push(id);
  const all = await listEvents(sessionId);
  const inAll = all.find((event) => event.id === id);
  const since = lastProcessed?.processed_at ?? new Date(Date.now() - 60_000).toISOString();
  const filtered = await listEvents(sessionId, { "created_at[gt]": since });
  const filteredNow = await listEvents(sessionId, { "created_at[gt]": new Date().toISOString() });
  const state =
    inAll === undefined
      ? "absent"
      : inAll.processed_at == null
        ? "queued"
        : `processed at ${inAll.processed_at}`;
  found(
    "95: queued message in a filtered list",
    `right after sending, the full list has it (${state}); filtered by created_at[gt]=${since} (last processed event): ` +
      `${filtered.some((event) => event.id === id) ? "**included**" : "**not included**"} (${String(filtered.length)} events); ` +
      `filtered by created_at[gt]=now: ${filteredNow.some((event) => event.id === id) ? "included" : "not included"} (${String(filteredNow.length)} events)` +
      (state === "queued" ? "" : ". Inconclusive if it was already processed"),
  );
}

async function runSession(ids: {
  agentId: string;
  environmentId: string;
  vaultId: string;
}): Promise<void> {
  const api = client();
  const session = await api.beta.sessions.create({
    agent: ids.agentId,
    environment_id: ids.environmentId,
    vault_ids: [ids.vaultId],
    title: `${NAME} ${runId}`,
    metadata: { experiment: runId },
    budget: {
      type: "limit",
      max_list_cost: { amount: String(Math.round(budgetUsd * 100)), currency: "USD" },
    },
    resources: [
      {
        type: "github_repository",
        url: `https://github.com/${repository}`,
        authorization_token: githubToken,
        checkout: { type: "branch", name: baseBranch },
      },
    ],
  });
  console.log(`session ${session.id}: created (budget $${String(budgetUsd)})`);

  await turn(
    session.id,
    "sandbox report",
    `This is an experiment to learn about your sandbox. Do not change or commit anything in this turn.

1. Before using any tool, answer from what is already in your context: (a) Is the text of a CLAUDE.md file in your context? If so, quote the first sentence after its title. (b) Are any skills listed in your context? If so, give their names and any codeword in their descriptions. (c) List every tool you have, including MCP tools, by exact name.
2. Then find the clone of the repository and report its path, the branch checked out, \`git remote -v\`, \`git config user.name\` and \`git config user.email\` (say if they are empty), and the names (not values) of any proxy-related environment variables.
3. Report \`node --version\`, \`pnpm --version\` (try \`corepack enable\` first if pnpm is missing) and \`git --version\`. The repo needs Node 26. If the Node you have is older, try to get Node 26 (for example from nodejs.org) without root if possible, and report exactly what worked, how long it took, and what did not.
4. Time each of these from the repo root and report pass or fail with the time: \`pnpm install --frozen-lockfile\`, \`pnpm lint\`, \`pnpm format:check\`, \`pnpm typecheck\`, \`pnpm test\`. If one fails, give the first error lines and carry on with the next.

End with a short summary list of the answers.`,
    undefined,
    () => probeQueue(session.id),
  );

  await turn(
    session.id,
    "plain question with an outcome",
    "In two or three sentences: what does apps/api/src/api/conversations.ts do?",
    {
      description: "Answer the question in the latest message.",
      rubric:
        "The message asked a question and did not ask for a change. Satisfied if the answer is two or three sentences, answers the question asked, and is accurate to the repository. No pull request or code change is expected.",
    },
  );

  const demoEvents = await turn(
    session.id,
    "demo change with an outcome",
    `change the 👀 reaction to 🫡

(For this experiment: name the branch exactly \`${demoBranch}\`, start it from origin/main rather than the branch checked out now, and start the pull request's title with "[experiment, do not merge]". The pull request is closed after the experiment.)`,
    {
      description:
        "Make the change asked for in the latest message and deliver it as a pull request against main.",
      rubric: [
        "The message asked for a change to the code. Satisfied only if all of these hold:",
        "- A pull request against main is open with the change, from a branch other than main.",
        "- The change does what was asked and nothing unrelated.",
        "- Lint, format check, typecheck and tests were run in the sandbox and passed.",
        "- All of the pull request's checks have finished and passed (CI is green).",
        "- The pull request's description says what changed and how it was checked.",
        "- The final message gives the pull request's link.",
      ].join("\n"),
    },
  );

  const prCalls = demoEvents.filter(
    (event) => event.type === "agent.mcp_tool_use" && event.name === "create_pull_request",
  );
  const prResults = demoEvents.filter(
    (event) =>
      event.type === "agent.mcp_tool_result" &&
      prCalls.some((call) => call.id === event.mcp_tool_use_id),
  );
  found(
    "Eval view: how a pull request appears in the events",
    prCalls.length === 0
      ? "no create_pull_request call"
      : `agent.mcp_tool_use ${clip(JSON.stringify(prCalls[0]), 600)}\nresult ${clip(JSON.stringify(prResults[0] ?? null), 800)}`,
  );
  const mcpErrors = demoEvents.filter(
    (event) => event.type === "agent.mcp_tool_result" && event.is_error === true,
  );
  if (mcpErrors.length > 0)
    found(
      "D11: MCP tool errors",
      mcpErrors.map((event) => clip(JSON.stringify(event), 300)).join("\n"),
    );
  const sessionErrors = demoEvents.filter((event) => event.type === "session.error");
  if (sessionErrors.length > 0)
    found(
      "Session errors",
      sessionErrors.map((event) => clip(JSON.stringify(event), 300)).join("\n"),
    );

  const total = await usage(session.id);
  found(
    "D13: whole session",
    `$${total.costUsd.toFixed(2)}, ${String(Math.round(total.activeSeconds))} s active`,
  );
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (mode === "cleanup") {
    await cleanUpAnthropic();
    await cleanUpGitHub();
    return;
  }
  await probeToken();
  const servers = await probeMcp();
  if (mode === "probes") return;
  if (servers.length === 0) throw new Error("No MCP address serves the tools; stopping.");

  await cleanUpAnthropic(); // leftovers of an earlier run
  try {
    pushBaseAndProbeWorkflows();
    const ids = await createEverything(servers);
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
