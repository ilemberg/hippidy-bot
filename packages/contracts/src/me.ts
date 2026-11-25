import { z } from "zod";

// Who is calling the API (slice 2.3, decisions 193 and 194). A client is either a service
// (the Slack adapter, with the service token) or a person signed in to the web app, whose
// server calls the API with a short-lived person token it signs.

/** The `aud` of a person token: only the API accepts it. */
export const PERSON_TOKEN_AUDIENCE = "hippidy-api";
/** The `iss` of a person token: only the web app's server signs one. */
export const PERSON_TOKEN_ISSUER = "hippidy-web";
/** The longest a person token may live, from `iat` to `exp`, in seconds. */
export const PERSON_TOKEN_MAX_AGE_SECONDS = 5 * 60;

const id = z.string().min(1).max(255);

/**
 * The claims of a person token (an HS256 JWT signed with `WEB_API_SECRET`) besides the
 * registered ones (`aud`, `iss`, `iat`, `exp`), which the signature check covers.
 */
export const personTokenClaimsSchema = z.object({
  /** The person's id in the source system (Slack: user id). */
  sub: id,
  /** The workspace they signed in to (Slack: team id). */
  team: id,
  /** How they are called, as the source said at sign-in. */
  name: z.string().min(1).max(255),
});
export type PersonTokenClaims = z.infer<typeof personTokenClaimsSchema>;

/** Response body of `GET /v1/me`: who the API took the caller to be. */
export const meResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("person"),
    workspaceId: id,
    actorId: id,
    name: z.string().min(1).max(255),
  }),
  z.strictObject({ kind: z.literal("service") }),
]);
export type MeResponse = z.infer<typeof meResponseSchema>;
