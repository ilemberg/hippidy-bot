import { z } from "zod";
import type { Env } from "../config.ts";
import type { Logger } from "../log.ts";

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

const slackConfigSchema = z.object({
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-\S+$/, "must be a bot token (xoxb-...)"),
  SLACK_SIGNING_SECRET: z.string().regex(/^\S{16,}$/, "must be at least 16 characters"),
});

/**
 * Reads only what the Slack adapter needs. Never throws: returns undefined (and logs which
 * variables are wrong, never their values) so the rest of the app keeps running.
 */
export function readSlackConfig(env: Env, log: Logger): SlackConfig | undefined {
  const parsed = slackConfigSchema.safeParse({
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  });
  if (!parsed.success) {
    log.warn("config.slack_not_configured", {
      problems: parsed.error.issues.map((issue) => ({
        variable: issue.path.join("."),
        message: issue.message,
      })),
    });
    return undefined;
  }
  return {
    botToken: parsed.data.SLACK_BOT_TOKEN,
    signingSecret: parsed.data.SLACK_SIGNING_SECRET,
  };
}
