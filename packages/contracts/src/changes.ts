import { z } from "zod";
import { messageSourceSchema } from "./messages.ts";

// Changes and their briefs (slice 2.1, decisions 181 and 184). A person starts a brief that the
// start rule held back, from the source the brief was posted in.

const id = z.string().min(1).max(255);

/** Body of `POST /v1/briefs/:briefId/start`: who pressed Start, and where. */
export const startBriefRequestSchema = z.strictObject({
  source: messageSourceSchema,
  workspaceId: id,
  actor: z.strictObject({
    id,
    displayName: z.string().min(1).max(255).optional(),
  }),
});
export type StartBriefRequest = z.infer<typeof startBriefRequestSchema>;

/**
 * What a start did. `started`: the worker gets the brief now. `already_started`: someone (or
 * the start rule) started it before. `stopped`: the thread was stopped since. `not_found`: no
 * such brief in that source and workspace.
 */
export const startBriefResultSchema = z.strictObject({
  status: z.enum(["started", "already_started", "stopped", "not_found"]),
});
export type StartBriefResult = z.infer<typeof startBriefResultSchema>;
