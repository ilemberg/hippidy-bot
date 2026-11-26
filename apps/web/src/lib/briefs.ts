import { randomUUID } from "node:crypto";
import type { BriefLine, MyBrief, SetBriefsResult } from "@hippidy/contracts";
import { fetchMyBrief, setMyBriefs, type ApiClientDeps, type ApiResult } from "./api-client.ts";
import { fromThisApp } from "./auth-flow.ts";
import type { WebConfig } from "./config.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { when } from "./decisions.ts";
import { signedInPerson, type HomeDeps } from "./home.ts";
import type { Person } from "./tokens.ts";

// The brief page (slice 3.4, decision 212): whether a person's daily briefs are on, the time zone
// they are sent in, when the last one went, what one would say now, and the button that stops or
// starts them. Over the standard Request and Response, so it is tested without Next.js; the page
// and the route file only pass the real dependencies in.

/** The brief page. */
export const BRIEF_PATH = "/brief";

/** Where the button that stops or starts briefs posts. */
export const SWITCH_BRIEFS_PATH = "/brief/switch";

/** What the switch did, as the page is told in its address. */
export const briefDone = ["stopped", "started"] as const;
export type BriefDone = (typeof briefDone)[number];

/** Why the switch did nothing, as the page is told in its address. */
export const briefErrors = ["invalid", "signed_out", "unavailable", "failed"] as const;
export type BriefError = (typeof briefErrors)[number];

export type BriefNotice = { kind: "done"; done: BriefDone } | { kind: "error"; error: BriefError };

/** The notice for `?done=` or `?error=`, if it is one this app sends. */
export function briefNotice(
  done: string | undefined,
  error: string | undefined,
): BriefNotice | undefined {
  const isDone = briefDone.find((value) => value === done);
  if (isDone !== undefined) return { kind: "done", done: isDone };
  const isError = briefErrors.find((value) => value === error);
  return isError === undefined ? undefined : { kind: "error", error: isError };
}

/** The sentence a notice from the switch shows. */
export function briefNoticeText(notice: BriefNotice): string {
  if (notice.kind === "done") {
    switch (notice.done) {
      case "stopped":
        return "Stopped: the bot will send you no more briefs until you start them again.";
      case "started":
        return "Started: the bot will send you a brief on weekday mornings when something is new.";
    }
  }
  switch (notice.error) {
    case "invalid":
      return "Nothing was changed: use the button on this page.";
    case "signed_out":
      return "Your sign-in has ended. Sign in again, then try again.";
    case "unavailable":
      return "Sign-in is not set up yet.";
    case "failed":
      return "The API did not answer. Reload the page to see whether it changed, then try again if not.";
  }
}

