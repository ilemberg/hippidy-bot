import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import type {
  Area,
  AreaDetail,
  Conflict,
  ConflictDetail,
  Decision,
  DecisionDetail,
  Goal,
  Job,
  JobDetail,
  MyBrief,
  Task,
  TaskDetail,
  Wait,
} from "@hippidy/contracts";
import type { WebConfig } from "./config.ts";
import { SLACK_TEAM_CLAIM } from "./slack-oidc.ts";

// Test helpers: a stand-in for Slack's signing keys and its id tokens, and a decision, an area,
// a conflict, a task, a wait, a brief and a job as the API returns them. Nothing here reaches the
// network.

export const config: WebConfig = {
  slack: {
    clientId: "1234.5678",
    clientSecret: "s".repeat(32),
    workspaceId: "T0123456789",
    botToken: "xoxb-test-bot-token",
  },
  apiSecret: "a".repeat(48),
  sessionSecret: "b".repeat(48),
  apiBaseUrl: "https://api.example.test",
  webBaseUrl: "https://web.example.test",
};

export interface SlackKeys {
  /** What the web app checks id tokens against, as it would Slack's JWKS. */
  keys: JWTVerifyGetKey;
  privateKey: CryptoKey;
  kid: string;
}

/** A key pair standing in for Slack's, published as a local JWKS. */
export async function slackKeys(kid = "slack-test-key"): Promise<SlackKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { keys: createLocalJWKSet({ keys: [jwk] }), privateKey, kid };
}

export interface IdTokenOptions {
  nonce: string;
  team?: string;
  audience?: string;
  issuer?: string;
  issuedAt?: Date;
  lifetimeSeconds?: number;
  name?: string;
}

