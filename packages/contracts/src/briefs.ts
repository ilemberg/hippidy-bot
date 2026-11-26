import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Daily briefs by direct message (slice 3.4, decision 212). Built from the records with no
// model; one a day at most, and none when there is nothing new.

const timestamp = z.iso.datetime({ offset: true });

/** One line of a brief, and where it leads: a page in the web app or a thread in Slack. */
export const briefLineSchema = z.strictObject({
  text: z.string(),
  href: z.string().nullable(),
});
export type BriefLine = z.infer<typeof briefLineSchema>;

export const briefSectionKindSchema = z.enum([
  "waiting_on_you",
  "to_decide",
  "in_your_areas",
  "your_areas",
  "you_wait_on",
]);
export type BriefSectionKind = z.infer<typeof briefSectionKindSchema>;

/** A section: at most five lines, and how many more there are. */
export const briefSectionSchema = z.strictObject({
  kind: briefSectionKindSchema,
  title: z.string(),
  lines: z.array(briefLineSchema).max(5),
  more: z.number().int().min(0),
});
export type BriefSection = z.infer<typeof briefSectionSchema>;

/** A person's brief: only the sections with something in them; none means nothing to send. */
export const briefSchema = z.strictObject({
  /** What it covers: since the last brief, at most three days back. */
  since: timestamp,
  sections: z.array(briefSectionSchema),
});
export type Brief = z.infer<typeof briefSchema>;

/** Response of `GET /v1/briefs/me`: the signed-in person's brief as it would be now. */
export const myBriefSchema = z.strictObject({
  on: z.boolean(),
  timeZone: z.string().nullable(),
  lastSentAt: timestamp.nullable(),
  brief: briefSchema,
});
export type MyBrief = z.infer<typeof myBriefSchema>;

/** Body of `POST /v1/briefs/me` from a signed-in person: switch their briefs on or off. */
export const setMyBriefsRequestSchema = z.strictObject({ on: z.boolean() });
export type SetMyBriefsRequest = z.infer<typeof setMyBriefsRequestSchema>;

/**
 * Body of `POST /v1/briefs/people` from the service (Slack): a person wrote "stop briefs" or
 * "start briefs" to the bot.
 */
export const setBriefsRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: z.string().min(1).max(255),
  actor: z.strictObject({
    id: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255).optional(),
  }),
  on: z.boolean(),
});
export type SetBriefsRequest = z.infer<typeof setBriefsRequestSchema>;

/** What switching did: whether briefs are on for the person now. */
export const setBriefsResultSchema = z.strictObject({ on: z.boolean() });
export type SetBriefsResult = z.infer<typeof setBriefsResultSchema>;

/** "stop briefs" or "start briefs", each the whole message, any case; otherwise undefined. */
export function briefsCommand(text: string): "on" | "off" | undefined {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (words === "stop briefs") return "off";
  if (words === "start briefs") return "on";
  return undefined;
}
