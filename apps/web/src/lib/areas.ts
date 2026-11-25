import { randomUUID } from "node:crypto";
import {
  areaNameSchema,
  createAreaRequestSchema,
  editAreaRequestSchema,
  type Area,
  type AreaActionResult,
  type AreaDetail,
  type AreaEvent,
  type AreaList,
  type CreateAreaRequest,
  type EditAreaRequest,
  type PeopleList,
} from "@hippidy/contracts";
import {
  createArea,
  editArea,
  fetchArea,
  fetchAreas,
  fetchPeople,
  type ApiClientDeps,
  type ApiResult,
} from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { nameOf } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import type { Person } from "./tokens.ts";

// Areas and their owners (slice 3.1, decisions 205 and 206): every area, one area's page with
// its history, and the forms that create or change one. Over the standard Request and Response,
// so it is tested without Next.js; the pages and route files only pass the real dependencies in.

/** Someone the record knows, as the API names them. */
export type Known = PeopleList["people"][number];

/** Where the form that creates an area posts. Not under `/areas/`, where any name is an area. */
export const CREATE_AREA_PATH = "/new-area";

/** An area's page. Its name may hold spaces and slashes, so it is encoded as one segment. */
export function areaHref(name: string): string {
  return `/areas/${encodeURIComponent(name)}`;
}

/**
 * An area's name from its address: decoded if it still is (a name never holds `%`), trimmed and
 * lowercased like the API does. Nothing when it cannot be a name.
 */
export function areaNameFromPath(text: string): string | undefined {
  let decoded = text;
  if (text.includes("%")) {
    try {
      decoded = decodeURIComponent(text);
    } catch {
      return undefined;
    }
  }
  const parsed = areaNameSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/** What an action did, as the page is told in its address. */
export const areaDone = ["created", "edited"] as const;
export type AreaDone = (typeof areaDone)[number];

/** Why an action did nothing, as the page is told in its address. */
export const areaErrors = [
  "name_taken",
  "invalid",
  "unchanged",
  "changed",
  "not_found",
  "signed_out",
  "unavailable",
  "failed",
] as const;
export type AreaError = (typeof areaErrors)[number];

export type AreaNotice = { kind: "done"; done: AreaDone } | { kind: "error"; error: AreaError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function areaNotice(
  done: string | undefined,
  error: string | undefined,
): AreaNotice | undefined {
  const isDone = areaDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = areaErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** The sentence a notice from an action shows. */
export function areaNoticeText(notice: AreaNotice): string {
  if (notice.kind === "done") {
    switch (notice.done) {
      case "created":
        return "Created.";
      case "edited":
        return "Saved.";
    }
  }
  switch (notice.error) {
    case "name_taken":
      return "Not saved: another area already has that name.";
    case "invalid":
      return "Not saved: a name is at most 60 lowercase letters, digits, spaces and . _ -, starting with a letter or digit; a description at most 300 characters; at most 50 paths, relative to the repository, without .. and with only * ** ? as wildcards; at most 30 words, each 3 to 60 characters.";
    case "unchanged":
      return "Nothing was changed.";
    case "changed":
      return "Someone changed this area after you opened it, so nothing was saved. Read it again below, then try again.";
    case "not_found":
      return "There is no such area.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer in time. Reload the page to see whether it was saved, then try again if not.";
  }
}

/** What the areas page shows. */
export type AreasView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: AreaNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      list: ApiResult<AreaList>;
      /** Whom the form offers as owner. */
      people: ApiResult<Known[]>;
      notice: AreaNotice | undefined;
      readAt: string;
    };

/** What the page of one area shows. */
export type AreaView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: AreaNotice | undefined }
  | { kind: "not_found"; person: Person; name: string | undefined }
  | { kind: "failed"; person: Person; reason: string }
  | {
      kind: "ok";
      person: Person;
      detail: AreaDetail;
      people: ApiResult<Known[]>;
      /** Who decides while it has no owner, if the API names anyone. */
      fallbackOwner: Known | null;
      notice: AreaNotice | undefined;
      readAt: string;
    };

function clientDeps(person: Person, config: WebConfig, deps: HomeDeps, now: Date): ApiClientDeps {
  const correlationId = randomUUID();
  return {
    fetch: deps.fetch,
    apiBaseUrl: config.apiBaseUrl,
    apiSecret: config.apiSecret,
    log: deps.log.child({ correlationId, actorId: person.actorId }),
    correlationId,
    now: () => now,
  };
}

/** Reads the session cookie and, for a signed-in person, every area and the people known. */
export async function loadAreas(
  input: { sessionCookie: string | undefined; done: string | undefined; error: string | undefined },
  deps: HomeDeps,
): Promise<AreasView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = areaNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const client = clientDeps(person, config, deps, now);
  const [list, people] = await Promise.all([
    fetchAreas(person, client),
    fetchPeople(person, client),
  ]);
  return { kind: "signed_in", person, list, people, notice, readAt: now.toISOString() };
}

