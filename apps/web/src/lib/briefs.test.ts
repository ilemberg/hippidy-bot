import { describe, expect, it } from "vitest";
import {
  briefErrors,
  briefLink,
  briefNotice,
  briefNoticeText,
  handleBriefSwitch,
  lastSentText,
  loadBrief,
  moreText,
  switchFromForm,
  timeZoneText,
} from "./briefs.ts";
import { SESSION_COOKIE } from "./cookies.ts";
import type { HomeDeps } from "./home.ts";
import { memoryLogger } from "./log.ts";
import type { Fetch } from "./slack-oidc.ts";
import { config, myBrief } from "./testing.ts";
import { signSession, type Person } from "./tokens.ts";

const person: Person = { actorId: "U0123456789", workspaceId: "T0123456789", name: "Ilya" };
const now = new Date("2026-11-26T12:00:00.000Z");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fake API: `answer` gets each call; every call is recorded. */
function fakeApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

function deps(fetch: Fetch): HomeDeps & { lines: Record<string, unknown>[] } {
  const { log, lines } = memoryLogger();
  return { config, fetch, log, now: () => now, lines };
}

const noCalls: Fetch = () => Promise.reject(new Error("no call expected"));
const signedIn = () => signSession(person, config.sessionSecret, now);

describe("loadBrief", () => {
  it("reads the person's brief as them, with a notice this app sent", async () => {
    const api = fakeApi(() => Response.json(myBrief));
    expect(
      await loadBrief(
        { sessionCookie: await signedIn(), done: "stopped", error: undefined },
        deps(api.fetch),
      ),
    ).toEqual({
      kind: "signed_in",
      person,
      brief: { kind: "ok", value: myBrief },
      webBaseUrl: config.webBaseUrl,
      notice: { kind: "done", done: "stopped" },
      readAt: now.toISOString(),
    });
    expect(api.calls.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://api.example.test/v1/briefs/me"],
    ]);
  });

  it("says when the API did not answer, ignores notices it does not send", async () => {
    const down = fakeApi(() => new Response(null, { status: 503 }));
    expect(
      await loadBrief(
        { sessionCookie: await signedIn(), done: "hacked", error: "<b>" },
        deps(down.fetch),
      ),
    ).toMatchObject({ brief: { kind: "failed", reason: "status_503" }, notice: undefined });
  });

  it("asks a signed-out visitor to sign in, and calls nothing unconfigured", async () => {
    expect(
      await loadBrief(
        { sessionCookie: "forged", done: undefined, error: "signed_out" },
        deps(noCalls),
      ),
    ).toEqual({ kind: "signed_out", notice: { kind: "error", error: "signed_out" } });
    expect(
      await loadBrief(
        { sessionCookie: await signedIn(), done: undefined, error: undefined },
        { ...deps(noCalls), config: undefined },
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});

const post = (options: {
  cookie?: string;
  headers?: Record<string, string>;
  form?: Record<string, string>;
}) =>
  new Request(new URL("/brief/switch", config.webBaseUrl), {
    method: "POST",
    headers: {
      origin: config.webBaseUrl,
      ...(options.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
      ...options.headers,
    },
    body: new URLSearchParams(options.form ?? {}),
  });

const location = (res: Response) => res.headers.get("location");

describe("handleBriefSwitch", () => {
  const switchTo = async (form: Record<string, string>, fetch: Fetch) =>
    handleBriefSwitch(post({ cookie: await signedIn(), form }), deps(fetch));

  it("stops and starts the person's own briefs, never reading whose from the form", async () => {
    const api = fakeApi((call) => Response.json({ on: (call.body as { on: boolean }).on }));
    const stopped = await switchTo({ on: "off", actorId: "U999" }, api.fetch);
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("cache-control")).toBe("no-store");
    expect(location(stopped)).toBe(`${config.webBaseUrl}/brief?done=stopped`);
    const started = await switchTo({ on: "on" }, api.fetch);
    expect(location(started)).toBe(`${config.webBaseUrl}/brief?done=started`);
    expect(api.calls).toEqual([
      { url: "https://api.example.test/v1/briefs/me", method: "POST", body: { on: false } },
      { url: "https://api.example.test/v1/briefs/me", method: "POST", body: { on: true } },
    ]);
  });

  it("calls nothing for a form that is not a switch", async () => {
    for (const form of [{}, { on: "" }, { on: "true" }, { on: "OFF" }]) {
      const res = await switchTo(form, noCalls);
      expect(location(res)).toBe(`${config.webBaseUrl}/brief?error=invalid`);
    }
  });

  it("goes back with failed when the API refuses, does not answer, or did otherwise", async () => {
    for (const answer of [
      () => new Response(null, { status: 500 }),
      () => Response.json({ on: true }),
      () => Response.json({ status: "ok" }),
    ]) {
      const api = fakeApi(answer);
      const res = await switchTo({ on: "off" }, api.fetch);
      expect(location(res)).toBe(`${config.webBaseUrl}/brief?error=failed`);
    }
  });

  it("refuses another site, and sends a signed-out or unconfigured visitor back", async () => {
    const d = deps(noCalls);
    const refused = await handleBriefSwitch(
      post({
        cookie: await signedIn(),
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        form: { on: "off" },
      }),
      d,
    );
    expect(refused.status).toBe(403);
    expect(d.lines).toContainEqual(
      expect.objectContaining({ msg: "brief.switch_refused", reason: "cross_origin" }),
    );
    const signedOut = await handleBriefSwitch(
      post({ cookie: "forged", form: { on: "off" } }),
      deps(noCalls),
    );
    expect(location(signedOut)).toBe(`${config.webBaseUrl}/brief?error=signed_out`);
    const unconfigured = await handleBriefSwitch(
      post({ headers: { "sec-fetch-site": "same-origin" }, form: { on: "off" } }),
      { ...deps(noCalls), config: undefined },
    );
    expect(location(unconfigured)).toBe(`${config.webBaseUrl}/brief?error=unavailable`);
  });

  it("logs what it did, without the form", async () => {
    const api = fakeApi(() => Response.json({ on: false }));
    const d = deps(api.fetch);
    await handleBriefSwitch(post({ cookie: await signedIn(), form: { on: "off" } }), d);
    expect(d.lines).toContainEqual(
      expect.objectContaining({
        msg: "brief.switched",
        on: false,
        outcome: "stopped",
        actorId: person.actorId,
      }),
    );
  });
});

describe("the switch's field", () => {
  it("reads on or off, and nothing else", () => {
    const form = (value?: string) => {
      const f = new FormData();
      if (value !== undefined) f.set("on", value);
      return f;
    };
    expect(switchFromForm(form("on"))).toBe(true);
    expect(switchFromForm(form("off"))).toBe(false);
    expect(switchFromForm(form("yes"))).toBeUndefined();
    expect(switchFromForm(form())).toBeUndefined();
  });
});

describe("how a brief is worded", () => {
  it("names the time zone, or says UTC until Slack gives one", () => {
    expect(timeZoneText("Europe/London")).toBe("Europe/London");
    expect(timeZoneText(null)).toBe("UTC until Slack tells us yours");
  });

  it("says when the last one went, or that none has", () => {
    expect(lastSentText("2026-11-24T09:05:00.000Z", now)).toBe("2 days ago");
    expect(lastSentText("2026-09-01T09:05:00.000Z", now)).toBe("on 2026-09-01");
    expect(lastSentText(null, now)).toBe("None yet");
  });

  it("says how many more, only when there are", () => {
    expect(moreText(4)).toBe("and 4 more");
    expect(moreText(1)).toBe("and 1 more");
    expect(moreText(0)).toBeUndefined();
  });

  it("keeps this app's pages in the tab and opens Slack's threads in a new one", () => {
    const link = (href: string | null) => briefLink({ text: "a line", href }, config.webBaseUrl);
    expect(link(`${config.webBaseUrl}/decisions/7?x=1#h`)).toEqual({
      kind: "app",
      href: "/decisions/7?x=1#h",
    });
    expect(link("/waits")).toEqual({ kind: "app", href: "/waits" });
    expect(link("https://slack.com/archives/C1/p1700000100")).toEqual({
      kind: "slack",
      href: "https://slack.com/archives/C1/p1700000100",
    });
    expect(link("https://acme.slack.com/archives/C1/p1700000100?thread_ts=1700.000100")).toEqual({
      kind: "slack",
      href: "https://acme.slack.com/archives/C1/p1700000100?thread_ts=1700.000100",
    });
  });

  it("shows anything else as text, not a link", () => {
    const link = (href: string | null) => briefLink({ text: "a line", href }, config.webBaseUrl);
    for (const href of [
      null,
      "",
      "javascript:alert(1)",
      "//evil.example/decisions/7",
      "https://evil.example/decisions/7",
      "http://slack.com/archives/C1",
      "https://slack.com.evil.example/archives/C1",
      "https://notslack.com/archives/C1",
    ]) {
      expect(link(href)).toEqual({ kind: "text" });
    }
  });

  it("reads only the notices this app sends, and words each", () => {
    expect(briefNotice("started", undefined)).toEqual({ kind: "done", done: "started" });
    expect(briefNotice(undefined, "failed")).toEqual({ kind: "error", error: "failed" });
    expect(briefNotice("hacked", "<b>")).toBeUndefined();
    for (const error of briefErrors) {
      expect(briefNoticeText({ kind: "error", error })).not.toBe("");
    }
    expect(briefNoticeText({ kind: "done", done: "stopped" })).toMatch(/^Stopped/);
  });
});
