import { z } from "zod";
import type { Logger } from "./log.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Everything sign-in and the calls to the API need. All of it, or sign-in stays off. */
export interface WebConfig {
  slack: {
    clientId: string;
    clientSecret: string;
    /** The one workspace whose members may sign in (Slack team id). */
    workspaceId: string;
    /** The bot's token, to ask Slack whether a person is a full member, not a guest. */
    botToken: string;
  };
  /** Signs the person tokens the API accepts. Shared with the API only. */
  apiSecret: string;
  /** Signs the session and sign-in cookies. Known to the web app only. */
  sessionSecret: string;
  /** The API's origin, for example `https://hippidy-bot.vercel.app`. */
  apiBaseUrl: string;
  /** This app's origin; Slack sends people back to `<it>/auth/slack/callback`. */
  webBaseUrl: string;
}

export const MIN_SECRET_LENGTH = 32;

const secret = z
  .string()
  .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`)
  .regex(/^\S+$/, "must not contain whitespace");

/** An origin over https; plain http only on this machine, for local development. */
const origin = z
  .url({ protocol: /^https?$/ })
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1",
    "must use https (http only for localhost)",
  )
  .refine((url) => url.pathname === "/" && url.search === "", "must be an origin, with no path")
  .transform((url) => url.origin);

const webConfigSchema = z.object({
  SLACK_CLIENT_ID: z.string().regex(/^\d+\.\d+$/, "must be a Slack client id, like 123.456"),
  SLACK_CLIENT_SECRET: z.string().regex(/^\S{16,}$/, "must be at least 16 characters"),
  // A workspace's team id (`T…`): the id token's team claim is never an Enterprise Grid id.
  SLACK_WORKSPACE_ID: z.string().regex(/^T[A-Z0-9]{2,30}$/, "must be a Slack team id (T…)"),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-\S+$/, "must be a Slack bot token (xoxb-…)"),
  WEB_API_SECRET: secret,
  WEB_SESSION_SECRET: secret,
  API_BASE_URL: origin,
  WEB_BASE_URL: origin,
});

/**
 * Reads the web app's configuration. Never throws: a missing or bad variable is logged (its
 * name and what is wrong, never its value) and sign-in stays off, so the page still renders.
 */
export function readWebConfig(env: Env, log: Logger): WebConfig | undefined {
  const parsed = webConfigSchema.safeParse({
    SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
    SLACK_WORKSPACE_ID: env.SLACK_WORKSPACE_ID,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    WEB_API_SECRET: env.WEB_API_SECRET,
    WEB_SESSION_SECRET: env.WEB_SESSION_SECRET,
    API_BASE_URL: env.API_BASE_URL,
    WEB_BASE_URL: env.WEB_BASE_URL,
  });
  if (!parsed.success) {
    log.warn("config.web_not_configured", {
      problems: parsed.error.issues.map((issue) => ({
        variable: issue.path.join("."),
        message: issue.message,
      })),
    });
    return undefined;
  }
  const data = parsed.data;
  if (data.WEB_API_SECRET === data.WEB_SESSION_SECRET) {
    log.error("config.web_not_configured", {
      problems: [{ variable: "WEB_SESSION_SECRET", message: "must differ from WEB_API_SECRET" }],
    });
    return undefined;
  }
  return {
    slack: {
      clientId: data.SLACK_CLIENT_ID,
      clientSecret: data.SLACK_CLIENT_SECRET,
      workspaceId: data.SLACK_WORKSPACE_ID,
      botToken: data.SLACK_BOT_TOKEN,
    },
    apiSecret: data.WEB_API_SECRET,
    sessionSecret: data.WEB_SESSION_SECRET,
    apiBaseUrl: data.API_BASE_URL,
    webBaseUrl: data.WEB_BASE_URL,
  };
}