/** Reads the session cookie and, for a signed-in person, one area with its history. */
export async function loadArea(
  input: {
    sessionCookie: string | undefined;
    name: string;
    done: string | undefined;
    error: string | undefined;
  },
  deps: HomeDeps,
): Promise<AreaView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = areaNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const name = areaNameFromPath(input.name);
  if (name === undefined) return { kind: "not_found", person, name: undefined };
  const client = clientDeps(person, config, deps, now);
  const [lookup, people, list] = await Promise.all([
    fetchArea(person, name, client),
    fetchPeople(person, client),
    fetchAreas(person, client),
  ]);
  switch (lookup.kind) {
    case "not_found":
      return { kind: "not_found", person, name };
    case "failed":
      return { kind: "failed", person, reason: lookup.reason };
    case "ok":
      return {
        kind: "ok",
        person,
        detail: lookup.value,
        people,
        // Only for naming who decides while it has no owner; the page does without it.
        fallbackOwner: list.kind === "ok" ? list.value.fallbackOwner : null,
        notice,
        readAt: now.toISOString(),
      };
  }
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : undefined;
};

/** A textarea's lines: trimmed, empty ones dropped, each once, in the order given. */
export function linesOf(text: string | undefined): string[] {
  if (text === undefined) return [];
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];
}

/** Words as the API keeps them: lowercase, each once. */
const wordsOf = (text: string | undefined): string[] => linesOf(text?.toLowerCase());

