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
} from "@hippidy/contracts";
import type { WebConfig } from "./config.ts";
import { SLACK_TEAM_CLAIM } from "./slack-oidc.ts";

// Test helpers: a stand-in for Slack's signing keys and its id tokens, and a decision, an area
// and a conflict as the API returns them. Nothing here reaches the network.

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