/** An id token shaped like Slack's, signed with `key`. */
export function slackIdToken(
  key: Pick<SlackKeys, "privateKey" | "kid">,
  options: IdTokenOptions,
): Promise<string> {
  const issuedAt = Math.floor((options.issuedAt ?? new Date()).getTime() / 1000);
  return new SignJWT({
    nonce: options.nonce,
    name: options.name ?? "Ilya",
    email: "ilya@example.test",
    [SLACK_TEAM_CLAIM]: options.team ?? config.slack.workspaceId,
    "https://slack.com/user_id": "U0123456789",
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setSubject("U0123456789")
    .setIssuer(options.issuer ?? "https://slack.com")
    .setAudience(options.audience ?? config.slack.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 3600))
    .sign(key.privateKey);
}

/** A proposal from a teammate's thread, as the API returns it (slice 2.6). */
export const proposal: Decision = {
  id: "0b6f9c1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e",
  number: 7,
  statement: "Use Postgres for search",
  reason: "It is already there",
  area: "Search",
  status: "proposed",
  decidedBy: { actorId: "U1", name: "Ada" },
  decidedAt: "2026-11-25T10:00:00.000Z",
  origin: "thread",
  originRef: null,
  conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  channelId: "C1",
  threadId: "1700.000100",
  messageId: "1700.000200",
  supersedes: null,
  confirmedBy: null,
  confirmedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  wordingVersion: 1,
};

/** `GET /v1/decisions/7` for a person who may act on it. */
export const proposalDetail: DecisionDetail = {
  decision: proposal,
  history: [],
  youMay: { act: true, reason: null },
};

/** An area owned by Ada, as the API returns it (slice 3.1). */
export const area: Area = {
  id: "3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f",
  name: "search",
  description: "Finding decisions and messages",
  owner: { actorId: "U1", name: "Ada" },
  paths: ["apps/api/src/store/decisions.ts"],
  words: ["full-text", "ranking"],
  version: 2,
  createdBy: { actorId: "U2", name: "Grace" },
  createdAt: "2026-11-25T09:00:00.000Z",
  updatedAt: "2026-11-25T10:00:00.000Z",
};

/** An area's fields, as its history keeps them. */
function fieldsOf(a: Area): AreaDetail["history"][number]["after"] {
  return {
    name: a.name,
    description: a.description,
    owner: a.owner,
    paths: a.paths,
    words: a.words,
  };
}

/** `GET /v1/areas/search`: created by Grace, then given to Ada. */
export const areaDetail: AreaDetail = {
  area,
  history: [
    {
      kind: "created",
      actor: { actorId: "U2", name: "Grace" },
      at: "2026-11-25T09:00:00.000Z",
      before: null,
      after: { ...fieldsOf(area), owner: null },
    },
    {
      kind: "edited",
      actor: { actorId: "U2", name: "Grace" },
      at: "2026-11-25T10:00:00.000Z",
      before: { ...fieldsOf(area), owner: null },
      after: fieldsOf(area),
    },
  ],
};

/** A conflict the teammate raised in a thread, open, decided by Ada (slice 3.2). */
export const conflict: Conflict = {
  id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
  number: 3,
  kind: "raised",
  summary: "Grace and Linus disagree on how search ranks results",
  area: "search",
  decisions: [
    {
      number: 7,
      statement: "Use Postgres for search",
      status: "active",
      decidedBy: { actorId: "U2", name: "Grace" },
    },
  ],
  proposal: null,
  positions: [
    { actorId: "U2", name: "Grace", says: "Keep Postgres full-text search" },
    { actorId: "U3", name: "Linus", says: "Move to a vector index" },
  ],
  deciders: [{ actorId: "U1", name: "Ada" }],
  status: "open",
  outcome: null,
  note: null,
  settledBy: null,
  settledAt: null,
  conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  channelId: "C1",
  threadId: "1700.000100",
  createdAt: "2026-11-25T11:00:00.000Z",
};

/** `GET /v1/conflicts/3` for one of its deciders. */
export const conflictDetail: ConflictDetail = {
  conflict,
  youMay: { settle: true, reason: null },
};

/** A built-in task Grace is doing, created by Ada (slice 3.3). */
export const task: Task = {
  key: "T-4",
  title: "Rank search results by recency",
  status: "doing",
  statusName: "Doing",
  assignee: { actorId: "U2", name: "Grace" },
  url: null,
  updatedAt: "2026-11-25T10:00:00.000Z",
};

/** The same task in Jira's `SCRUM` project. */
export const jiraTask: Task = {
  key: "SCRUM-8",
  title: "Rank search results by recency",
  status: "doing",
  statusName: "In Progress",
  assignee: { actorId: null, name: "Grace Hopper" },
  url: "https://example.atlassian.net/browse/SCRUM-8",
  updatedAt: "2026-11-25T10:00:00.000Z",
};

/** Grace waiting on Ada for a review, said in a thread, about T-4. */
export const wait: Wait = {
  id: "7e6d5c4b-3a29-4f18-8e7d-6c5b4a392817",
  number: 2,
  waiter: { actorId: "U2", name: "Grace" },
  waitingOn: { actorId: "U1", name: "Ada" },
  what: "review the ranking",
  taskKey: "T-4",
  since: "2026-11-23T12:00:00.000Z",
  conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  channelId: "C1",
  threadId: "1700.000100",
  recordedBy: { actorId: "B1", name: "hippidy-bot" },
  status: "open",
  endedBy: null,
  endedAt: null,
};

/** `GET /v1/tasks/T-4`: created by Ada, then given to Grace and started, worked on in a thread. */
export const taskDetail: TaskDetail = {
  provider: "builtin",
  task,
  builtin: {
    id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
    description: "Newer decisions first when the words match equally",
    version: 2,
    createdBy: { actorId: "U1", name: "Ada" },
    createdAt: "2026-11-25T09:00:00.000Z",
    history: [
      {
        kind: "created",
        actor: { actorId: "U1", name: "Ada" },
        at: "2026-11-25T09:00:00.000Z",
        before: null,
        after: {
          title: task.title,
          description: "Newer decisions first when the words match equally",
          status: "todo",
          assignee: null,
        },
      },
      {
        kind: "edited",
        actor: { actorId: "U1", name: "Ada" },
        at: "2026-11-25T10:00:00.000Z",
        before: {
          title: task.title,
          description: "Newer decisions first when the words match equally",
          status: "todo",
          assignee: null,
        },
        after: {
          title: task.title,
          description: "Newer decisions first when the words match equally",
          status: "doing",
          assignee: { actorId: "U2", name: "Grace" },
        },
      },
    ],
  },
  threads: [
    {
      conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
      channelId: "C1",
      threadId: "1700.000100",
      linkedAt: "2026-11-25T11:00:00.000Z",
    },
  ],
  waits: [wait],
};

/** `GET /v1/briefs/me` for Ada: on, in her time zone, with what waits on her and her areas. */
export const myBrief: MyBrief = {
  on: true,
  timeZone: "Europe/London",
  lastSentAt: "2026-11-24T09:05:00.000Z",
  brief: {
    since: "2026-11-24T09:05:00.000Z",
    sections: [
      {
        kind: "waiting_on_you",
        title: "Waiting on you",
        lines: [
          {
            text: "Grace, for review the ranking (2 days)",
            href: "https://slack.com/archives/C1/p1700000100",
          },
        ],
        more: 0,
      },
      {
        kind: "in_your_areas",
        title: "In your areas",
        lines: [
          {
            text: "#7 proposed in search: Use Postgres for search",
            href: `${config.webBaseUrl}/decisions/7`,
          },
          { text: "#8 recorded in search: Rank by recency", href: "/decisions/8" },
          { text: "A pull request touched search", href: null },
        ],
        more: 4,
      },
    ],
  },
};

/** The capture job, active, $12.34 of its $40.00 spent this month (slices 4.1 and 4.2). */
export const job: Job = {
  id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d",
  name: "capture",
  kind: "capture",
  goal: "Propose decisions from quiet threads",
  owner: { actorId: "U1", name: "Ada" },
  everyMinutes: 1,
  state: "active",
  capCents: 4000,
  spentMicrosThisMonth: 12_340_000,
  lastWakeAt: "2026-11-25T11:58:00.000Z",
  version: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
};

/** The briefs job: paused by a person, nothing spent, never woken. */
export const briefsJob: Job = {
  ...job,
  id: "8f7e6d5c-4b3a-4291-8f7e-6d5c4b3a2918",
  name: "briefs",
  kind: "briefs",
  goal: null,
  owner: null,
  state: "paused",
  capCents: 100,
  spentMicrosThisMonth: 0,
  lastWakeAt: null,
  version: 1,
};

/** `GET /v1/jobs/capture`: two wakes, newest first, and Ada raising its cap from $30 to $40. */
export const jobDetail: JobDetail = {
  job,
  goal: null,
  wakes: [
    {
      startedAt: "2026-11-25T11:58:00.000Z",
      endedAt: "2026-11-25T11:58:04.000Z",
      outcome: "silent",
      summary: "No quiet thread to read",
      costMicros: 0,
      error: null,
    },
    {
      startedAt: "2026-11-25T11:57:00.000Z",
      endedAt: "2026-11-25T11:57:30.000Z",
      outcome: "said",
      summary: "Proposed decision #8",
      costMicros: 42_500,
      error: null,
    },
  ],
  history: [
    {
      actor: { actorId: "U1", name: "Ada" },
      at: "2026-11-25T10:00:00.000Z",
      before: { state: "active", capCents: 3000, everyMinutes: 1, goal: job.goal },
      after: { state: "active", capCents: 4000, everyMinutes: 1, goal: job.goal },
    },
  ],
};

/** The export goal's job: Grace's, every 10 minutes, $10 a month (slice 4.4). */
export const goalJob: Job = {
  ...job,
  id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
  name: "export",
  kind: "goal",
  goal: "Let people export their data.",
  owner: { actorId: "U1", name: "Grace" },
  everyMinutes: 10,
  capCents: 1000,
  spentMicrosThisMonth: 80_000,
  version: 2,
};

/** Its thread and tickets: T-4 merged, T-5 briefed and started, T-6 and T-7 not yet. */
export const goal: Goal = {
  conversationId: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  channelId: "C123ABC",
  threadId: "1700000000.000200",
  limit: 2,
  open: 1,
  provider: "builtin",
  tickets: [
    {
      key: "T-4",
      title: "Export button",
      url: null,
      state: "merged",
      change: {
        id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        status: "started",
        pullRequestUrl: "https://github.com/ilemberg/hippidy-bot/pull/12",
      },
      failures: 0,
      settledAt: "2026-11-26T10:00:00.000Z",
    },
    {
      key: "T-5",
      title: "Export as CSV",
      url: null,
      state: "briefed",
      change: {
        id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
        status: "started",
        pullRequestUrl: null,
      },
      failures: 0,
      settledAt: null,
    },
    {
      key: "T-6",
      title: "Export as PDF",
      url: null,
      state: "pending",
      change: null,
      failures: 2,
      settledAt: null,
    },
    {
      key: "T-7",
      title: "Export history",
      url: null,
      state: "pending",
      change: null,
      failures: 0,
      settledAt: null,
    },
  ],
};

/** `GET /v1/jobs/export`: the goal, made by Grace. */
export const goalDetail: JobDetail = {
  job: goalJob,
  goal,
  wakes: [],
  history: [
    {
      actor: { actorId: "U1", name: "Grace" },
      at: "2026-11-26T09:00:00.000Z",
      before: {},
      after: { goal: goalJob.goal, tickets: ["T-4", "T-5", "T-6"], limit: 2 },
    },
    {
      actor: { actorId: "U2", name: "Ada" },
      at: "2026-11-26T09:30:00.000Z",
      before: { tickets: ["T-4", "T-5", "T-6"], limit: 2 },
      after: { tickets: ["T-4", "T-5", "T-6", "T-7"], limit: 3 },
    },
  ],
};
