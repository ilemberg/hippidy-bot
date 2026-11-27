import { z } from "zod";

// The team's scorecard (slice 4.5, decision 223): what the records say the team did this week
// against last week, from the records alone. The team's, never per person.

const timestamp = z.iso.datetime({ offset: true });

/** What is counted, each from a record with a time. */
export const scorecardCountKindSchema = z.enum([
  "decisions_made",
  "conflicts_settled",
  "waits_ended",
  "changes_started",
  "pull_requests_reviewed",
  "tickets_merged",
]);
export type ScorecardCountKind = z.infer<typeof scorecardCountKindSchema>;

/** One count, this week and last. */
export const scorecardCountSchema = z.strictObject({
  kind: scorecardCountKindSchema,
  thisWeek: z.number().int().min(0),
  lastWeek: z.number().int().min(0),
});
export type ScorecardCount = z.infer<typeof scorecardCountSchema>;

/**
 * Response of `GET /v1/scorecard`. Weeks are Monday to Sunday in UTC: this week runs from
 * `thisWeekStart` (a Monday, 00:00 UTC) to `readAt`, last week from `lastWeekStart` to
 * `thisWeekStart`. Every kind is there, in the order of `scorecardCountKindSchema`.
 */
export const scorecardSchema = z.strictObject({
  lastWeekStart: timestamp,
  thisWeekStart: timestamp,
  readAt: timestamp,
  counts: z.array(scorecardCountSchema),
});
export type Scorecard = z.infer<typeof scorecardSchema>;