/** The version the form was shown, which an edit sends. */
export function versionOf(form: FormData): number | undefined {
  const value = Number(field(form, "version"));
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** What the create form asks for, from its fields. */
export type FormCreate = { kind: "create"; area: CreateAreaRequest } | { kind: "invalid" };

/** The create body from the form's fields: an empty description or owner is none. */
export function createFromForm(form: FormData): FormCreate {
  const description = field(form, "description");
  const owner = field(form, "owner");
  const paths = linesOf(field(form, "paths"));
  const words = wordsOf(field(form, "words"));
  const parsed = createAreaRequestSchema.safeParse({
    name: field(form, "name") ?? "",
    ...(description === undefined || description === "" ? {} : { description }),
    ...(owner === undefined || owner === "" ? {} : { ownerActorId: owner }),
    ...(paths.length === 0 ? {} : { paths }),
    ...(words.length === 0 ? {} : { words }),
  });
  return parsed.success ? { kind: "create", area: parsed.data } : { kind: "invalid" };
}

/** What the edit form asks for, from its fields. */
export type FormAreaEdit =
  { kind: "edit"; edit: EditAreaRequest } | { kind: "unchanged" } | { kind: "invalid" };

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The edit body from the form's fields: only what differs from the area now, with the version
 * the form showed, so a change made meanwhile by someone else is not overwritten. An empty name
 * leaves it as it is; an empty description or owner clears it; a missing field is left out.
 */
export function areaEditFromForm(form: FormData, current: Area): FormAreaEdit {
  const version = versionOf(form);
  if (version === undefined) return { kind: "invalid" };
  const edit: EditAreaRequest = { version };
  const name = field(form, "name")?.toLowerCase();
  if (name !== undefined && name !== "" && name !== current.name) edit.name = name;
  const description = field(form, "description");
  const newDescription = description === "" ? null : description;
  if (newDescription !== undefined && newDescription !== current.description) {
    edit.description = newDescription;
  }
  const owner = field(form, "owner");
  const newOwner = owner === "" ? null : owner;
  if (newOwner !== undefined && newOwner !== (current.owner?.actorId ?? null)) {
    edit.ownerActorId = newOwner;
  }
  const paths = form.has("paths") ? linesOf(field(form, "paths")) : undefined;
  if (paths !== undefined && !sameList(paths, current.paths)) edit.paths = paths;
  const words = form.has("words") ? wordsOf(field(form, "words")) : undefined;
  if (words !== undefined && !sameList(words, current.words)) edit.words = words;
  if (Object.keys(edit).length === 1) return { kind: "unchanged" };
  const parsed = editAreaRequestSchema.safeParse(edit);
  return parsed.success ? { kind: "edit", edit: parsed.data } : { kind: "invalid" };
}

/** The forms the areas pages post to. */
export type AreaAction = "create" | "edit";

function outcomeOf(result: ApiResult<AreaActionResult>, action: AreaAction): AreaNotice {
  if (result.kind === "failed") return { kind: "error", error: "failed" };
  const status = result.value.status;
  switch (status) {
    case "created":
      return action === "create"
        ? { kind: "done", done: status }
        : { kind: "error", error: "failed" };
    case "edited":
      return action === "edit"
        ? { kind: "done", done: status }
        : { kind: "error", error: "failed" };
    case "unchanged":
    case "changed":
    case "name_taken":
    case "not_found":
      return { kind: "error", error: status };
  }
}

/**
 * `POST /new-area` or `POST /areas/<name>/edit`: a form creates an area or changes one. Only from
 * this app's own pages, and only for a signed-in person, as whom the API is called: who acts is
 * never read from the form. Answers with the area's page, or the list when there is none.
 */
export async function handleAreaAction(
  request: Request,
  action: AreaAction,
  nameText: string | undefined,
  deps: HomeDeps,
): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  const pathName = nameText === undefined ? undefined : areaNameFromPath(nameText);
  if (action === "edit" && pathName === undefined) {
    return new Response("Not found.", { status: 404 });
  }
  if (!fromThisApp(request, deps.config)) {
    log.warn("area.action_refused", { reason: "cross_origin", action, name: pathName });
    return new Response("Changes to areas must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const to = (path: string, notice: AreaNotice): Response => {
    const url = new URL(path, config?.webBaseUrl ?? request.url);
    if (notice.kind === "done") url.searchParams.set("done", notice.done);
    else url.searchParams.set("error", notice.error);
    return new Response(null, {
      status: 303,
      headers: { location: url.toString(), "cache-control": "no-store" },
    });
  };
  // Back where the form was: the area's page for an edit, the list for a new area.
  const back = (notice: AreaNotice): Response =>
    to(pathName === undefined ? "/areas" : areaHref(pathName), notice);
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("area.action_refused", { reason: "signed_out", action, name: pathName });
    return back({ kind: "error", error: "signed_out" });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const client = clientDeps(person, config, deps, now);

  let result: ApiResult<AreaActionResult>;
  if (action === "create") {
    const create = createFromForm(form);
    if (create.kind === "invalid") return back({ kind: "error", error: "invalid" });
    result = await createArea(person, create.area, client);
  } else {
    if (pathName === undefined || versionOf(form) === undefined) {
      return back({ kind: "error", error: "invalid" });
    }
    const lookup = await fetchArea(person, pathName, client);
    if (lookup.kind === "not_found") return back({ kind: "error", error: "not_found" });
    if (lookup.kind === "failed") return back({ kind: "error", error: "failed" });
    const edit = areaEditFromForm(form, lookup.value.area);
    if (edit.kind !== "edit") return back({ kind: "error", error: edit.kind });
    result = await editArea(person, lookup.value.area.id, edit.edit, client);
  }
  const notice = outcomeOf(result, action);
  client.log.info("area.action", {
    action,
    name: pathName,
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  const area = result.kind === "ok" ? result.value.area : undefined;
  return notice.kind === "done" && area !== undefined
    ? to(areaHref(area.name), notice)
    : back(notice);
}

// How the pages word an area, kept here so it is tested without Next.js.

/** Who owns an area, or who decides for it while it has none. */
export function ownerText(owner: Known | null, fallback: Known | null): string {
  if (owner !== null) return nameOf(owner);
  return fallback === null ? "no owner" : `no owner (decided by ${nameOf(fallback)})`;
}

/** A list in short: the first few, then how many more. */
export function inShort(values: readonly string[], shown = 3): string {
  if (values.length <= shown) return values.join(", ");
  return `${values.slice(0, shown).join(", ")} and ${values.length - shown} more`;
}

/**
 * The owners a form offers: no owner, the owner now, the person signed in, and the people the
 * record knows, each once.
 */
export function ownerOptions(
  people: ApiResult<Known[]>,
  current: Known | null,
  you: Person,
): { value: string; label: string }[] {
  const all: Known[] = [
    ...(current === null ? [] : [current]),
    { actorId: you.actorId, name: you.name },
    ...(people.kind === "ok" ? people.value : []),
  ];
  const seen = new Set<string>();
  const options = [{ value: "", label: "No owner" }];
  for (const p of all) {
    if (seen.has(p.actorId)) continue;
    seen.add(p.actorId);
    options.push({ value: p.actorId, label: nameOf(p) });
  }
  return options;
}

/** One line of an area's history, oldest first. */
export interface AreaHistoryItem {
  key: string;
  text: string;
  at: string;
  changes: { field: string; before: string; after: string }[];
}

type Fields = AreaEvent["after"];

const listText = (values: readonly string[]) =>
  values.length === 0 ? "(none)" : values.join(", ");

const fieldTexts: [string, (fields: Fields) => string][] = [
  ["Name", (f) => f.name],
  ["Description", (f) => f.description ?? "(none)"],
  ["Owner", (f) => (f.owner === null ? "no owner" : nameOf(f.owner))],
  ["Paths", (f) => listText(f.paths)],
  ["Words", (f) => listText(f.words)],
];

/** The history to show: who created it, then who changed what. */
export function areaHistoryItems(detail: AreaDetail): AreaHistoryItem[] {
  return detail.history.map((event, index) => {
    const before = event.before;
    return {
      key: `${index}:${event.kind}`,
      text: `${event.kind === "created" ? "Created" : "Edited"} by ${nameOf(event.actor)}`,
      at: event.at,
      changes:
        event.kind === "edited" && before !== null
          ? fieldTexts
              .map(([label, text]) => ({
                field: label,
                before: text(before),
                after: text(event.after),
              }))
              .filter((change) =>
                change.field === "Owner"
                  ? (before.owner?.actorId ?? null) !== (event.after.owner?.actorId ?? null)
                  : change.before !== change.after,
              )
          : [],
    };
  });
}