/** What the brief page shows. */
export type BriefView =
  | { kind: "unconfigured" }
  | { kind: "signed_out"; notice: BriefNotice | undefined }
  | {
      kind: "signed_in";
      person: Person;
      brief: ApiResult<MyBrief>;
      /** This app's address, to tell its own pages from Slack's among the brief's links. */
      webBaseUrl: string;
      notice: BriefNotice | undefined;
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

/** Reads the session cookie and, for a signed-in person, their brief as it would be now. */
export async function loadBrief(
  input: { sessionCookie: string | undefined; done: string | undefined; error: string | undefined },
  deps: HomeDeps,
): Promise<BriefView> {
  const config = deps.config;
  if (config === undefined) return { kind: "unconfigured" };
  const now = deps.now?.() ?? new Date();
  const notice = briefNotice(input.done, input.error);
  const person = await signedInPerson(input.sessionCookie, config, now);
  if (person === undefined) return { kind: "signed_out", notice };
  const brief = await fetchMyBrief(person, clientDeps(person, config, deps, now));
  return {
    kind: "signed_in",
    person,
    brief,
    webBaseUrl: config.webBaseUrl,
    notice,
    readAt: now.toISOString(),
  };
}

/** The switch's one field: `on` or `off`; anything else is not a switch. */
export function switchFromForm(form: FormData): boolean | undefined {
  const value = form.get("on");
  if (value === "on") return true;
  if (value === "off") return false;
  return undefined;
}

function outcomeOf(result: ApiResult<SetBriefsResult>, on: boolean): BriefNotice {
  if (result.kind === "failed" || result.value.on !== on) return { kind: "error", error: "failed" };
  return { kind: "done", done: on ? "started" : "stopped" };
}

/**
 * `POST /brief/switch`: a signed-in person stops or starts their own briefs. Only from this app's
 * own pages, and only for a signed-in person, as whom the API is called: whose briefs change is
 * never read from the form. Answers with the brief page.
 */
export async function handleBriefSwitch(request: Request, deps: HomeDeps): Promise<Response> {
  const log = deps.log.child({ correlationId: randomUUID() });
  if (!fromThisApp(request, deps.config)) {
    log.warn("brief.switch_refused", { reason: "cross_origin" });
    return new Response("Changes to briefs must come from this app.", { status: 403 });
  }
  const config = deps.config;
  const back = (notice: BriefNotice): Response => {
    const url = new URL(BRIEF_PATH, config?.webBaseUrl ?? request.url);
    if (notice.kind === "done") url.searchParams.set("done", notice.done);
    else url.searchParams.set("error", notice.error);
    return new Response(null, {
      status: 303,
      headers: { location: url.toString(), "cache-control": "no-store" },
    });
  };
  if (config === undefined) return back({ kind: "error", error: "unavailable" });
  const now = deps.now?.() ?? new Date();
  const person = await signedInPerson(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
    config,
    now,
  );
  if (person === undefined) {
    log.warn("brief.switch_refused", { reason: "signed_out" });
    return back({ kind: "error", error: "signed_out" });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back({ kind: "error", error: "invalid" });
  }
  const on = switchFromForm(form);
  if (on === undefined) return back({ kind: "error", error: "invalid" });
  const client = clientDeps(person, config, deps, now);
  const notice = outcomeOf(await setMyBriefs(person, on, client), on);
  client.log.info("brief.switched", {
    on,
    outcome: notice.kind === "done" ? notice.done : notice.error,
  });
  return back(notice);
}

// How the page words a brief, kept here so it is tested without Next.js.

/** The time zone briefs are sent in, or what is used until Slack gives one. */
export function timeZoneText(timeZone: string | null): string {
  return timeZone ?? "UTC until Slack tells us yours";
}

/** When the last brief went: "2 days ago", "on 2026-10-01", or none yet. */
export function lastSentText(lastSentAt: string | null, now: Date): string {
  return lastSentAt === null ? "None yet" : when(lastSentAt, now);
}

/**
 * Where a line of a brief leads. A page of this app stays in the tab, as a path; a thread in
 * Slack opens in a new one. Anything else is shown as text, not followed.
 */
export type BriefLink =
  { kind: "text" } | { kind: "app"; href: string } | { kind: "slack"; href: string };

const isSlackHost = (host: string) => host === "slack.com" || host.endsWith(".slack.com");

export function briefLink(line: BriefLine, webBaseUrl: string): BriefLink {
  const href = line.href;
  if (href === null || href === "") return { kind: "text" };
  let url: URL;
  try {
    url = new URL(href, webBaseUrl);
  } catch {
    return { kind: "text" };
  }
  if (url.origin === new URL(webBaseUrl).origin) {
    return { kind: "app", href: `${url.pathname}${url.search}${url.hash}` };
  }
  if (url.protocol === "https:" && isSlackHost(url.hostname)) {
    return { kind: "slack", href: url.toString() };
  }
  return { kind: "text" };
}

/** "and 4 more", or nothing when the section shows all it has. */
export function moreText(more: number): string | undefined {
  return more > 0 ? `and ${more} more` : undefined;
}
