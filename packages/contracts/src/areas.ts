import { z } from "zod";

// Areas, owners and the people the record knows (slice 3.1, decisions 205 and 206).

const timestamp = z.iso.datetime({ offset: true });
const person = z.strictObject({ actorId: z.string(), name: z.string().nullable() });

/** A person's id in the source, as an owner is named (Slack: `U…` or `W…`). */
export const actorIdSchema = z.string().regex(/^[A-Z0-9]{2,40}$/, "must be a user id, like U0123");

/** An area's name: lowercase, the label decisions carry. */
export const areaNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  // No `/`: a name is one segment of the web app's addresses (`/areas/<name>`).
  .regex(/^[a-z0-9][a-z0-9 ._-]{0,59}$/, "letters, digits, spaces and . _ - only, at most 60");

/** A glob over the repository, like a CODEOWNERS line: relative, no `..`. */
export const areaPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "a path relative to the repository, without ..",
  })
  // Only `*`, `**` and `?` are read; braces, brackets and extglobs are refused, so no pattern can
  // make matching slow (from the review of slice 3.1).
  .refine((path) => /^[A-Za-z0-9._\-/*? ]+$/.test(path), {
    message: "letters, digits, . _ - / and the wildcards * ** ? only",
  });

/** A word or short phrase that marks an area in text. */
export const areaWordSchema = z.string().trim().toLowerCase().min(3).max(60);

/** One area, as the API returns it. */
export const areaSchema = z.strictObject({
  id: z.guid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Null: no owner, so the fallback decides for it. */
  owner: person.nullable(),
  paths: z.array(z.string()),
  words: z.array(z.string()),
  /** One more for each change; an edit names the version it was made on. */
  version: z.number().int().positive(),
  createdBy: person,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Area = z.infer<typeof areaSchema>;

/** Response of `GET /v1/areas`: every area, and who decides for anything unowned. */
export const areaListSchema = z.strictObject({
  areas: z.array(areaSchema),
  fallbackOwner: person.nullable(),
});
export type AreaList = z.infer<typeof areaListSchema>;

const areaFields = z.strictObject({
  name: z.string(),
  description: z.string().nullable(),
  owner: person.nullable(),
  paths: z.array(z.string()),
  words: z.array(z.string()),
});

/** One change to an area. */
export const areaEventSchema = z.strictObject({
  kind: z.enum(["created", "edited"]),
  actor: person,
  at: timestamp,
  before: areaFields.nullable(),
  after: areaFields,
});
export type AreaEvent = z.infer<typeof areaEventSchema>;

/** Response of `GET /v1/areas/:name`: an area and its history, oldest first. */
export const areaDetailSchema = z.strictObject({
  area: areaSchema,
  history: z.array(areaEventSchema),
});
export type AreaDetail = z.infer<typeof areaDetailSchema>;

/** Body of `POST /v1/areas` from a signed-in person. */
export const createAreaRequestSchema = z.strictObject({
  name: areaNameSchema,
  description: z.string().trim().max(300).nullable().optional(),
  /** The owner's id; left out or null for none. */
  ownerActorId: actorIdSchema.nullable().optional(),
  paths: z.array(areaPathSchema).max(50).optional(),
  words: z.array(areaWordSchema).max(30).optional(),
});
export type CreateAreaRequest = z.infer<typeof createAreaRequestSchema>;

/** Body of `PATCH /v1/areas/:id` from a signed-in person: what changes, on the version seen. */
export const editAreaRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  name: areaNameSchema.optional(),
  description: z.string().trim().max(300).nullable().optional(),
  ownerActorId: actorIdSchema.nullable().optional(),
  paths: z.array(areaPathSchema).max(50).optional(),
  words: z.array(areaWordSchema).max(30).optional(),
});
export type EditAreaRequest = z.infer<typeof editAreaRequestSchema>;

/**
 * What creating or editing an area did. `changed`: someone changed it since the version named;
 * nothing was done. `name_taken`: another area has that name.
 */
export const areaActionResultSchema = z.strictObject({
  status: z.enum(["created", "edited", "unchanged", "changed", "name_taken", "not_found"]),
  area: areaSchema.optional(),
});
export type AreaActionResult = z.infer<typeof areaActionResultSchema>;

/** Response of `GET /v1/people`: the people the record knows, for choosing an owner. */
export const peopleListSchema = z.strictObject({ people: z.array(person) });
export type PeopleList = z.infer<typeof peopleListSchema>;
