import { z } from "zod";
import { approvalActionSchema, approvalSubjectSchema, projectStageSchema } from "./projects.ts";

// The custom tools the API answers for an agent (slice 5A, part E; decision 167). The agent
// calls one, its session waits, and the conversation loop answers with the tool's result. The
// inputs come from the model, so they are checked like any other request body.

const uuid = z.guid();
const noNull = (value: string) => !value.includes("\u0000");
const noNullMessage = { message: "Must not contain a null character" };

/** The names of the custom tools the API answers. */
export const customToolNameSchema = z.enum(["link_project", "record_approval"]);
export type CustomToolName = z.infer<typeof customToolNameSchema>;

/**
 * Input of `link_project`: ties the thread to a project, either one that exists (`projectId`)
 * or a new one in the `plan` stage (`name`). Exactly one of the two.
 */
export const linkProjectInputSchema = z
  .strictObject({
    projectId: uuid.optional(),
    name: z.string().trim().min(1).max(200).refine(noNull, noNullMessage).optional(),
  })
  .refine((input) => (input.projectId === undefined) !== (input.name === undefined), {
    message: "Give exactly one of projectId and name",
  });
export type LinkProjectInput = z.infer<typeof linkProjectInputSchema>;

/** Result of `link_project`: the project the thread is now linked to. */
export const linkProjectOutputSchema = z.strictObject({
  projectId: uuid,
  name: z.string(),
  stage: projectStageSchema,
});
export type LinkProjectOutput = z.infer<typeof linkProjectOutputSchema>;

/**
 * Input of `record_approval`: an approval or withdrawal given in the thread, for the thread's
 * project. The person is named by their user id in the thread's own source and workspace (a
 * Slack user id). A ticket approval must name its ticket.
 */
export const recordApprovalInputSchema = z
  .strictObject({
    subject: approvalSubjectSchema,
    subjectRef: z.string().trim().max(2000).refine(noNull, noNullMessage).default(""),
    subjectVersion: z.string().trim().max(255).refine(noNull, noNullMessage).default(""),
    action: approvalActionSchema,
    actor: z.strictObject({
      actorId: z.string().trim().min(1).max(255).refine(noNull, noNullMessage),
    }),
  })
  .refine((input) => input.subject !== "ticket" || input.subjectRef !== "", {
    message: "A ticket approval must name its ticket",
    path: ["subjectRef"],
  });
export type RecordApprovalInput = z.infer<typeof recordApprovalInputSchema>;

/** Result of `record_approval`. */
export const recordApprovalOutputSchema = z.strictObject({
  approvalId: uuid,
  /** Whether the subject is approved now, after this record (as `subjectApproved` on the API). */
  subjectApproved: z.boolean(),
});
export type RecordApprovalOutput = z.infer<typeof recordApprovalOutputSchema>;
