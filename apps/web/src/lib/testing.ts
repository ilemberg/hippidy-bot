import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import type { WebConfig } from "./config.ts";
import { SLACK_TEAM_CLAIM } from "./slack-oidc.ts";

// Test helpers: a stand-in for Slack's signing keys and its id tokens. Nothing here reaches
// the network.

export const config: WebConfig = {
  slack: { clientId: "1234.5678", clientSecret: "s".repeat(32), workspaceId: "T0123456789" },
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
